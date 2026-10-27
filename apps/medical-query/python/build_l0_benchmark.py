"""构建独立的 L0 百表合成评测包，保留原知识与运行中数据源。"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3

from build_l0_fixtures import APP_ROOT, FIXTURES
from l0_benchmark_core import populate_core
from l0_benchmark_support import create_and_populate
from l0_benchmark_questions import build_questions, validate_gold


KNOWLEDGE_FILES = ("manifest.json", "metrics.json", "logical_requirements.json", "mock_semantics.json", "binding_gaps.json", "mock_schema.sql")
DATABASE_NAME = "l0-benchmark.sqlite"


def digest(path: Path) -> str:
    """哈希固定输入和产物，便于复现时发现口径或数据变化。"""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


def quoted(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def inspect_tables(connection: sqlite3.Connection, semantics: dict, support: dict) -> list[dict]:
    """以实际 SQLite 结构导出粒度、复合键与非空覆盖，不用指标数量冒充数据覆盖。"""
    catalog = []
    for name, sql in connection.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall():
        metadata = support.get(name, semantics["tables"].get(name, {}))
        if not metadata.get("description"):
            raise ValueError(f"表缺少业务说明：{name}")
        columns = []
        for _, column, sql_type, not_null, default, primary_order in connection.execute(f"PRAGMA table_info({quoted(name)})"):
            description = metadata.get("columns", {}).get(column)
            if not description:
                raise ValueError(f"字段缺少业务说明：{name}.{column}")
            non_null = connection.execute(f"SELECT COUNT({quoted(column)}) FROM {quoted(name)}").fetchone()[0]
            columns.append({"name": column, "description": description, "sqlite_type": sql_type,
                            "not_null": bool(not_null), "default": default, "primary_key_order": primary_order, "non_null_rows": non_null})
        foreign_keys: dict[int, dict] = {}
        for key_id, order, parent, source, target, on_update, on_delete, _ in connection.execute(f"PRAGMA foreign_key_list({quoted(name)})"):
            key = foreign_keys.setdefault(key_id, {"target_table": parent, "columns": [], "on_update": on_update, "on_delete": on_delete})
            key["columns"].append({"order": order, "from": source, "to": target})
        count = connection.execute(f"SELECT COUNT(*) FROM {quoted(name)}").fetchone()[0]
        if not count:
            raise ValueError(f"表没有合成记录：{name}")
        catalog.append({"table": name, "description": metadata["description"], "grain": metadata.get("grain", metadata["description"]),
                        "domain": metadata.get("domain", "L0 原始事实"), "row_count": count, "columns": columns,
                        "foreign_keys": list(foreign_keys.values()), "ddl": sql})
    return catalog


def coverage_report(semantics: dict, catalog: list[dict], questions: list[dict], gold: list[dict]) -> list[dict]:
    """逐指标记录字段覆盖及剩余缺口；有数据不等于正式公式与医院绑定已就绪。"""
    tables = {table["table"]: table for table in catalog}
    by_metric: dict[str, list[str]] = {}
    for case in gold:
        for metric_id in case.get("related_metric_ids", []):
            by_metric.setdefault(metric_id, []).append(case["id"])
    coverage = []
    for binding in semantics["metric_bindings"]:
        fields = []
        for field in binding["required_field_bindings"]:
            table_name, column_name = field["physical_field"].split(".")
            table = tables[table_name]
            column = next((c for c in table["columns"] if c["name"] == column_name), None)
            if column is None:
                raise ValueError(f"指标字段不存在：{field['physical_field']}")
            fields.append({**field, "non_null_rows": column["non_null_rows"], "total_rows": table["row_count"]})
        coverage.append({"metric_id": binding["metric_id"], "required_fields": fields,
                         "required_tables": sorted({f["physical_field"].split(".")[0] for f in fields}),
                         "all_required_fields_present": True, "all_required_fields_have_values": all(f["non_null_rows"] for f in fields),
                         "question_ids": by_metric.get(binding["metric_id"], []), "formal_calculation_ready": False,
                         "execution_status": binding["execution_status"], "remaining_missing": binding["remaining_missing"],
                         "note": "仅结构与合成事实覆盖；空值、缺失目录和外部评审不以猜测填满。"})
    if len(coverage) != 47 or len({q["id"] for q in questions}) != len(questions):
        raise ValueError("指标覆盖或题目唯一性不符合契约")
    return coverage


def build(output_dir: Path, seed: int = 20261016, patients_per_institution: int = 200) -> dict:
    """排他创建完整数据包；失败删除本次新建目录，已有目录绝不覆盖或追加。"""
    if not 8 <= patients_per_institution <= 10000:
        raise ValueError("patients_per_institution 必须为 8～10000")
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=False)
    connection = None
    try:
        original_hashes = {name: digest(FIXTURES / name) for name in KNOWLEDGE_FILES}
        knowledge = output_dir / "knowledge"
        evaluation = output_dir / "evaluation"
        knowledge.mkdir()
        evaluation.mkdir()
        for name in KNOWLEDGE_FILES:
            shutil.copyfile(FIXTURES / name, knowledge / name)
        semantics = json.loads((knowledge / "mock_semantics.json").read_text(encoding="utf-8"))
        connection = sqlite3.connect(output_dir / DATABASE_NAME)
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript((knowledge / "mock_schema.sql").read_text(encoding="utf-8"))
        population = populate_core(connection, seed, patients_per_institution)
        support = create_and_populate(connection, seed)
        connection.commit()
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)] or connection.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("数据库完整性或外键校验失败")
        catalog = inspect_tables(connection, semantics, support)
        if len(catalog) != 106 or len(support) != 80:
            raise ValueError("必须生成 26 张 L0 核心表和 80 张业务支撑表")
        # gold 计算期由 SQLite 强制只读；问题只有四个公共字段，答案另存评测目录。
        connection.execute("PRAGMA query_only=ON")
        questions, gold = build_questions(connection, knowledge)
        validation = validate_gold(connection, questions, gold)
        coverage = coverage_report(semantics, catalog, questions, gold)
        observed_codes = {}
        for table in catalog:
            for column in table["columns"]:
                name = column["name"]
                # 版本、目录和抗菌药标志也属于实际代码值，不能只按 *_code 猜测枚举。
                if name.endswith(("_code", "_flag", "_version", "_unit")) or name in {"code", "code_system", "code_edition", "drug_code_system", "drug_code_edition", "catalog_id", "is_antibacterial"}:
                    values = [row[0] for row in connection.execute(f"SELECT DISTINCT {quoted(name)} FROM {quoted(table['table'])} WHERE {quoted(name)} IS NOT NULL ORDER BY {quoted(name)} LIMIT 101")]
                    if len(values) <= 100:
                        observed_codes[f"{table['table']}.{name}"] = values
        connection.close()
        connection = None
        conventions = {"version": "l0-benchmark-v1", "synthetic": True, "provenance": "synthetic_test_design", **population,
                       "table_count": len(catalog), "row_count": sum(t["row_count"] for t in catalog),
                       "timezone": "Asia/Shanghai；业务时间存本地无偏移文本，as_of 带 +08:00",
                       "clinical_time_rule": "批量患者两年各一次住院，门诊在入院前；死亡后无带药/患者随访；转科记录与午夜占床对齐，ICU事件为观察单元记录而非独立科室迁移。",
                       "control_changes": "仅新包修正原 S004 死亡后再次入院、S010 同一成人新生儿标记；占床按到病区时间重建；原文件不改。",
                       "scope": "数据底座与离线评测夹具；不代表真实医院分布、官方计算成绩或性能基准。",
                       "test_rules": "计算题逐题给出明确合成约定；机构键必参与关联，窗口左闭右开，缺失保持 NULL。",
                       "code_policy": "SYN_* 为自造目录/DDD/DRG/风险/能耗/财务标准；同码跨年值不同；不声称官方编码。",
                       "observed_code_values": observed_codes, "actual_hospital_bindings": None,
                       "known_limits": ["47 项正式指标仍保持原阻断和确认项", "外部评审成绩未提供；部分未执行事件的字段保持 NULL", "固定种子合成分布不用于临床或真实质量结论", "保留集作者可见，只是按业务族隔离，尚非独立外部盲测"]}
        write_json(output_dir / "mock-conventions.json", conventions)
        # 运行时只理解 global_rules.field_values；保持其原生契约，并排除评测统计和保留集说明。
        model_conventions = {"version": "l0-benchmark-v1", "provenance": "synthetic_test_design",
                             "description": "仅为本合成库的时间、代码和关联约定，不补官方口径或实际医院绑定。",
                             "global_rules": [
                                 {"id": "scope", "provenance": "synthetic_test_design", "description": "H001、H002、H999 为独立合成机构，局部业务编号可相同；过滤和关联必须包含 institution_id。"},
                                 {"id": "time", "provenance": "synthetic_test_design", "description": conventions["timezone"]},
                                 {"id": "values", "provenance": "synthetic_test_design", "description": "金额单位元，布尔标志整数0/1，等级代码保留字符；NULL不等于0。" + conventions["code_policy"]},
                                 {"id": "extra_code_values", "provenance": "synthetic_test_design", "description": "本合成库实际出现的有类型代码，不代表官方目录或医院映射。", "field_values": observed_codes}],
                             "metric_rules": [], "scenario_notes": [{"id": "references", "provenance": "synthetic_test_design", "description": "synthetic: 引用为自造标识，无外部认证；外部成绩和人工评审缺口保留。"}]}
        write_json(knowledge / "mock_conventions.json", model_conventions)
        # 模型可见字典只含业务语义；测试角色、期望答案、题集拆分均留在 evaluation。
        combined = {**semantics, "source_id": "l0_benchmark", "name": "L0 百表合成医院", "version": "l0-benchmark-v1",
                    "tables": {**semantics["tables"], **{name: {k: value for k, value in info.items() if k in ("description", "grain", "domain", "columns")} for name, info in support.items()}},
                    "benchmark_conventions": {k: conventions[k] for k in ("synthetic", "provenance", "timezone", "code_policy", "observed_code_values")}}
        write_json(output_dir / "semantic.json", combined)
        write_json(output_dir / "table-catalog.json", catalog)
        write_json(evaluation / "table-roles.json", {name: {k: value for k, value in info.items() if k in ("role", "related_metric_ids")} for name, info in support.items()})
        write_json(evaluation / "metric-coverage.json", coverage)
        write_json(evaluation / "validation.json", {"integrity_check": "ok", "foreign_key_violations": 0, "all_tables_nonempty": True, **validation})
        schema = ["-- L0 百表合成评测库；来自生成器，原始指标规范不被覆盖。", "PRAGMA foreign_keys=ON;"]
        for table in catalog:
            schema.extend(["", "-- " + table["description"].replace("\n", " ")])
            schema.extend("-- " + c["name"] + ": " + str(c["description"]).replace("\n", " ") for c in table["columns"])
            schema.append(table["ddl"] + ";")
        (output_dir / "schema.sql").write_text("\n".join(schema) + "\n", encoding="utf-8")
        for path, cases in ((output_dir / "questions.jsonl", questions), (evaluation / "gold.jsonl", gold)):
            path.write_text("".join(json.dumps(case, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n" for case in cases), encoding="utf-8")
        base_source = {"path": str(output_dir / DATABASE_NAME), "dictionary_path": str(output_dir / "semantic.json")}
        write_json(output_dir / "sources.fragment.json", [
            {**base_source, "id": "l0_benchmark", "name": "L0 百表指标匹配", "knowledge_path": str(knowledge)},
            {**base_source, "id": "l0_benchmark_facts", "name": "L0 百表合成事实"}])
        # 数据源片段含机器路径，故不纳入跨目录复现哈希；其余文件与脚本版本均冻结。
        generated_hashes = {str(path.relative_to(output_dir)): digest(path) for path in sorted(output_dir.rglob("*")) if path.is_file() and path.name != "sources.fragment.json"}
        manifest = {"version": "l0-benchmark-v1", "synthetic": True, "seed": seed, "patients_per_institution": patients_per_institution,
                    "table_count": len(catalog), "core_table_count": 26, "support_table_count": 80,
                    "row_count": conventions["row_count"], "question_count": len(questions),
                    "question_categories": dict(Counter(case["category"] for case in gold)),
                    "knowledge_sha256": original_hashes, "files_sha256": generated_hashes,
                    "generator_sha256": {path.name: digest(path) for path in [Path(__file__), Path(__file__).with_name("l0_benchmark_core.py"), Path(__file__).with_name("l0_benchmark_support.py"), Path(__file__).with_name("l0_benchmark_questions.py"), Path(__file__).with_name("build_l0_fixtures.py")]},
                    "registered_in_running_app": False, "model_evaluation_run": False,
                    "provenance": "以本地 L0 契约反向合成；借鉴既有 EHRSQL/medical100 的业务场景，不复制其患者记录或答案。"}
        if original_hashes != {name: digest(FIXTURES / name) for name in KNOWLEDGE_FILES}:
            raise RuntimeError("构建期间 L0 输入变化，请重新生成一致快照")
        write_json(output_dir / "manifest.json", manifest)
        return manifest
    except BaseException:
        if connection is not None:
            connection.close()
        shutil.rmtree(output_dir)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="生成 L0 百表合成库和问题/gold；不覆盖目录、不登记数据源、不调用模型")
    parser.add_argument("--output-dir", type=Path, default=APP_ROOT / ".local" / "l0-benchmark-v1")
    parser.add_argument("--seed", type=int, default=20261016)
    parser.add_argument("--patients-per-institution", type=int, default=200)
    args = parser.parse_args()
    try:
        manifest = build(args.output_dir, args.seed, args.patients_per_institution)
    except (OSError, sqlite3.Error, RuntimeError, ValueError) as error:
        parser.exit(1, f"L0 百表数据包生成失败：{error}\n")
    print(json.dumps({"output_dir": str(args.output_dir.resolve()), **{key: manifest[key] for key in ("table_count", "row_count", "question_count", "question_categories")}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
