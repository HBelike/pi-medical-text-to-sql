"""生成与 L0 反向造数库配套的问题及隔离 gold；不调用产品规划器或模型。"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
import json
import math
from pathlib import Path
import sqlite3
from statistics import median


AS_OF = "2026-10-15T12:00:00+08:00"
PUBLIC_KEYS = {"id", "source_id", "question", "as_of"}
HOLDOUT_FAMILIES = {"drg_reference", "financial_growth", "median_episode", "management_assessment"}

# 同公式/近似业务族统一划分，编号问法、改写、基础量和边界不跨开发/保留集。
FAMILY_CODES = {
    "visits_ratio": "gk-01",
    "surgery_catalog_and_grain": "gk-03 gk-04 gk-05 gk-06 gk-08 gk-09 sh-ps-m0034 sh-ps-m0036 sh-ps-m0037 sh-ps-m0103",
    "staffing_beddays": "gk-25",
    "financial_classification": "gk-27 gk-28 gk-29 gk-30 gk-31 gk-32 gk-33 gk-35 gk-56 sh-ps-m0051",
    "energy_conversion": "gk-34",
    "drg_reference": "gk-14 sh-ps-m0060 sh-ps-m0061",
    "icu_risk": "qc-icu-11",
    "event_patient_days": "qc-nqi-07 qc-haiqi-03",
    "period_cohort": "qc-nqi-08",
    "medication_ddd": "gk-17",
    "episode_pairing": "sh-ps-m0085 sh-ps-m0093",
    "appointment_pairing": "gk-23",
    "bedday_scope": "sh-ps-m0003 sh-ps-m0035",
    "median_episode": "qc-em-03",
    "financial_growth": "gk-38 gk-40 gk-37",
    "balance_snapshot": "gk-36 sh-ps-m0043 sh-ps-m0044",
    "management_assessment": "gk-42 sh-ps-m0645 sh-ps-s012",
    "emr_level": "gk-24",
}
METRIC_FAMILIES = {f"met.{code}": family for family, codes in FAMILY_CODES.items() for code in codes.split()}


def _rows(connection: sqlite3.Connection, table: str) -> list[dict]:
    """只读整个原始事实表；Python oracle 自行筛选/关联，不复用参考 SQL 的结果。"""
    cursor = connection.execute(f'SELECT * FROM "{table}"')
    columns = [column[0] for column in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _decimal(value: object) -> Decimal:
    return Decimal(str(value))


def _number(value: Decimal | float | int, places: int = 6) -> float:
    return float(_decimal(value).quantize(Decimal(10) ** -places, rounding=ROUND_HALF_UP))


def _ratio(numerator: object, denominator: object, multiplier: int = 100) -> float | None:
    return None if not denominator else _number(_decimal(numerator) * multiplier / _decimal(denominator))


def _inside(value: str | None, start: str, end: str) -> bool:
    return value is not None and start <= value < end


def _minutes(start: str, end: str) -> float:
    return _number((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds() / 60)


def _group_count(records: list[dict], key: str, output: str | None = None) -> list[dict]:
    counts: dict[object, int] = defaultdict(int)
    for row in records:
        counts[row[key]] += 1
    return [{output or key: value, "count": count} for value, count in sorted(counts.items(), key=lambda item: str(item[0]))]


def _query_rows(connection: sqlite3.Connection, sql: str) -> list[dict]:
    """仅执行本模块保存的离线 SELECT 参考查询；答案不会回写业务数据库。"""
    if not sql.lstrip().upper().startswith(("SELECT ", "WITH ")):
        raise ValueError("参考 SQL 必须是只读 SELECT/WITH")
    cursor = connection.execute(sql)
    columns = [column[0] for column in cursor.description]
    if len(set(columns)) != len(columns):
        raise ValueError("参考结果不能包含重名列")
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def rows_equal(left: list[dict], right: list[dict], tolerance: float = 1e-6) -> bool:
    """按列角色比较保留重复的行多重集；不把 NULL、字符串、布尔值混成数值。"""
    if len(left) != len(right):
        return False

    def same_row(a: dict, b: dict) -> bool:
        if set(a) != set(b):
            return False
        for key in a:
            x, y = a[key], b[key]
            if type(x) in (int, float) and type(y) in (int, float):
                if not math.isfinite(x) or not math.isfinite(y) or abs(x - y) > tolerance:
                    return False
            elif type(x) is not type(y) or x != y:
                return False
        return True

    remaining = list(right)
    for row in left:
        for index, other in enumerate(remaining):
            if same_row(row, other):
                remaining.pop(index)
                break
        else:
            return False
    return True


def build_questions(connection: sqlite3.Connection, knowledge_dir: Path) -> tuple[list[dict], list[dict]]:
    """构建正式匹配/阻断题与独立测试计算题；函数不写文件、不修改数据库。"""
    metrics = json.loads((knowledge_dir / "metrics.json").read_text())["metrics"]
    gaps = json.loads((knowledge_dir / "binding_gaps.json").read_text())["items"]
    semantics = json.loads((knowledge_dir / "mock_semantics.json").read_text())
    bindings = {row["metric_id"]: row for row in semantics["metric_bindings"]}
    if {metric["metric_id"] for metric in metrics} != set(METRIC_FAMILIES):
        raise ValueError("47 项指标或 family 映射变更，需要显式复核题集")
    questions: list[dict] = []
    gold: list[dict] = []

    def publish(case_id: str, source_id: str, question: str, private: dict) -> None:
        questions.append({"id": case_id, "source_id": source_id, "question": question, "as_of": AS_OF})
        family = private["family_id"]
        gold.append({"id": case_id, "source_id": source_id, "family_id": family,
                     "split": "holdout" if family in HOLDOUT_FAMILIES else "dev",
                     "holdout_policy": "项目内未用于调参的保留族；不声称对题集作者不可见",
                     **private})

    for metric in metrics:
        metric_id = metric["metric_id"]
        binding = bindings[metric_id]
        relevant_gaps = [gap for gap in gaps if gap["metric_id"] == metric_id]
        physical_fields = sorted({item["physical_field"] for item in binding["required_field_bindings"]})
        base = {
            "family_id": METRIC_FAMILIES[metric_id], "related_metric_ids": [metric_id],
            "expected_action": "blocked", "required_metric_ids": [metric_id],
            "required_tables": sorted({field.split(".")[0] for field in physical_fields}),
            "required_fields": physical_fields,
            "required_logical_relations": metric.get("required_relation_ids", []),
            "candidate_relation_ids": binding.get("non_executable_relation_ids", []),
            "required_time_fields": [item["physical_field"] for item in binding.get("time_fields", [])],
            "expected_execution_statuses": [{"metric_id": metric_id, "status": binding["execution_status"]}],
            "required_gap_ids": [gap["issue_id"] for gap in relevant_gaps if gap["category"] != "engine_capability_gap"],
            "required_blockers": [{"gap_id": gap["issue_id"], "category": gap["category"], "description": gap["description"]}
                                  for gap in relevant_gaps if gap["category"] != "engine_capability_gap"],
            "unresolved_rule_notes": metric.get("unresolved_items", []),
            "source_refs": metric.get("source_refs", []),
            "forbidden_actions": ["execute_formal_metric", "invent_official_mapping", "publish_metric_value"],
            "gold_provenance": "直接复核原始知识定义、绑定和缺口；未使用产品输出或运行时投影函数",
        }
        code, name = metric["original_code"], metric["name"]
        publish(f"L0M-{code}-LINK", "l0_benchmark", f"请核对 {code}「{name}」需要哪些原始数据、关联和业务时间，目前材料是否足够按正式口径计算？",
                {**base, "category": "official_metric_linking"})
        publish(f"L0M-{code}-BOUNDARY", "l0_benchmark", f"请给出 H001 在2025年度的「{name}」正式指标结果，并说明采用的依据。",
                {**base, "category": "official_metric_boundary"})

    # 固定使用原知识的表名映射，不扫描支持表，也不从运行时产物推导 gold。
    tables = list(semantics["tables"])
    data = {table: _rows(connection, table) for table in tables}
    visits = data["outpatient_visits"]
    stays = data["inpatient_stays"]
    patients = {(r["institution_id"], r["patient_id"]): r for r in data["patients"]}
    departments = {(r["institution_id"], r["department_id"]): r for r in data["departments"]}
    institutions = {r["institution_id"]: r for r in data["institutions"]}
    stay_index = {(r["institution_id"], r["stay_id"]): r for r in stays}
    visit_index = {(r["institution_id"], r["visit_id"]): r for r in visits}
    september = lambda value: _inside(value, "2026-09-01", "2026-10-01")
    outpatient = [r for r in visits if r["institution_id"] == "H001" and september(r["registered_at"])
                  and r["care_setting_code"] == "OUTPATIENT" and r["visit_status_code"] == "COMPLETED"]
    discharges = [r for r in stays if r["institution_id"] == "H001" and september(r["discharged_at"]) and r["home_bed_flag"] == 0]
    discharge_keys = {(r["institution_id"], r["stay_id"]) for r in discharges}
    procedures = [r for r in data["inpatient_procedures"] if (r["institution_id"], r["stay_id"]) in discharge_keys]
    appointments = [r for r in data["appointment_events"] if r["institution_id"] == "H001"
                    and r["appointment_status_code"] == "SUCCESS"
                    and september(visit_index[(r["institution_id"], r["visit_id"])]["registered_at"])]
    complete_appointments = [r for r in appointments if r["checked_in_at"] is not None and r["called_at"] is not None]
    balances = [r for r in data["balance_snapshots"] if r["institution_id"] == "H001" and r["snapshot_date"] == "2026-09-30"]
    assets = sum((_decimal(r["balance_yuan"]) for r in balances if r["balance_class_code"] in {"CURRENT_ASSET", "NONCURRENT_ASSET"}), Decimal(0))
    liabilities = sum((_decimal(r["balance_yuan"]) for r in balances if r["balance_class_code"] in {"CURRENT_LIABILITY", "NONCURRENT_LIABILITY"}), Decimal(0))
    visit_where = "institution_id='H001' AND registered_at>='2026-09-01' AND registered_at<'2026-10-01' AND care_setting_code='OUTPATIENT' AND visit_status_code='COMPLETED'"
    unrestricted_visit_where = visit_where.removeprefix("institution_id='H001' AND ")
    stay_where = "s.institution_id='H001' AND s.discharged_at>='2026-09-01' AND s.discharged_at<'2026-10-01' AND s.home_bed_flag=0"
    procedure_from = "inpatient_procedures p JOIN inpatient_stays s ON p.institution_id=s.institution_id AND p.stay_id=s.stay_id"
    appointment_from = "appointment_events a JOIN outpatient_visits v ON a.institution_id=v.institution_id AND a.visit_id=v.visit_id"
    appointment_where = "a.institution_id='H001' AND a.appointment_status_code='SUCCESS' AND v.registered_at>='2026-09-01' AND v.registered_at<'2026-10-01'"
    balance_where = "institution_id='H001' AND snapshot_date='2026-09-30'"

    def fact(number: int, question: str, family: str, rows: list[dict], sql: str, tables_used: list[str], *,
             related: list[str] | None = None, category: str = "synthetic_fact_query", oracle: str,
             manual: list[dict] | None = None, mutations: list[dict] | None = None) -> None:
        case_id = f"L0F-{number:03d}"
        publish(case_id, "l0_benchmark_facts", "仅按本合成库和以下显式约定统计，不作为正式L0指标。" + question,
                {"family_id": family, "category": category, "test_rule_id": f"test.l0-benchmark.{number:03d}",
                 "related_metric_ids": related or [], "expected_action": "answer", "expected_rows": rows,
                 "reference_sql": sql, "required_tables": tables_used, "oracle_description": oracle,
                 "oracle_kind": "independent_python_raw_facts", "manual_expected_rows": manual,
                 "comparison": {"row_order": "unordered_multiset", "column_names": "exact", "numeric_tolerance": 1e-6,
                                "null_is_zero": False}, "negative_controls": mutations or [],
                 "rule_provenance": "synthetic_test_design", "official_metric_calculation": False})

    fact(1, "H001在2026年9月已完成的普通门诊挂号共有多少人次？排除急诊、体检和取消，区间为9月1日含至10月1日不含。", "visits_ratio",
         [{"visit_count": len(outpatient)}], f"SELECT COUNT(*) AS visit_count FROM outpatient_visits WHERE {visit_where}", ["outpatient_visits"],
         oracle="Python 按机构、就诊类型、完成状态和左闭右开日期筛选后逐行计数。", manual=[{"visit_count": 7}],
         mutations=[{"id": "drop_institution", "sql": f"SELECT COUNT(*) AS visit_count FROM outpatient_visits WHERE {unrestricted_visit_where}"},
                    {"id": "count_people_instead_of_visits", "sql": f"SELECT COUNT(DISTINCT patient_id) AS visit_count FROM outpatient_visits WHERE {visit_where}"}])
    fact(2, "H001在2026年9月已完成的普通门诊，按患者键去重后有多少位患者？排除急诊、体检和取消，区间为9月1日含至10月1日不含。", "visits_ratio",
         [{"patient_count": len({r["patient_id"] for r in outpatient})}], f"SELECT COUNT(DISTINCT patient_id) AS patient_count FROM outpatient_visits WHERE {visit_where}", ["outpatient_visits"],
         oracle="Python 对筛选后的 patient_id 建集合，与挂号行数分开。", manual=[{"patient_count": 5}])
    fact(3, "H001在2026年9月出院、home_bed_flag为数值0的住院共有多少人次？不按患者去重；含死亡和各种离院转归。", "visits_ratio",
         [{"stay_count": len(discharges)}], f"SELECT COUNT(*) AS stay_count FROM inpatient_stays s WHERE {stay_where}", ["inpatient_stays"],
         oracle="Python 以 discharged_at 归属月份，逐住院计数且只排 home_bed_flag!=0。", manual=[{"stay_count": 7}])
    fact(4, "H001在2026年9月出院且非家庭病床的住院，对应多少条操作记录？按操作条数计，不要求操作发生于9月，不验证正式手术目录。", "surgery_catalog_and_grain",
         [{"procedure_count": len(procedures)}], f"SELECT COUNT(*) AS procedure_count FROM {procedure_from} WHERE {stay_where}", ["inpatient_procedures", "inpatient_stays"],
         oracle="Python 先形成住院复合键集合，再逐条匹配操作记录。", manual=[{"procedure_count": 3}])
    surgical_stays = len({r["stay_id"] for r in procedures})
    fact(5, "H001在2026年9月出院且home_bed_flag为数值0的住院，有操作记录的住院有多少次？一次住院多条操作只算一次，不确认目录资格。", "surgery_catalog_and_grain",
         [{"operative_stay_count": surgical_stays}], f"SELECT COUNT(DISTINCT s.stay_id) AS operative_stay_count FROM {procedure_from} WHERE {stay_where}", ["inpatient_procedures", "inpatient_stays"],
         oracle="Python 匹配操作后按机构内 stay_id 去重。", manual=[{"operative_stay_count": 2}])
    fact(6, "按显式测试规则：H001在2026年9月出院且非家庭病床中，有任意操作记录的住院次数除以全部这类住院次数乘100；输出分子、分母和百分比，保留6位，零分母输出NULL。此规则不代表正式手术占比。", "surgery_catalog_and_grain",
         [{"numerator": surgical_stays, "denominator": len(discharges), "percent": _ratio(surgical_stays, len(discharges))}],
         f"WITH d AS (SELECT * FROM inpatient_stays s WHERE {stay_where}), n AS (SELECT COUNT(DISTINCT d.stay_id) AS value FROM d JOIN inpatient_procedures p ON p.institution_id=d.institution_id AND p.stay_id=d.stay_id) SELECT n.value AS numerator,(SELECT COUNT(*) FROM d) AS denominator,ROUND(n.value*100.0/NULLIF((SELECT COUNT(*) FROM d),0),6) AS percent FROM n",
         ["inpatient_stays", "inpatient_procedures"], category="synthetic_calculation", oracle="独立 Python 集合计数形成分子/分母，再用 Decimal 做比率。")
    fact(7, "H001在2026-09-30的CURRENT_ASSET和NONCURRENT_ASSET叶子科目余额合计多少元？不包含其他日期。", "balance_snapshot", [{"asset_yuan": float(assets)}],
         f"SELECT COALESCE(SUM(balance_yuan),0) AS asset_yuan FROM balance_snapshots WHERE {balance_where} AND balance_class_code IN ('CURRENT_ASSET','NONCURRENT_ASSET')", ["balance_snapshots"],
         oracle="Python 按明确合成分类与时点筛选，Decimal 逐叶子科目求和。", manual=[{"asset_yuan": 1000}],
         mutations=[{"id": "drop_snapshot_date", "sql": "SELECT SUM(balance_yuan) AS asset_yuan FROM balance_snapshots WHERE institution_id='H001' AND balance_class_code IN ('CURRENT_ASSET','NONCURRENT_ASSET')"}])
    fact(8, "H001在2026-09-30的CURRENT_LIABILITY和NONCURRENT_LIABILITY叶子科目余额合计多少元？", "balance_snapshot", [{"liability_yuan": float(liabilities)}],
         f"SELECT COALESCE(SUM(balance_yuan),0) AS liability_yuan FROM balance_snapshots WHERE {balance_where} AND balance_class_code IN ('CURRENT_LIABILITY','NONCURRENT_LIABILITY')", ["balance_snapshots"],
         oracle="Python 按明确合成负债分类求和，不补受托代理等正式范围。", manual=[{"liability_yuan": 300}])
    fact(9, "H001在2026-09-30，仅以CURRENT_LIABILITY与NONCURRENT_LIABILITY之和为分子，CURRENT_ASSET与NONCURRENT_ASSET之和为分母，乘100计算测试百分比；输出两分量与百分比，保留6位，零分母NULL。这不是正式GK36。", "balance_snapshot",
         [{"liability_yuan": float(liabilities), "asset_yuan": float(assets), "percent": _ratio(liabilities, assets)}],
         f"WITH x AS (SELECT COALESCE(SUM(CASE WHEN balance_class_code IN ('CURRENT_LIABILITY','NONCURRENT_LIABILITY') THEN balance_yuan ELSE 0 END),0) AS n,COALESCE(SUM(CASE WHEN balance_class_code IN ('CURRENT_ASSET','NONCURRENT_ASSET') THEN balance_yuan ELSE 0 END),0) AS d FROM balance_snapshots WHERE {balance_where}) SELECT n AS liability_yuan,d AS asset_yuan,ROUND(n*100.0/NULLIF(d,0),6) AS percent FROM x",
         ["balance_snapshots"], category="synthetic_calculation", oracle="Python 对互不混合的两组叶子余额独立求和，然后 Decimal 相除。",
         manual=[{"liability_yuan": 300, "asset_yuan": 1000, "percent": 30}])
    waits = [{"appointment_id": r["appointment_id"], "minutes": _minutes(r["checked_in_at"], r["called_at"])} for r in complete_appointments]
    wait_sql = f"SELECT a.appointment_id,ROUND((julianday(a.called_at)-julianday(a.checked_in_at))*1440,6) AS minutes FROM {appointment_from} WHERE {appointment_where} AND a.checked_in_at IS NOT NULL AND a.called_at IS NOT NULL"
    fact(10, "H001成功预约中，所属挂号在2026年9月且报到、叫诊均有记录的，每条预约的叫诊减报到是多少分钟？输出预约ID与分钟，保留零等待，不合并同挂号多预约。", "appointment_pairing", waits, wait_sql, ["appointment_events", "outpatient_visits"],
         oracle="Python 用复合键定位所属挂号，datetime 计算每条完整时间对，不确定正式GK23配对。")
    fact(11, "H001成功预约中，所属挂号在2026年9月、报到与叫诊两时刻完整的记录，按每条预约作样本求叫诊减报到的等待分钟平均值；输出样本数和均值，保留零等待和重复挂号的多条预约，保留6位，空样本均值NULL。不是正式GK23。", "appointment_pairing",
         [{"sample_count": len(waits), "mean_minutes": _number(sum(_decimal(r["minutes"]) for r in waits) / len(waits)) if waits else None}],
         f"SELECT COUNT(*) AS sample_count,ROUND(AVG(minutes),6) AS mean_minutes FROM ({wait_sql})", ["appointment_events", "outpatient_visits"], category="synthetic_calculation",
         oracle="Python 对每条完整预约的独立时长列表取算术平均，未使用 SQL AVG 生成答案。")
    fact(12, "H001成功预约中，所属挂号在2026年9月，但报到或叫诊至少一个缺失的预约记录有多少条？不把缺失当零等待。", "appointment_pairing",
         [{"incomplete_count": len(appointments) - len(complete_appointments)}], f"SELECT COUNT(*) AS incomplete_count FROM {appointment_from} WHERE {appointment_where} AND (a.checked_in_at IS NULL OR a.called_at IS NULL)", ["appointment_events", "outpatient_visits"],
         oracle="Python 按 None 显式检查完整性，零分钟仍属于完整样本。")
    cancelled = [r for r in visits if r["institution_id"] == "H001" and september(r["registered_at"]) and r["care_setting_code"] == "OUTPATIENT" and r["visit_status_code"] == "CANCELLED"]
    fact(13, "H001在2026年9月被取消的普通门诊挂号有多少条？", "visits_ratio", [{"cancelled_count": len(cancelled)}],
         "SELECT COUNT(*) AS cancelled_count FROM outpatient_visits WHERE institution_id='H001' AND registered_at>='2026-09-01' AND registered_at<'2026-10-01' AND care_setting_code='OUTPATIENT' AND visit_status_code='CANCELLED'", ["outpatient_visits"], oracle="Python 独立筛选取消状态。")
    empty = [{"visit_id": r["visit_id"]} for r in visits if r["institution_id"] == "H404"]
    fact(14, "列出机构H404的所有挂号ID；无匹配就如实返回空结果，不补造记录或改查H001。", "visits_ratio", empty,
         "SELECT visit_id FROM outpatient_visits WHERE institution_id='H404'", ["outpatient_visits"], oracle="Python 检查不存在机构的正常空行集。", manual=[])
    grouped = defaultdict(int)
    for row in discharges:
        key = (row["institution_id"], row["discharge_department_id"])
        if key in departments:
            grouped[(row["discharge_department_id"], departments[key]["department_name"])] += 1
    fact(15, "H001在2026年9月出院且非家庭病床的住院，按出院科室分组计人次，显示科室ID及名称；使用机构和科室复合关联。", "visits_ratio",
         [{"department_id": key[0], "department_name": key[1], "stay_count": count} for key, count in grouped.items()],
         f"SELECT d.department_id,d.department_name,COUNT(*) AS stay_count FROM inpatient_stays s JOIN departments d ON d.institution_id=s.institution_id AND d.department_id=s.discharge_department_id WHERE {stay_where} GROUP BY d.department_id,d.department_name",
         ["inpatient_stays", "departments"], oracle="Python 用出院科室角色构造复合键，逐条住院归组。")
    grouped = defaultdict(int)
    for row in procedures:
        stay = stay_index[(row["institution_id"], row["stay_id"])]
        patient = patients[(stay["institution_id"], stay["patient_id"])]
        grouped[(stay["patient_id"], patient["date_of_birth"])] += 1
    fact(16, "H001在2026年9月出院且非家庭病床的住院操作，按患者ID与出生日期分组统计操作条数；沿操作→住院→患者关联，每步保留机构键。", "surgery_catalog_and_grain",
         [{"patient_id": key[0], "date_of_birth": key[1], "procedure_count": count} for key, count in grouped.items()],
         f"SELECT t.patient_id,t.date_of_birth,COUNT(*) AS procedure_count FROM {procedure_from} JOIN patients t ON t.institution_id=s.institution_id AND t.patient_id=s.patient_id WHERE {stay_where} GROUP BY t.patient_id,t.date_of_birth", ["inpatient_procedures", "inpatient_stays", "patients"],
         oracle="Python 两次复合字典查找，保留操作粒度，再按患者分组；不使用SQL JOIN结果。",
         mutations=[{"id": "drop_patient_institution_key", "sql": f"SELECT t.patient_id,t.date_of_birth,COUNT(*) AS procedure_count FROM {procedure_from} JOIN patients t ON t.patient_id=s.patient_id WHERE {stay_where} GROUP BY t.patient_id,t.date_of_birth"}])
    procedure_index = {(r["institution_id"], r["stay_id"], r["procedure_id"]): r for r in data["inpatient_procedures"]}
    grouped = defaultdict(int)
    for row in data["clinical_events"]:
        if row["institution_id"] != "H001" or not september(row["occurred_at"]) or (row["institution_id"], row["stay_id"], row["procedure_id"]) not in procedure_index:
            continue
        stay = stay_index[(row["institution_id"], row["stay_id"])]
        patient = patients[(stay["institution_id"], stay["patient_id"])]
        grouped[(stay["patient_id"], patient["date_of_birth"])] += 1
    fact(17, "H001在2026年9月发生且能关联具体操作的临床事件，沿事件→操作→住院→患者三跳，按患者ID和出生日期统计事件条数；事件与操作须同时匹配机构、住院及操作键。", "surgery_catalog_and_grain",
         [{"patient_id": key[0], "date_of_birth": key[1], "event_count": count} for key, count in grouped.items()],
         "SELECT t.patient_id,t.date_of_birth,COUNT(*) AS event_count FROM clinical_events e JOIN inpatient_procedures p ON p.institution_id=e.institution_id AND p.stay_id=e.stay_id AND p.procedure_id=e.procedure_id JOIN inpatient_stays s ON s.institution_id=p.institution_id AND s.stay_id=p.stay_id JOIN patients t ON t.institution_id=s.institution_id AND t.patient_id=s.patient_id WHERE e.institution_id='H001' AND e.occurred_at>='2026-09-01' AND e.occurred_at<'2026-10-01' GROUP BY t.patient_id,t.date_of_birth",
         ["clinical_events", "inpatient_procedures", "inpatient_stays", "patients"], oracle="Python 三层原始复合键查找，按事件而非患者或操作计数。")
    seen = {r["patient_id"] for r in outpatient if (r["institution_id"], r["patient_id"]) in patients}
    fact(18, "H001在2026年9月已完成普通门诊涉及多少患者？显示机构名称；挂号经患者再关联机构，两步机构键都要正确。", "visits_ratio",
         [{"institution_name": institutions["H001"]["institution_name"], "patient_count": len(seen)}] if outpatient else [],
         f"SELECT i.institution_name,COUNT(DISTINCT p.patient_id) AS patient_count FROM outpatient_visits v JOIN patients p ON p.institution_id=v.institution_id AND p.patient_id=v.patient_id JOIN institutions i ON i.institution_id=p.institution_id WHERE v.{visit_where.replace(' AND ', ' AND v.')} GROUP BY i.institution_name",
         ["outpatient_visits", "patients", "institutions"], oracle="Python 根据复合患者键去重，再读取对应机构名称。")
    grouped = defaultdict(int)
    for row in appointments:
        visit = visit_index[(row["institution_id"], row["visit_id"])]
        key = (visit["institution_id"], visit["department_id"])
        if key in departments:
            grouped[(visit["department_id"], departments[key]["department_name"])] += 1
    fact(19, "H001成功预约且所属挂号在2026年9月，沿预约→挂号→挂号科室，按科室ID和名称统计预约记录条数；缺时间也计入，不按挂号去重。", "appointment_pairing",
         [{"department_id": key[0], "department_name": key[1], "appointment_count": count} for key, count in grouped.items()],
         f"SELECT d.department_id,d.department_name,COUNT(*) AS appointment_count FROM {appointment_from} JOIN departments d ON d.institution_id=v.institution_id AND d.department_id=v.department_id WHERE {appointment_where} GROUP BY d.department_id,d.department_name",
         ["appointment_events", "outpatient_visits", "departments"], oracle="Python 两次复合键查找，明确统计预约行而非时间完整子集。")
    grouped = defaultdict(int)
    for row in data["inpatient_diagnoses"]:
        key = (row["institution_id"], row["stay_id"])
        if key in discharge_keys:
            stay = stay_index[key]
            department_key = (row["institution_id"], stay["discharge_department_id"])
            if department_key in departments:
                grouped[stay["discharge_department_id"]] += 1
    fact(20, "H001在2026年9月出院且非家庭病床的住院诊断记录，沿诊断→住院→出院科室，按出院科室ID统计诊断条数，不去重为住院数。", "surgery_catalog_and_grain",
         [{"department_id": key, "diagnosis_count": count} for key, count in grouped.items()],
         f"SELECT d.department_id,COUNT(*) AS diagnosis_count FROM inpatient_diagnoses x JOIN inpatient_stays s ON s.institution_id=x.institution_id AND s.stay_id=x.stay_id JOIN departments d ON d.institution_id=s.institution_id AND d.department_id=s.discharge_department_id WHERE {stay_where} GROUP BY d.department_id",
         ["inpatient_diagnoses", "inpatient_stays", "departments"], oracle="Python 诊断行经过住院、出院科室两跳后分组。")
    census = [r for r in data["inpatient_census_days"] if r["institution_id"] == "H001" and september(r["census_date"])]
    capacity = [r for r in data["bed_capacity_days"] if r["institution_id"] == "H001" and september(r["capacity_date"])]
    capacity_sum = sum(r["open_beds_count"] for r in capacity)
    census_sql = "SELECT COUNT(*) AS recorded_bed_days FROM inpatient_census_days WHERE institution_id='H001' AND census_date>='2026-09-01' AND census_date<'2026-10-01'"
    capacity_sql = "SELECT COALESCE(SUM(open_beds_count),0) AS open_bed_days FROM bed_capacity_days WHERE institution_id='H001' AND capacity_date>='2026-09-01' AND capacity_date<'2026-10-01'"
    fact(21, "H001在2026年9月占床日原始表有多少条记录？所有床型与计数依据均包含，仅计本库记录，不声称正式完整床日。", "bedday_scope", [{"recorded_bed_days": len(census)}], census_sql,
         ["inpatient_census_days"], oracle="Python 读取重建后的实际占床日逐行计数，不沿用旧5/28常量。")
    fact(22, "H001在2026年9月每日开放床位记录的open_beds_count之和是多少？按每日每科室原始记录求和，不关联占床明细。", "bedday_scope", [{"open_bed_days": capacity_sum}], capacity_sql,
         ["bed_capacity_days"], oracle="Python 单独累加每日开放数，避免被住院明细JOIN放大。")
    fact(23, "测试规则：H001在2026年9月的全部占床日记录条数，除以同期open_beds_count之和乘100；输出两分量及百分比，保留6位，零分母NULL。仅是本库记录的测试比率，不称正式床位使用率。", "bedday_scope",
         [{"numerator": len(census), "denominator": capacity_sum, "percent": _ratio(len(census), capacity_sum)}],
         f"SELECT n.recorded_bed_days AS numerator,d.open_bed_days AS denominator,ROUND(n.recorded_bed_days*100.0/NULLIF(d.open_bed_days,0),6) AS percent FROM ({census_sql}) n CROSS JOIN ({capacity_sql}) d",
         ["inpatient_census_days", "bed_capacity_days"], category="synthetic_calculation", oracle="Python 分别计算两个不同粒度事实集，再用Decimal相除。")
    fact(24, "H001在2026年9月原始占床日按department_id分组各多少条？所有床型均包含。", "bedday_scope",
         _group_count(census, "department_id"), "SELECT department_id,COUNT(*) AS count FROM inpatient_census_days WHERE institution_id='H001' AND census_date>='2026-09-01' AND census_date<'2026-10-01' GROUP BY department_id",
         ["inpatient_census_days"], oracle="Python 对原始占床记录按当天科室分组，不使用出院科室。")
    financial = data["financial_entries"]
    revenue = [r for r in financial if r["institution_id"] == "H001" and r["account_kind_code"] == "REVENUE"
               and (_inside(r["accounting_date"], "2025-01-01", "2025-09-01") or _inside(r["accounting_date"], "2026-01-01", "2026-09-01"))]
    yearly: dict[str, Decimal] = defaultdict(Decimal)
    for row in revenue:
        yearly[row["accounting_date"][:4]] += _decimal(row["amount_yuan"])
    revenue_where = "institution_id='H001' AND account_kind_code='REVENUE' AND ((accounting_date>='2025-01-01' AND accounting_date<'2025-09-01') OR (accounting_date>='2026-01-01' AND accounting_date<'2026-09-01'))"
    fact(25, "H001在2025年1至8月、2026年1至8月，account_kind_code=REVENUE的全部原始分录分别合计多少元？负数冲回照常参与，不使用官方医疗收入分类。", "financial_growth",
         [{"year": year, "revenue_yuan": float(total)} for year, total in yearly.items()], f"SELECT substr(accounting_date,1,4) AS year,SUM(amount_yuan) AS revenue_yuan FROM financial_entries WHERE {revenue_where} GROUP BY substr(accounting_date,1,4)", ["financial_entries"], oracle="Python 以年度字典累加指定月份收入，保留冲回负值。")
    old, new = yearly.get("2025", Decimal(0)), yearly.get("2026", Decimal(0))
    fact(26, "H001在2025年1至8月与2026年1至8月的REVENUE分录分别求和，负数冲回参与，计算(2026金额-2025金额)/2025金额×100；输出两年金额及增幅，保留6位，上年为0则增幅NULL。这不是正式GK37。", "financial_growth",
         [{"previous_yuan": float(old), "current_yuan": float(new), "growth_percent": _ratio(new - old, old)}],
         f"WITH x AS (SELECT COALESCE(SUM(CASE WHEN substr(accounting_date,1,4)='2025' THEN amount_yuan ELSE 0 END),0) AS p,COALESCE(SUM(CASE WHEN substr(accounting_date,1,4)='2026' THEN amount_yuan ELSE 0 END),0) AS c FROM financial_entries WHERE {revenue_where}) SELECT p AS previous_yuan,c AS current_yuan,ROUND((c-p)*100.0/NULLIF(p,0),6) AS growth_percent FROM x",
         ["financial_entries"], category="synthetic_calculation", oracle="Python Decimal 各年独立求和，再计算差额和同比，零上年显式None。")
    classified: dict[object, Decimal] = defaultdict(Decimal)
    for row in revenue:
        if row["accounting_date"].startswith("2026"):
            classified[row["item_class_code"]] += _decimal(row["amount_yuan"])
    fact(27, "H001在2026年1至8月的REVENUE分录按item_class_code分类，各合计多少元？NULL类别单列，冲回保留。", "financial_classification",
         [{"item_class_code": key, "amount_yuan": float(total)} for key, total in classified.items()], "SELECT item_class_code,SUM(amount_yuan) AS amount_yuan FROM financial_entries WHERE institution_id='H001' AND account_kind_code='REVENUE' AND accounting_date>='2026-01-01' AND accounting_date<'2026-09-01' GROUP BY item_class_code", ["financial_entries"], oracle="Python 分类累计Decimal，None作为独立组。")
    grouped_money: dict[object, Decimal] = defaultdict(Decimal)
    for row in financial:
        if row["institution_id"] != "H001" or not _inside(row["accounting_date"], "2026-01-01", "2026-09-01") or row["stay_id"] is None:
            continue
        stay = stay_index[(row["institution_id"], row["stay_id"])]
        if (stay["institution_id"], stay["discharge_department_id"]) in departments:
            grouped_money[stay["discharge_department_id"]] += _decimal(row["amount_yuan"])
    fact(28, "H001在2026年1至8月、有住院键且能关联出院科室的全部财务分录，沿分录→住院→出院科室，按科室ID求amount_yuan和；不额外按收支方向筛选。", "financial_classification",
         [{"department_id": key, "amount_yuan": float(total)} for key, total in grouped_money.items()], "SELECT d.department_id,SUM(f.amount_yuan) AS amount_yuan FROM financial_entries f JOIN inpatient_stays s ON s.institution_id=f.institution_id AND s.stay_id=f.stay_id JOIN departments d ON d.institution_id=s.institution_id AND d.department_id=s.discharge_department_id WHERE f.institution_id='H001' AND f.accounting_date>='2026-01-01' AND f.accounting_date<'2026-09-01' GROUP BY d.department_id", ["financial_entries", "inpatient_stays", "departments"], oracle="Python 从分录复合键找到住院和出院科室，独立累加金额。")
    medicines = [r for r in data["medication_administrations"] if r["institution_id"] == "H001" and _inside(r["consumed_at"], "2026-01-01", "2026-09-01") and r["take_home_at_discharge_flag"] == 0]
    grams = sum((_decimal(r["quantity"]) / (1000 if r["quantity_unit"] == "mg" else 1) for r in medicines if r["quantity"] is not None and r["quantity_unit"] in {"g", "mg"}), Decimal(0))
    fact(29, "H001在2026年1至8月、出院带药标志为0的实际用药记录，只纳入quantity非空且quantity_unit精确为g或mg者；mg除1000转g后合计克数，保留6位，空集为0。不是DDDs。", "medication_ddd",
         [{"quantity_g": _number(grams)}], "SELECT ROUND(COALESCE(SUM(CASE WHEN quantity_unit='mg' THEN quantity/1000.0 ELSE quantity END),0),6) AS quantity_g FROM medication_administrations WHERE institution_id='H001' AND consumed_at>='2026-01-01' AND consumed_at<'2026-09-01' AND take_home_at_discharge_flag=0 AND quantity IS NOT NULL AND quantity_unit IN ('g','mg')", ["medication_administrations"], category="synthetic_calculation", oracle="Python Decimal 按明确单位转换，未知单位不推测。")
    standards = {(r["drug_code_system"], r["drug_code_edition"], r["drug_code"], r["ddd_version"]): r for r in data["drug_ddd_standards"]}
    ddd_total = Decimal(0)
    for row in medicines:
        standard = standards.get((row["drug_code_system"], row["drug_code_edition"], row["drug_code"], row["ddd_standard_version"]))
        if standard and standard["is_antibacterial"] == 1 and standard["ddd_quantity"] > 0 and row["quantity"] is not None and row["quantity_unit"] is not None and row["quantity_unit"] == standard["ddd_unit"]:
            ddd_total += _decimal(row["quantity"]) / _decimal(standard["ddd_quantity"])
    # 错版负对照故意固定到上一年；两年合成标准有异值，能暴露“SQL可执行但口径错误”。
    ddd_sql = "SELECT ROUND(COALESCE(SUM(m.quantity/d.ddd_quantity),0),6) AS synthetic_ddd FROM medication_administrations m JOIN drug_ddd_standards d ON d.drug_code_system=m.drug_code_system AND d.drug_code_edition=m.drug_code_edition AND d.drug_code=m.drug_code AND d.ddd_version=m.ddd_standard_version WHERE m.institution_id='H001' AND m.consumed_at>='2026-01-01' AND m.consumed_at<'2026-09-01' AND m.take_home_at_discharge_flag=0 AND d.is_antibacterial=1 AND d.ddd_quantity>0 AND m.quantity IS NOT NULL AND m.quantity_unit=d.ddd_unit"
    fact(30, "测试目录关联：H001在2026年1至8月、非出院带药记录，按代码体系、代码版次、药品代码、DDD版本四键匹配DDD表；只纳入抗菌标志1、DDD剂量>0、实际剂量非空且剂量单位与DDD单位精确相同者，累加quantity/ddd_quantity，保留6位，空集0。只验证该合成选版约定，不计算正式GK17。", "medication_ddd",
         [{"synthetic_ddd": _number(ddd_total)}], ddd_sql, ["medication_administrations", "drug_ddd_standards"], category="synthetic_calculation", oracle="Python 四元组精确匹配，Decimal 单项剂量除标准剂量后求和；不补官方选版。",
         mutations=[{"id": "wrong_ddd_version", "sql": ddd_sql.replace("d.ddd_version=m.ddd_standard_version", "d.ddd_version='SYN_DDD_2025'")}])
    energy = [r for r in data["energy_consumption"] if r["institution_id"] == "H001" and _inside(r["consumed_date"], "2026-01-01", "2026-09-01") and r["standard_coal_tons_per_unit"] is not None]
    coal = sum((_decimal(r["quantity"]) * _decimal(r["standard_coal_tons_per_unit"]) for r in energy), Decimal(0))
    fact(31, "H001在2026年1至8月能源记录，已有吨标煤/单位系数非空者逐行quantity乘系数后求和；输出吨标煤，保留6位，空集0。只使用记录自带合成系数，不宣称官方能耗指标。", "energy_conversion",
         [{"coal_tons": _number(coal)}], "SELECT ROUND(COALESCE(SUM(quantity*standard_coal_tons_per_unit),0),6) AS coal_tons FROM energy_consumption WHERE institution_id='H001' AND consumed_date>='2026-01-01' AND consumed_date<'2026-09-01' AND standard_coal_tons_per_unit IS NOT NULL", ["energy_consumption"], category="synthetic_calculation", oracle="Python Decimal 每条用量乘自带系数再累计。")
    roster = [r for r in data["clinician_year_roster"] if r["institution_id"] == "H001" and r["roster_year"] in {2025, 2026} and r["clinical_work_flag"] == 1]
    fact(32, "H001的2025与2026年度医师名册，clinical_work_flag=1的记录按年度各多少条？不额外判断执业资质或培训，不计算正式人力指标。", "staffing_beddays",
         _group_count(roster, "roster_year"), "SELECT roster_year,COUNT(*) AS count FROM clinician_year_roster WHERE institution_id='H001' AND roster_year IN (2025,2026) AND clinical_work_flag=1 GROUP BY roster_year", ["clinician_year_roster"], oracle="Python 按年份和明示工作标志计名册记录。")
    drg_reference = {(r["reference_year"], r["grouper_version"], r["drg_code"]): r for r in data["drg_group_reference"]}
    assignments = [r for r in data["drg_case_assignments"] if r["institution_id"] == "H001" and r["reference_year"] in {2025, 2026}]
    drg_counts: dict[tuple, int] = defaultdict(int)
    ref_los = []
    for row in assignments:
        key = (row["reference_year"], row["grouper_version"], row["drg_code"])
        if key in drg_reference:
            drg_counts[key] += 1
            if drg_reference[key]["reference_los_days"] is not None:
                ref_los.append(_decimal(drg_reference[key]["reference_los_days"]))
    drg_join = "drg_case_assignments a JOIN drg_group_reference r ON r.reference_year=a.reference_year AND r.grouper_version=a.grouper_version AND r.drg_code=a.drg_code"
    fact(33, "H001的2025/2026基准年度DRG分组记录，按基准年度、分组器版本和DRG代码三键匹配参考表后，分组统计病例数；不要只按病组代码连接。", "drg_reference",
         [{"reference_year": key[0], "grouper_version": key[1], "drg_code": key[2], "case_count": count} for key, count in drg_counts.items()],
         f"SELECT a.reference_year,a.grouper_version,a.drg_code,COUNT(*) AS case_count FROM {drg_join} WHERE a.institution_id='H001' AND a.reference_year IN (2025,2026) GROUP BY a.reference_year,a.grouper_version,a.drg_code",
         ["drg_case_assignments", "drg_group_reference"], oracle="Python 三元组匹配合成参照，按病例逐条计数。")
    fact(34, "H001的2025/2026基准年度分组记录三键匹配DRG参考表，每病例取一个非空reference_los_days后求平均；输出样本数和日数，空样本均值NULL，保留6位。仅是合成参照数值的病例加权平均，不是正式时间指数。", "drg_reference",
         [{"case_count": len(ref_los), "mean_reference_days": _number(sum(ref_los) / len(ref_los)) if ref_los else None}],
         f"SELECT COUNT(r.reference_los_days) AS case_count,ROUND(AVG(r.reference_los_days),6) AS mean_reference_days FROM {drg_join} WHERE a.institution_id='H001' AND a.reference_year IN (2025,2026)", ["drg_case_assignments", "drg_group_reference"], category="synthetic_calculation", oracle="Python 对每条病例对应的非空参照值建列表后求均值，不计算本院/全市比。")
    icu_counts: dict[object, int] = defaultdict(int)
    for row in data["icu_episodes"]:
        if row["institution_id"] == "H001" and _inside(row["icu_entered_at"], "2026-01-01", "2026-09-01"):
            stay = stay_index[(row["institution_id"], row["stay_id"])]
            if (stay["institution_id"], stay["patient_id"]) in patients:
                icu_counts[stay["patient_id"]] += 1
    fact(35, "H001在2026年1至8月进入ICU的片段，经住院关联到患者，按患者ID统计入ICU片段数；重复入科保留，不计算病死指数。", "icu_risk",
         [{"patient_id": key, "episode_count": count} for key, count in icu_counts.items()], "SELECT t.patient_id,COUNT(*) AS episode_count FROM icu_episodes i JOIN inpatient_stays s ON s.institution_id=i.institution_id AND s.stay_id=i.stay_id JOIN patients t ON t.institution_id=s.institution_id AND t.patient_id=s.patient_id WHERE i.institution_id='H001' AND i.icu_entered_at>='2026-01-01' AND i.icu_entered_at<'2026-09-01' GROUP BY t.patient_id", ["icu_episodes", "inpatient_stays", "patients"], oracle="Python 两跳复合键，按片段计数而非患者唯一数。")
    rescue = [r for r in data["emergency_rescue_episodes"] if r["institution_id"] == "H001" and _inside(r["entered_at"], "2026-01-01", "2026-09-01") and r["left_at"] is not None and r["departure_status_code"] == "ALIVE"]
    rescue_minutes = [_minutes(r["entered_at"], r["left_at"]) for r in rescue]
    fact(36, "显式测试规则：H001在2026年1至8月进入抢救室、离开时间非空且离开状态ALIVE的每个进出片段作为一个样本；时长以分钟计，奇数取中间值、偶数取中间两值均值。输出样本数和中位分钟，空样本NULL，保留6位，不声称正式QC-EM03。", "median_episode",
         [{"sample_count": len(rescue_minutes), "median_minutes": _number(median(rescue_minutes)) if rescue_minutes else None}],
         "WITH x AS (SELECT (julianday(left_at)-julianday(entered_at))*1440.0 AS minutes FROM emergency_rescue_episodes WHERE institution_id='H001' AND entered_at>='2026-01-01' AND entered_at<'2026-09-01' AND left_at IS NOT NULL AND departure_status_code='ALIVE'), r AS (SELECT minutes,ROW_NUMBER() OVER(ORDER BY minutes) AS rn,COUNT(*) OVER() AS n FROM x) SELECT (SELECT COUNT(*) FROM x) AS sample_count,ROUND(AVG(minutes),6) AS median_minutes FROM r WHERE rn IN ((n+1)/2,(n+2)/2)", ["emergency_rescue_episodes"], category="synthetic_calculation", oracle="Python datetime 形成片段时长，statistics.median实现奇偶中位数；正式样本定义仍未确认。")
    emr = [r for r in data["emr_assessment_items"] if r["institution_id"] == "H001" and r["assessment_year"] == 2026 and r["option_role_code"] == "SYN_BASIC"
           and r["implemented_flag"] == 1 and r["effective_coverage_percent"] is not None and r["effective_coverage_percent"] > 80
           and r["data_quality_index"] is not None and r["data_quality_index"] > 0.5]
    fact(37, "H001在2026年合成电子病历项目中，SYN_BASIC、已实现=1、覆盖率严格大于80且质量指数严格大于0.5的记录有多少？只数记录，不据此判定正式等级。", "emr_level",
         [{"qualified_item_count": len(emr)}], "SELECT COUNT(*) AS qualified_item_count FROM emr_assessment_items WHERE institution_id='H001' AND assessment_year=2026 AND option_role_code='SYN_BASIC' AND implemented_flag=1 AND effective_coverage_percent>80 AND data_quality_index>0.5", ["emr_assessment_items"], oracle="Python 显式排None并严格使用>，阈值等于不能通过。")
    evidence = [r for r in data["management_evidence"] if r["institution_id"] == "H001" and r["assessment_year"] == 2026 and r["document_reference"] is not None]
    fact(38, "H001的2026年度管理证据中document_reference非NULL的记录有多少？只数已有合成引用，不等同证据核验通过或评审得分。", "management_assessment",
         [{"reference_count": len(evidence)}], "SELECT COUNT(*) AS reference_count FROM management_evidence WHERE institution_id='H001' AND assessment_year=2026 AND document_reference IS NOT NULL", ["management_evidence"], oracle="Python 只检查引用存在，不从条数推导符合性。")
    period_visits = [r for r in visits if r["institution_id"] == "H001" and (_inside(r["registered_at"], "2025-08-01", "2025-09-01") or _inside(r["registered_at"], "2026-08-01", "2026-09-01"))]
    period_counts: dict[str, int] = defaultdict(int)
    for row in period_visits:
        period_counts[row["registered_at"][:7]] += 1
    fact(39, "H001在2025年8月和2026年8月各有多少条挂号记录？两个月均左闭右开，所有就诊类型及状态均包含，其他月份排除。", "visits_ratio",
         [{"month": key, "visit_count": count} for key, count in period_counts.items()], "SELECT substr(registered_at,1,7) AS month,COUNT(*) AS visit_count FROM outpatient_visits WHERE institution_id='H001' AND ((registered_at>='2025-08-01' AND registered_at<'2025-09-01') OR (registered_at>='2026-08-01' AND registered_at<'2026-09-01')) GROUP BY substr(registered_at,1,7)", ["outpatient_visits"], oracle="Python分别判断两个显式月份，防止只按年份或忽略月份。")
    fact(40, "H001患者主数据中出生日期为NULL的记录有多少？不要把缺失生日补成年龄0。", "visits_ratio",
         [{"missing_birth_date_count": sum(r["institution_id"] == "H001" and r["date_of_birth"] is None for r in data["patients"])}], "SELECT COUNT(*) AS missing_birth_date_count FROM patients WHERE institution_id='H001' AND date_of_birth IS NULL", ["patients"], oracle="Python 使用None检查缺失，不把缺失转成默认日期。")
    publish("L0B-NO-MATCH", "l0_benchmark", "请计算食堂菜品退菜率的正式指标，并指出L0目录中的对应项。",
            {"family_id": "unmatched_boundary", "category": "no_match", "expected_action": "blocked", "required_metric_ids": [],
             "expected_match_status": "no_match", "required_tables": [], "required_fields": [], "forbidden_actions": ["invent_metric", "execute_unrelated_query"]})
    publish("L0B-CLARIFY", "l0_benchmark_facts", "请统计那个科室上个周期的数量。",
            {"family_id": "ambiguous_boundary", "category": "clarification", "expected_action": "clarify",
             "required_clarifications": ["统计对象或指标", "科室", "统计区间"], "forbidden_actions": ["invent_scope", "publish_number"]})
    return questions, gold


def validate_gold(connection: sqlite3.Connection, questions: list[dict], gold: list[dict]) -> dict:
    """验证隔离、覆盖、手算锚点和独立参考；负对照必须被数值评分判错。"""
    if any(set(row) != PUBLIC_KEYS for row in questions):
        raise ValueError("产品问题存在缺失字段或泄露 gold 元数据")
    question_ids = [row["id"] for row in questions]
    gold_ids = [row["id"] for row in gold]
    if len(set(question_ids)) != len(question_ids) or set(question_ids) != set(gold_ids) or len(set(gold_ids)) != len(gold_ids):
        raise ValueError("问题和 gold 编号不唯一或不对应")
    question_index = {row["id"]: row for row in questions}
    families: dict[str, set] = defaultdict(set)
    official: dict[str, set] = defaultdict(set)
    numerical = multi_table = negative_controls = manual_anchors = formal_cases = 0
    for case in gold:
        question = question_index[case["id"]]
        if question["source_id"] != case["source_id"] or question["as_of"] != AS_OF:
            raise ValueError(f"来源/时间锚点不一致：{case['id']}")
        families[case["family_id"]].add(case["split"])
        expected_split = "holdout" if case["family_id"] in HOLDOUT_FAMILIES else "dev"
        if case["split"] != expected_split:
            raise ValueError(f"family 分组漂移：{case['id']}")
        if case["category"].startswith("official_metric_"):
            formal_cases += 1
            if case["expected_action"] != "blocked" or "expected_rows" in case or case["source_id"] != "l0_benchmark" or not case["required_blockers"]:
                raise ValueError(f"正式指标缺口被隐式解除：{case['id']}")
            for metric_id in case["required_metric_ids"]:
                official[metric_id].add(case["category"])
        if case["expected_action"] == "answer":
            numerical += 1
            multi_table += len(case["required_tables"]) > 1
            if not case.get("test_rule_id") or case.get("official_metric_calculation") is not False or case["source_id"] != "l0_benchmark_facts":
                raise ValueError(f"测试计算没有独立身份：{case['id']}")
            actual = _query_rows(connection, case["reference_sql"])
            if not rows_equal(actual, case["expected_rows"]):
                raise ValueError(f"独立 Python 与参考 SQL 不一致：{case['id']}")
            if case.get("manual_expected_rows") is not None:
                manual_anchors += 1
                if not rows_equal(case["expected_rows"], case["manual_expected_rows"]):
                    raise ValueError(f"手算控制样本改变：{case['id']}")
            for mutation in case["negative_controls"]:
                if rows_equal(_query_rows(connection, mutation["sql"]), case["expected_rows"]):
                    raise ValueError(f"负对照未被识别：{case['id']}/{mutation['id']}")
                negative_controls += 1
    if set(official) != set(METRIC_FAMILIES) or any(value != {"official_metric_linking", "official_metric_boundary"} for value in official.values()):
        raise ValueError("47 项正式匹配/边界覆盖不完整")
    if any(len(splits) != 1 for splits in families.values()) or numerical < 30 or multi_table < 6:
        raise ValueError("family 隔离或基础/多表题覆盖不足")
    if not any(case.get("expected_action") == "answer" and case.get("expected_rows") == [] for case in gold):
        raise ValueError("缺少正常空结果题")
    return {"question_count": len(questions), "official_metrics": len(official), "formal_cases": formal_cases,
            "fact_cases": numerical, "multi_table_fact_cases": multi_table, "negative_controls_killed": negative_controls,
            "manual_anchors_checked": manual_anchors, "family_count": len(families),
            "split_counts": {split: sum(case["split"] == split for case in gold) for split in ("dev", "holdout")},
            "sql_reference_matches_python": True, "gold_exposed_to_product": False}
