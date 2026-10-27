"""按既有 L0 DDL 创建原始合成事实；不计算指标，不改写数据源注册表。"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import tempfile
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = APP_ROOT / "fixtures" / "l0"
DATABASE_NAME = "l0-mock.sqlite"


def insert_rows(connection: sqlite3.Connection, table: str, columns: str, rows: list[tuple]) -> None:
    """表名和列名只来自本文件常量；事实值参数化，空值保持为 SQL NULL。"""
    placeholders = ",".join("?" for _ in columns.split(","))
    connection.executemany(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", rows)


def populate(connection: sqlite3.Connection) -> None:
    """所有行均为 synthetic_test_design；H999 只用于检验机构隔离。"""
    insert_rows(connection, "institutions", "institution_id,institution_name,hospital_class_code", [
        ("H001", "L0 合成医院", "GENERAL"), ("H999", "机构隔离对照（合成）", "GENERAL"),
    ])
    insert_rows(connection, "departments", "institution_id,department_id,department_name,department_type", [
        ("H001", "D_MED", "合成内科", "NON_SURGICAL"), ("H001", "D_SURG", "合成外科", "SURGICAL"),
        ("H001", "D_ED", "合成急诊科", "EMERGENCY"), ("H999", "D_MED", "对照内科", "NON_SURGICAL"),
    ])
    insert_rows(connection, "patients", "institution_id,patient_id,date_of_birth,sex_code", [
        ("H001", "P001", "1960-01-01", None), ("H001", "P002", "1975-02-01", None),
        ("H001", "P003", "1980-03-01", None), ("H001", "P004", "1990-04-01", None),
        ("H001", "P005", None, None), ("H999", "P001", "2000-01-01", None),
    ])
    # 同一患者多次就诊、取消、急诊/体检及两侧边界使错误粒度或时间条件可被识别。
    insert_rows(connection, "outpatient_visits", "institution_id,visit_id,patient_id,department_id,care_setting_code,registered_at,visit_status_code", [
        ("H001", "V001", "P001", "D_MED", "OUTPATIENT", "2026-09-01 00:00:00", "COMPLETED"),
        ("H001", "V002", "P001", "D_MED", "OUTPATIENT", "2026-09-10 09:00:00", "COMPLETED"),
        ("H001", "V003", "P002", "D_SURG", "OUTPATIENT", "2026-09-30 23:59:59", "COMPLETED"),
        ("H001", "V004", "P003", "D_ED", "EMERGENCY", "2026-09-10 09:00:00", "COMPLETED"),
        ("H001", "V005", "P004", "D_MED", "PHYSICAL_EXAM", "2026-09-10 09:00:00", "COMPLETED"),
        ("H001", "V006", "P002", "D_MED", "OUTPATIENT", "2026-09-10 09:00:00", "CANCELLED"),
        ("H001", "V007", "P003", "D_MED", "OUTPATIENT", "2026-08-31 23:59:59", "COMPLETED"),
        ("H001", "V008", "P004", "D_MED", "OUTPATIENT", "2026-10-01 00:00:00", "COMPLETED"),
        ("H001", "V009", "P003", "D_MED", "OUTPATIENT", "2026-09-15 09:00:00", "COMPLETED"),
        ("H001", "V010", "P004", "D_MED", "OUTPATIENT", "2026-09-16 09:00:00", "COMPLETED"),
        ("H001", "V011", "P005", "D_MED", "OUTPATIENT", "2026-09-17 09:00:00", "COMPLETED"),
        ("H001", "V012", "P005", "D_MED", "OUTPATIENT", "2026-09-18 09:00:00", "COMPLETED"),
        ("H999", "V001", "P001", "D_MED", "OUTPATIENT", "2026-09-01 00:00:00", "COMPLETED"),
    ])
    # 保留一挂号多预约、爽约、缺报到/叫诊和零等待；不替指标选择配对或缺失值规则。
    insert_rows(connection, "appointment_events", "institution_id,appointment_id,visit_id,appointment_kind_code,scheduled_at,checked_in_at,called_at,appointment_status_code", [
        ("H001", "A001", "V001", "REGISTRATION", "2026-09-01 00:00:00", "2026-09-01 00:00:00", "2026-09-01 00:15:00", "SUCCESS"),
        ("H001", "A002", "V001", "EXAM", "2026-09-01 08:00:00", "2026-09-01 08:00:00", "2026-09-01 08:30:00", "SUCCESS"),
        ("H001", "A003", "V002", "REGISTRATION", "2026-09-10 09:00:00", "2026-09-10 09:00:00", "2026-09-10 09:20:00", "SUCCESS"),
        ("H001", "A004", "V009", "REGISTRATION", "2026-09-15 09:00:00", "2026-09-15 09:00:00", None, "SUCCESS"),
        ("H001", "A005", "V010", "REGISTRATION", "2026-09-16 08:00:00", None, None, "NO_SHOW"),
        ("H001", "A006", "V006", "REGISTRATION", "2026-09-10 09:00:00", None, None, "CANCELLED"),
        ("H001", "A007", "V011", "REGISTRATION", "2026-09-17 09:00:00", None, "2026-09-17 10:00:00", "SUCCESS"),
        ("H001", "A008", "V012", "TREATMENT", "2026-09-18 10:00:00", "2026-09-18 10:00:00", "2026-09-18 10:00:00", "SUCCESS"),
        ("H001", "A009", "V008", "REGISTRATION", "2026-10-01 00:00:00", "2026-10-01 00:00:00", "2026-10-01 00:15:00", "SUCCESS"),
        ("H999", "A001", "V001", "REGISTRATION", "2026-09-01 00:00:00", "2026-09-01 00:00:00", "2026-09-01 01:30:00", "SUCCESS"),
    ])
    insert_rows(connection, "inpatient_stays", "institution_id,stay_id,patient_id,admitted_at,discharged_at,admit_department_id,discharge_department_id,discharge_disposition_code,home_bed_flag,planned_admission_flag,ward_arrived_at,rooming_in_newborn_flag", [
        ("H001", "S001", "P001", "2026-08-30 08:00:00", "2026-09-01 00:00:00", "D_MED", "D_MED", "ORDERED", 0, 0, "2026-08-30 08:10:00", 0),
        ("H001", "S002", "P001", "2026-09-01 10:00:00", "2026-09-03 12:00:00", "D_MED", "D_SURG", "ORDERED", 0, 1, "2026-09-01 10:10:00", 0),
        ("H001", "S003", "P002", "2026-09-29 08:00:00", "2026-09-30 23:59:59", "D_SURG", "D_SURG", "TRANSFER", 0, 1, "2026-09-29 08:10:00", 0),
        ("H001", "S004", "P003", "2026-09-01 08:00:00", "2026-09-02 12:00:00", "D_MED", "D_MED", "DEATH", 0, 0, "2026-09-01 08:10:00", 0),
        ("H001", "S005", "P004", "2026-09-01 08:00:00", "2026-09-02 12:00:00", "D_MED", "D_MED", "ORDERED", 1, 0, None, 0),
        ("H001", "S006", "P005", "2026-08-30 08:00:00", "2026-08-31 23:59:59", "D_MED", "D_MED", "ORDERED", 0, 0, "2026-08-30 08:10:00", 0),
        ("H001", "S007", "P005", "2026-09-25 08:00:00", "2026-10-01 00:00:00", "D_SURG", "D_SURG", "ORDERED", 0, 1, "2026-09-25 08:10:00", 0),
        ("H001", "S008", "P003", "2026-09-05 08:00:00", None, "D_MED", None, None, 0, 0, "2026-09-05 08:10:00", 0),
        ("H001", "S009", "P004", "2026-09-05 08:00:00", None, "D_MED", None, None, 0, 1, None, 0),
        ("H001", "S010", "P005", "2026-09-02 08:00:00", "2026-09-02 12:00:00", "D_MED", "D_MED", "ORDERED", 0, 0, "2026-09-02 08:10:00", 1),
        ("H001", "S011", "P002", "2026-09-03 08:00:00", "2026-09-04 12:00:00", "D_MED", "D_MED", "UNORDERED", 0, 0, "2026-09-03 08:10:00", 0),
        ("H001", "S012", "P004", "2026-09-20 08:00:00", "2026-09-21 12:00:00", "D_MED", "D_MED", "OTHER", 0, 0, "2026-09-20 08:10:00", 0),
        ("H999", "S001", "P001", "2026-08-31 08:00:00", "2026-09-02 12:00:00", "D_MED", "D_MED", "ORDERED", 0, 0, "2026-08-31 08:10:00", 0),
    ])
    # 自造诊断/操作目录仅演示版本和关联键，绝不冒充 ICD 或国家手术目录。
    insert_rows(connection, "inpatient_diagnoses", "institution_id,diagnosis_id,stay_id,diagnosis_code,code_system,code_edition,diagnosis_rank,present_on_admission_code", [
        ("H001", "DG001", "S002", "SYN_DIAG_A", "SYNTHETIC", "l0-v1", 1, None),
        ("H001", "DG002", "S002", "SYN_DIAG_B", "SYNTHETIC", "l0-v1", 2, "4"),
        ("H999", "DG001", "S001", "SYN_DIAG_A", "SYNTHETIC", "l0-v1", 1, None),
    ])
    insert_rows(connection, "inpatient_procedures", "institution_id,procedure_id,stay_id,procedure_code,code_system,code_edition,performed_at,surgery_grade_code,elective_flag,day_surgery_flag,minimally_invasive_flag,intervention_flag,anesthesia_flag,operating_location_code,incision_class_code,wound_healing_grade_code,unplanned_return_flag,prior_procedure_id", [
        ("H001", "R001", "S002", "SYN_PROC_A", "SYNTHETIC", "l0-v1", "2026-09-02 08:00:00", "4", 1, 0, 0, 0, 1, "WARD_OR", "I", None, 0, None),
        ("H001", "R002", "S002", "SYN_PROC_B", "SYNTHETIC", "l0-v1", "2026-09-02 15:00:00", "3", 0, 0, 0, 0, 1, "WARD_OR", "I", "3", 1, "R001"),
        ("H001", "R003", "S003", "SYN_PROC_C", "SYNTHETIC", "l0-v1", "2026-09-30 08:00:00", "4", 1, 0, 1, 0, 1, "WARD_OR", "I", None, 0, None),
        ("H001", "R004", "S007", "SYN_PROC_A", "SYNTHETIC", "l0-v1", "2026-09-28 08:00:00", "4", 1, 0, 0, 0, 1, "WARD_OR", "I", None, 0, None),
        ("H999", "R001", "S001", "SYN_PROC_A", "SYNTHETIC", "l0-v1", "2026-09-01 08:00:00", "4", 1, 0, 0, 0, 1, "WARD_OR", "I", None, 0, None),
    ])
    insert_rows(connection, "clinical_code_memberships", "catalog_id,catalog_version,code_system,code_edition,code,valid_from,valid_to", [
        ("SYN_PROCEDURES", "l0-v1", "SYNTHETIC", "l0-v1", code, "2026-01-01", "2026-12-31")
        for code in ("SYN_PROC_A", "SYN_PROC_B", "SYN_PROC_C")
    ])
    insert_rows(connection, "clinical_events", "institution_id,event_id,stay_id,procedure_id,event_type_code,occurred_at,present_on_admission_code,hospital_acquired_flag,event_location_code", [
        ("H001", "CE001", "S002", "R001", "SURGICAL_COMPLICATION", "2026-09-02 14:00:00", "4", 1, "IN_HOSPITAL"),
    ])
    # 床日仅为若干样例日期的事实；不填满月份，不把缺记录解释为零占用。
    insert_rows(connection, "inpatient_census_days", "institution_id,stay_id,census_date,department_id,count_basis_code,bed_kind_code", [
        ("H001", "S002", "2026-09-01", "D_MED", "MIDNIGHT", "REGULAR"),
        ("H001", "S002", "2026-09-02", "D_SURG", "MIDNIGHT", "REGULAR"),
        ("H001", "S004", "2026-09-01", "D_MED", "MIDNIGHT", "REGULAR"),
        ("H001", "S005", "2026-09-01", "D_MED", "MIDNIGHT", "HOME"),
        ("H001", "S010", "2026-09-02", "D_MED", "SAME_DAY_EXIT", "ROOMING_IN_NEWBORN"),
        ("H001", "S008", "2026-09-06", "D_MED", "MIDNIGHT", "TEMPORARY"),
        ("H001", "S001", "2026-08-31", "D_MED", "MIDNIGHT", "REGULAR"),
        ("H001", "S007", "2026-09-30", "D_SURG", "MIDNIGHT", "REGULAR"),
        ("H999", "S001", "2026-09-01", "D_MED", "MIDNIGHT", "REGULAR"),
    ])
    insert_rows(connection, "bed_capacity_days", "institution_id,department_id,capacity_date,open_beds_count", [
        ("H001", "D_MED", "2026-09-01", 10), ("H001", "D_MED", "2026-09-02", 8),
        ("H001", "D_SURG", "2026-09-01", 5), ("H001", "D_SURG", "2026-09-02", 5),
        ("H001", "D_MED", "2026-09-06", 10), ("H001", "D_MED", "2026-08-31", 10),
        ("H001", "D_SURG", "2026-09-30", 5), ("H001", "D_MED", "2026-10-01", 12),
        ("H999", "D_MED", "2026-09-01", 500),
    ])
    # 只存叶子科目余额，避免合计与明细双算；合成科目不代表真实会计映射。
    insert_rows(connection, "balance_snapshots", "institution_id,snapshot_date,account_code,balance_yuan,balance_class_code,quick_asset_flag", [
        ("H001", "2026-09-30", "SYN_CASH", 200, "CURRENT_ASSET", 1),
        ("H001", "2026-09-30", "SYN_INVENTORY", 100, "CURRENT_ASSET", None),
        ("H001", "2026-09-30", "SYN_FIXED_ASSET", 700, "NONCURRENT_ASSET", 0),
        ("H001", "2026-09-30", "SYN_PAYABLE", 200, "CURRENT_LIABILITY", 0),
        ("H001", "2026-09-30", "SYN_LONG_LOAN", 100, "NONCURRENT_LIABILITY", 0),
        ("H001", "2026-08-31", "SYN_CASH", 900, "CURRENT_ASSET", 1),
        ("H001", "2026-10-31", "SYN_CASH", 999, "CURRENT_ASSET", 1),
        ("H999", "2026-09-30", "SYN_CASH", 9000, "CURRENT_ASSET", 1),
    ])
    # 证据引用是合成标识而非已核验文件；外部成绩缺失保持 NULL，不造评分。
    insert_rows(connection, "management_evidence", "institution_id,evidence_id,department_id,assessment_clause_code,evidence_method_code,evidence_domain_code,evidence_stage_code,effective_date,assessment_year,document_reference", [
        ("H001", "ME001", None, "2.1.12.1", "DOCUMENT", "QUALITY", "SYN_SYSTEM", "2026-01-01", 2026, "synthetic:l0:quality-system"),
        ("H001", "ME002", None, "2.1.12.2", "RECORD", "QUALITY", "SYN_OPERATION", "2026-09-01", 2026, "synthetic:l0:quality-meeting"),
        ("H001", "ME003", None, "2.1.12.3", "INTERVIEW", "QUALITY", "SYN_RESPONSIBILITY", "2026-09-01", 2026, "synthetic:l0:director-interview"),
        ("H001", "ME004", "D_SURG", "2.1.12.4", "ON_SITE", "QUALITY", "SYN_RESPONSIBILITY", "2026-09-01", 2026, None),
        ("H001", "ME_EXTERNAL_PENDING", None, None, "DOCUMENT", "QUALITY", "SYN_EXTERNAL_RESULT_PENDING", None, 2026, None),
    ])
    insert_rows(connection, "emr_assessment_items", "institution_id,assessment_year,standard_version,item_code,option_code,target_level,option_role_code,implemented_flag,effective_coverage_percent,data_quality_index", [
        ("H001", 2026, "SYN_EMR_v1", "SYN_ITEM_A", "SYN_OPTION_A", 1, "SYN_BASIC", 1, 80.0, 0.5),
        ("H001", 2026, "SYN_EMR_v1", "SYN_ITEM_B", "SYN_OPTION_B", 1, "SYN_BASIC", 1, 81.0, 0.51),
        ("H001", 2026, "SYN_EMR_v1", "SYN_ITEM_C", "SYN_OPTION_C", 1, "SYN_OPTIONAL", 0, 50.0, None),
    ])


def build(output_dir: Path) -> dict:
    """先完成临时库校验，再排他发布；失败清理临时文件，绝不覆盖既有快照。"""
    output_dir = output_dir.resolve()
    target = output_dir / DATABASE_NAME
    if os.path.lexists(target):
        raise FileExistsError("L0 快照已存在；请指定新的 --output-dir，不覆盖既有数据")
    output_dir.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".l0-build-", suffix=".sqlite", dir=output_dir)
    os.close(descriptor)
    temporary = Path(temporary_name)
    connection = None
    try:
        connection = sqlite3.connect(temporary)
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript((FIXTURES / "mock_schema.sql").read_text(encoding="utf-8"))
        populate(connection)
        connection.commit()
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise RuntimeError("L0 SQLite 完整性校验失败")
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("L0 SQLite 外键校验失败")
        connection.close()
        connection = None
        # 同目录硬链接提供原子、不替换的发布；并发生成时只能有一个成功。
        os.link(temporary, target)
    finally:
        if connection is not None:
            connection.close()
        temporary.unlink(missing_ok=True)
        for suffix in ("-journal", "-wal", "-shm"):
            Path(str(temporary) + suffix).unlink(missing_ok=True)
    return {
        "id": "l0_mock",
        "name": "L0 合成医院",
        "path": str(target),
        "dictionary_path": str(FIXTURES / "mock_semantics.json"),
        "knowledge_path": str(FIXTURES),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="创建 L0 原始合成事实库；拒绝覆盖，不计算指标，不修改数据源注册表")
    parser.add_argument("--output-dir", type=Path, default=APP_ROOT / ".local" / "l0")
    args = parser.parse_args()
    try:
        source = build(args.output_dir)
    except (OSError, sqlite3.Error, RuntimeError) as error:
        parser.exit(1, f"L0 生成失败：{error}\n")
    print(json.dumps({"sources": [source], "provenance": "synthetic_test_design", "note": "仅生成原始合成事实；请显式登记数据源；未计算47项指标"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
