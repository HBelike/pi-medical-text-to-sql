"""SQLite 领域边界：只接受受约束计划，目录和查询均不创建业务数据库。"""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import struct
import sys
import time
from pathlib import Path
from typing import Any


class DomainError(Exception):
    """用稳定错误码向应用层区分参数、计划、目录及执行故障。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def result_content_hash(columns: list[str], rows: list[list], complete: bool, truncated: bool) -> str:
    """跨 Python/JS 对结果逐格编码，浮点用 IEEE754，避免 1.0/1 的 JSON 序列化差异。"""
    digest = hashlib.sha256(b"medical-query-result/v1\n")

    def cell(value: Any) -> None:
        if value is None:
            digest.update(b"N;")
        elif isinstance(value, bool):
            digest.update(b"B1;" if value else b"B0;")
        elif isinstance(value, (int, float)):
            # JSON 往返会将负零规范为零，双方使用同一个数值身份。
            number = float(value) if value != 0 else 0.0
            digest.update(b"D" + struct.pack(">d", number).hex().encode("ascii") + b";")
        elif isinstance(value, str):
            encoded = value.encode("utf-8")
            digest.update(b"S" + str(len(encoded)).encode("ascii") + b":" + encoded + b";")
        else:
            fail("UNSUPPORTED_RESULT", "结果包含不支持的值类型")

    digest.update(f"C{len(columns)};".encode("ascii"))
    for column in columns:
        cell(column)
    digest.update(f"R{len(rows)};".encode("ascii"))
    for row in rows:
        digest.update(b"[")
        for value in row:
            cell(value)
        digest.update(b"]")
    digest.update(f"C{int(complete)}T{int(truncated)};".encode("ascii"))
    return digest.hexdigest()


def fail(code: str, message: str) -> None:
    raise DomainError(code, message)


def object_fields(value: Any, allowed: set[str], required: set[str], label: str) -> dict:
    """拒绝拼错或新增字段，防止未理解的条件被静默忽略。"""
    if not isinstance(value, dict):
        fail("INVALID_REQUEST", f"{label} 必须是对象")
    unknown = set(value) - allowed
    missing = required - set(value)
    if unknown or missing:
        fail("INVALID_REQUEST", f"{label} 字段错误：未知 {sorted(unknown)}，缺少 {sorted(missing)}")
    return value


def bounded_int(value: Any, minimum: int, maximum: int, label: str) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        fail("INVALID_REQUEST", f"{label} 必须为 {minimum}～{maximum} 的整数")
    return value


def quote(identifier: str) -> str:
    """标识符只来自已校验目录，仍进行双引号转义以保持真实名称。"""
    return '"' + identifier.replace('"', '""') + '"'


def read_dictionary(path: Path, dictionary_path: Any = None) -> dict:
    """业务释义来自服务端登记的配套文件；缺省文件不存在时保留纯结构能力。"""
    if dictionary_path is not None and not isinstance(dictionary_path, str):
        fail("INVALID_REQUEST", "dictionary_path 必须是路径字符串")
    target = Path(dictionary_path).expanduser() if dictionary_path else path.with_suffix(".semantic.json")
    if not target.exists() and dictionary_path is None:
        return {}
    try:
        result = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        fail("INVALID_DICTIONARY", f"无法读取业务字典：{exc}")
    if not isinstance(result, dict):
        fail("INVALID_DICTIONARY", "业务字典必须是对象")
    return result


def load_catalog(connection: sqlite3.Connection, semantics: dict) -> dict:
    """完整读取所有普通表/视图及复合外键列对，语义候选不替代物理事实。"""
    objects = connection.execute(
        "SELECT name, type FROM sqlite_master "
        "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    tables = []
    relations = []
    columns_by_table: dict[str, set[str]] = {}
    for name, kind in objects:
        columns = [
            {"name": row[1], "type": row[2], "nullable": not bool(row[3]), "primary_key": row[5]}
            for row in connection.execute(f"PRAGMA table_info({quote(name)})")
        ]
        columns_by_table[name] = {column["name"] for column in columns}
        foreign_keys: dict[int, dict] = {}
        for row in connection.execute(f"PRAGMA foreign_key_list({quote(name)})"):
            foreign_keys.setdefault(row[0], {"id": row[0], "table": row[2], "columns": []})
            foreign_keys[row[0]]["columns"].append({"from": row[3], "to": row[4], "sequence": row[1]})
        table_fks = list(foreign_keys.values())
        for fk in table_fks:
            fk["columns"].sort(key=lambda item: item["sequence"])
        tables.append({"name": name, "type": kind, "columns": columns, "foreign_keys": table_fks})
    by_name = {table["name"]: table for table in tables}
    for table in tables:
        for fk in table["foreign_keys"]:
            target = by_name.get(fk["table"])
            if target is None:
                continue
            primary = sorted(
                (column for column in target["columns"] if column["primary_key"]),
                key=lambda column: column["primary_key"],
            )
            pairs = []
            for item in fk["columns"]:
                target_column = item["to"]
                if target_column is None and len(primary) == len(fk["columns"]):
                    target_column = primary[item["sequence"]]["name"]
                if target_column not in columns_by_table[fk["table"]]:
                    break
                pairs.append({"left": item["from"], "right": target_column})
            if len(pairs) != len(fk["columns"]):
                continue
            relations.append({
                "id": f"fk:{table['name']}:{fk['id']}",
                "left_table": table["name"], "right_table": fk["table"],
                "pairs": pairs, "origin": "database_metadata", "status": "active",
            })
    known_ids = {relation["id"] for relation in relations}
    # 逻辑关系别名只能引用完整的数据库外键；列对顺序不影响身份，机构列不能被省略。
    physical_by_shape = {}
    for relation in relations:
        shape = (relation["left_table"], relation["right_table"], len(relation["pairs"]),
                 frozenset((pair["left"], pair["right"]) for pair in relation["pairs"]))
        physical_by_shape.setdefault(shape, relation["id"])
    supplied = semantics.get("relations", [])
    if not isinstance(supplied, list):
        fail("INVALID_DICTIONARY", "relations 必须是数组")
    for relation in supplied:
        if not isinstance(relation, dict):
            fail("INVALID_DICTIONARY", "关系必须是对象")
        if relation.get("status") != "active" or relation.get("origin") not in ("human_confirmed", "synthetic_sql_fk"):
            continue
        required = {"id", "left_table", "right_table", "pairs", "origin", "status"}
        if not required.issubset(relation):
            fail("INVALID_DICTIONARY", "已确认关系缺少必要字段")
        relation_id = relation["id"]
        if not isinstance(relation_id, str) or not relation_id or relation_id in known_ids:
            fail("INVALID_DICTIONARY", "关系 ID 为空或重复")
        left, right = relation["left_table"], relation["right_table"]
        if not isinstance(left, str) or not isinstance(right, str) or left not in by_name or right not in by_name:
            fail("INVALID_DICTIONARY", f"关系 {relation_id} 引用了不存在的表")
        pairs = relation["pairs"]
        if not isinstance(pairs, list) or not pairs:
            fail("INVALID_DICTIONARY", f"关系 {relation_id} 缺少列对")
        pair_keys = set()
        for pair in pairs:
            if not isinstance(pair, dict) or set(pair) != {"left", "right"}:
                fail("INVALID_DICTIONARY", f"关系 {relation_id} 的列对非法")
            if (not isinstance(pair["left"], str) or not isinstance(pair["right"], str)
                    or pair["left"] not in columns_by_table[left] or pair["right"] not in columns_by_table[right]):
                fail("INVALID_DICTIONARY", f"关系 {relation_id} 引用了不存在的列")
            pair_key = (pair["left"], pair["right"])
            if pair_key in pair_keys:
                fail("INVALID_DICTIONARY", f"关系 {relation_id} 包含重复列对")
            pair_keys.add(pair_key)
        executable = dict(relation)
        if relation["origin"] == "synthetic_sql_fk":
            # synthetic_sql_fk 只是来源声明，不能据此直接授权 JOIN；匹配失败必须显式暴露字典错误。
            physical_id = physical_by_shape.get((left, right, len(pairs), frozenset(pair_keys)))
            if physical_id is None:
                fail("INVALID_DICTIONARY", f"关系 {relation_id} 未完整匹配实际物理外键")
            executable.update(origin="database_metadata", declared_origin=relation["origin"], physical_relation_id=physical_id)
        relations.append(executable)
        known_ids.add(relation_id)
    # 指纹以完整物理目录和生效关系计算，便于应用记录本次执行依据。
    structure = {"tables": tables, "relations": relations}
    fingerprint = hashlib.sha256(json.dumps(structure, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return {**structure, "schema_fingerprint": fingerprint, "semantics": semantics}


def compile_dsl(dsl: Any, catalog: dict, max_rows: int) -> tuple[str, list, int | None]:
    """仅编译固定运算节点；每个输入条件要么完整编译，要么明确失败。"""
    object_fields(dsl, {"from", "select", "joins", "where", "group_by", "order_by", "limit"}, {"from", "select"}, "dsl")
    tables = {table["name"]: {column["name"]: column for column in table["columns"]} for table in catalog["tables"]}
    base = dsl["from"]
    if not isinstance(base, str) or base not in tables:
        fail("UNKNOWN_TABLE", f"未知主表：{base}")
    for key in ("select", "joins", "where", "group_by", "order_by"):
        if key in dsl and not isinstance(dsl[key], list):
            fail("INVALID_DSL", f"{key} 必须为数组")
    if not 1 <= len(dsl["select"]) <= 100:
        fail("INVALID_DSL", "select 必须包含 1～100 项")
    if len(dsl.get("where", [])) > 100 or len(dsl.get("joins", [])) > 20:
        fail("INVALID_DSL", "计划条件或关联数量超过本期预算")
    joined = {base}
    relation_by_id = {relation["id"]: relation for relation in catalog["relations"]}
    join_sql = []
    for item in dsl.get("joins", []):
        object_fields(item, {"relation", "type"}, {"relation", "type"}, "join")
        if item["type"] not in ("inner", "left"):
            fail("INVALID_JOIN", "JOIN 仅支持 inner/left")
        relation_id = item["relation"]
        if not isinstance(relation_id, str) or relation_id not in relation_by_id:
            fail("UNKNOWN_RELATION", f"未知或未确认关系：{relation_id}")
        relation = relation_by_id[relation_id]
        left, right = relation["left_table"], relation["right_table"]
        # 每次关联恰好引入一个新表，禁止默默丢弃不连通或重复角色关系。
        if (left in joined) == (right in joined):
            fail("INVALID_JOIN", f"关系 {relation_id} 必须连接当前范围和一个新表；重复表角色尚不支持")
        target = right if left in joined else left
        conditions = [f"{quote(left)}.{quote(pair['left'])} = {quote(right)}.{quote(pair['right'])}" for pair in relation["pairs"]]
        join_sql.append(f"{item['type'].upper()} JOIN {quote(target)} ON " + " AND ".join(conditions))
        joined.add(target)

    def field(reference: Any) -> str:
        if not isinstance(reference, str) or len(reference.split(".")) != 2:
            fail("UNKNOWN_FIELD", f"字段必须使用 table.column：{reference}")
        table, column = reference.split(".")
        if table not in joined or column not in tables[table]:
            fail("UNKNOWN_FIELD", f"字段不属于当前已关联目录：{reference}")
        return f"{quote(table)}.{quote(column)}"

    select_sql = []
    aliases: set[str] = set()
    plain_fields: list[str] = []
    has_aggregate = False
    for item in dsl["select"]:
        object_fields(item, {"field", "aggregate", "as"}, {"field"}, "select item")
        reference = item["field"]
        aggregate = item.get("aggregate")
        if aggregate is not None and aggregate not in ("count", "sum", "avg", "min", "max", "count_distinct"):
            fail("UNSUPPORTED_AGGREGATE", f"未知聚合：{aggregate}")
        expression = "*" if reference == "*" and aggregate == "count" else field(reference)
        if aggregate:
            has_aggregate = True
            expression = f"COUNT(DISTINCT {expression})" if aggregate == "count_distinct" else f"{aggregate.upper()}({expression})"
        else:
            plain_fields.append(reference)
        alias = item.get("as", f"{aggregate}_{reference.split('.')[-1]}" if aggregate else reference.split(".")[-1])
        if not isinstance(alias, str) or not alias or len(alias) > 100 or alias in aliases or "\x00" in alias:
            fail("INVALID_DSL", "输出别名为空、重复或非法，请显式设置不同 as")
        aliases.add(alias)
        select_sql.append(expression + " AS " + quote(alias))

    group_by = dsl.get("group_by", [])
    group_sql = [field(reference) for reference in group_by]
    if (has_aggregate or group_by) and not set(plain_fields).issubset(set(group_by)):
        fail("INVALID_GROUP", "所有非聚合输出必须明确出现在 group_by，不能依赖 SQLite 任意取值")

    parameters: list[Any] = []
    filters = []
    comparisons = {"eq": "=", "ne": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<=", "like": "LIKE"}

    def scalar(value: Any) -> Any:
        if value is not None and type(value) not in (str, int, float, bool):
            fail("INVALID_VALUE", "过滤值只允许 JSON 标量")
        if isinstance(value, float) and not math.isfinite(value):
            fail("INVALID_VALUE", "过滤值不能是 NaN/Infinity")
        if isinstance(value, int) and not -(2**63) <= value < 2**63:
            fail("INVALID_VALUE", "整数超过 SQLite 64 位范围")
        if isinstance(value, str) and len(value) > 10000:
            fail("INVALID_VALUE", "过滤字符串超过长度预算")
        return value

    for item in dsl.get("where", []):
        object_fields(item, {"field", "op", "value"}, {"field", "op"}, "where item")
        reference = field(item["field"])
        op = item["op"]
        if not isinstance(op, str):
            fail("UNSUPPORTED_OPERATOR", "过滤操作符必须是字符串")
        if op in ("is_null", "is_not_null"):
            if "value" in item:
                fail("INVALID_VALUE", "空值判断不接受 value")
            filters.append(reference + (" IS NULL" if op == "is_null" else " IS NOT NULL"))
        elif op in ("in", "not_in"):
            values = item.get("value")
            if not isinstance(values, list) or not 1 <= len(values) <= 200 or any(value is None for value in values):
                fail("INVALID_VALUE", "in/not_in 需要 1～200 个非空标量")
            parameters.extend(scalar(value) for value in values)
            filters.append(reference + (" IN (" if op == "in" else " NOT IN (") + ", ".join("?" for _ in values) + ")")
        elif op in comparisons:
            if "value" not in item or item["value"] is None:
                fail("INVALID_VALUE", "比较条件需要非空 value；空值请使用 is_null/is_not_null")
            value = scalar(item["value"])
            if op == "like" and not isinstance(value, str):
                fail("INVALID_VALUE", "like 需要字符串")
            parameters.append(value)
            filters.append(f"{reference} {comparisons[op]} ?")
        else:
            fail("UNSUPPORTED_OPERATOR", f"未支持操作符：{op}")

    order_sql = []
    for item in dsl.get("order_by", []):
        object_fields(item, {"field", "direction"}, {"field", "direction"}, "order_by item")
        reference, direction = item["field"], item["direction"]
        if direction not in ("asc", "desc"):
            fail("INVALID_ORDER", "排序方向必须是 asc/desc")
        expression = quote(reference) if isinstance(reference, str) and reference in aliases else field(reference)
        if (has_aggregate or group_by) and reference not in aliases and reference not in group_by:
            fail("INVALID_ORDER", "聚合查询只能按输出别名或分组字段排序")
        order_sql.append(expression + " " + direction.upper())

    user_limit = bounded_int(dsl["limit"], 1, 100000, "limit") if "limit" in dsl else None
    # max_rows 是完整结果执行预算，预览大小不参与 SQL，避免超过 200 行就误判不完整。
    fetch_limit = min(user_limit, max_rows + 1) if user_limit is not None else max_rows + 1
    sql = "SELECT " + ", ".join(select_sql) + " FROM " + quote(base)
    if join_sql:
        sql += " " + " ".join(join_sql)
    if filters:
        sql += " WHERE " + " AND ".join(filters)
    if group_sql:
        sql += " GROUP BY " + ", ".join(group_sql)
    if order_sql:
        sql += " ORDER BY " + ", ".join(order_sql)
    sql += " LIMIT ?"
    parameters.append(fetch_limit)
    return sql, parameters, user_limit


def handle(request: Any) -> dict:
    """单请求入口；文件与字典由应用固定传入，模型只提交受约束计划。"""
    try:
        object_fields(request, {"action", "path", "dictionary_path", "dsl", "max_rows", "max_result_bytes", "preview_rows", "timeout_ms"}, {"action", "path"}, "request")
        if request["action"] not in ("catalog", "execute"):
            fail("INVALID_ACTION", "action 仅支持 catalog/execute")
        if not isinstance(request["path"], str) or not request["path"]:
            fail("INVALID_REQUEST", "path 必须是非空路径")
        path = Path(request["path"]).expanduser().resolve()
        if not path.is_file():
            fail("SOURCE_NOT_FOUND", "SQLite 文件不存在，未创建空库")
        max_rows = bounded_int(request.get("max_rows", 5000), 1, 100000, "max_rows")
        max_result_bytes = bounded_int(request.get("max_result_bytes", 6_000_000), 1024, 6_000_000, "max_result_bytes")
        preview_limit = bounded_int(request.get("preview_rows", 200), 1, 200, "preview_rows")
        timeout_ms = bounded_int(request.get("timeout_ms", 5000), 1, 30000, "timeout_ms")
        semantics = read_dictionary(path, request.get("dictionary_path"))
        connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=timeout_ms / 1000)
        try:
            connection.execute("PRAGMA query_only = ON")
            deadline = time.monotonic() + timeout_ms / 1000
            connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            catalog = load_catalog(connection, semantics)
            if request["action"] == "catalog":
                return {"ok": True, "catalog": catalog}
            if "dsl" not in request:
                fail("INVALID_REQUEST", "execute 必须携带 dsl")
            sql, parameters, user_limit = compile_dsl(request["dsl"], catalog, max_rows)
            cursor = connection.execute(sql, parameters)
            columns = [column[0] for column in cursor.description]
            rows, preview = [], []
            result_bytes, preview_bytes = 2, 2
            truncation_reason = None
            # 流式读取至真实预算，多看一行判定截断；不额外 COUNT，也不将预览行数当总量。
            for fetched in cursor:
                if len(rows) >= max_rows:
                    truncation_reason = "row_budget"
                    break
                if time.monotonic() >= deadline:
                    fail("QUERY_TIMEOUT", "数据库查询超时")
                row = list(fetched)
                for value in row:
                    if isinstance(value, bytes) or isinstance(value, float) and not math.isfinite(value):
                        fail("UNSUPPORTED_RESULT", "结果包含不支持的二进制或非有限浮点值")
                    if isinstance(value, (int, float)) and value == int(value) and not -(2**53 - 1) <= value <= 2**53 - 1:
                        fail("UNSUPPORTED_RESULT", "结果整数超出 JSON/JavaScript 可无损表示范围")
                encoded_bytes = len(json.dumps(row, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))
                row_bytes = encoded_bytes + (1 if rows else 0)
                if result_bytes + row_bytes > max_result_bytes:
                    truncation_reason = "byte_budget"
                    break
                rows.append(row)
                result_bytes += row_bytes
                # 预览有独立字节上限，避免大单元格被复制后突破父进程传输预算。
                preview_row_bytes = encoded_bytes + (1 if preview else 0)
                if len(preview) < preview_limit and len(preview) == len(rows) - 1 and preview_bytes + preview_row_bytes <= 512_000:
                    preview.append(row)
                    preview_bytes += preview_row_bytes
            truncated = truncation_reason is not None
            return {
                "ok": True, "sql": sql, "parameters": parameters, "columns": columns,
                "rows": rows, "row_count": len(rows), "complete": not truncated,
                "truncated": truncated, "total": None if truncated else len(rows),
                "preview_rows": preview, "preview_row_count": len(preview),
                "preview_truncated": truncated or len(preview) < len(rows),
                "truncation_reason": truncation_reason, "result_bytes": result_bytes,
                "result_content_hash": result_content_hash(columns, rows, not truncated, truncated),
                "hash_algorithm": "medical-query-result/v1",
                "applied_limit": user_limit, "schema_fingerprint": catalog["schema_fingerprint"],
            }
        finally:
            connection.close()
    except DomainError as exc:
        return {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    except sqlite3.Error as exc:
        code = "QUERY_TIMEOUT" if "interrupted" in str(exc).lower() else "DATABASE_ERROR"
        return {"ok": False, "error": {"code": code, "message": str(exc)}}
    except (OSError, ValueError, TypeError, KeyError) as exc:
        return {"ok": False, "error": {"code": "INVALID_REQUEST", "message": str(exc)}}


def main() -> None:
    """标准输出只有一个 JSON；诊断作为结构化错误返回，不污染调用协议。"""
    try:
        raw = sys.stdin.read(2_000_001)
        if len(raw) > 2_000_000:
            fail("INVALID_REQUEST", "请求超过 2 MB")
        request = json.loads(raw)
        result = handle(request)
    except (ValueError, DomainError) as exc:
        result = {"ok": False, "error": {"code": getattr(exc, "code", "INVALID_JSON"), "message": str(exc)}}
    json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
