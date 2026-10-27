"""按 L0 的原始事实契约造数；保留小样本，并补充可重复的纵向合成事件。"""

from __future__ import annotations

import random
import sqlite3
from datetime import date, datetime, time, timedelta

from build_l0_fixtures import populate as populate_controls


AS_OF = "2026-10-15T12:00:00+08:00"
INSTITUTIONS = ("H001", "H002", "H999")
DEPARTMENTS = (
    ("D_MED", "合成内科", "NON_SURGICAL"),
    ("D_SURG", "合成外科", "SURGICAL"),
    ("D_ED", "合成急诊", "EMERGENCY"),
    ("D_ICU", "合成重症", "ICU"),
    ("D_OTHER", "合成其他科室", "OTHER"),
)


def insert(connection: sqlite3.Connection, table: str, **values: object) -> None:
    """只接受生成器固定标识符，业务值参数化，避免空值被改成字符串。"""
    columns = ",".join(f'"{name}"' for name in values)
    parameters = ",".join("?" for _ in values)
    connection.execute(f'INSERT INTO "{table}" ({columns}) VALUES ({parameters})', tuple(values.values()))


def stamp(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S")


def populate_core(connection: sqlite3.Connection, seed: int = 20261016, patients_per_institution: int = 200) -> dict:
    """规模参数只改变批量事实；九月控制样本保持独立，便于手算和错误变形验证。"""
    if not 8 <= patients_per_institution <= 10000:
        raise ValueError("patients_per_institution 必须为 8～10000，以覆盖全部事件域")
    rng = random.Random(seed)
    populate_controls(connection)
    # 旧夹具的切片各自独立；拼成纵向数据时去除“死亡后再入院”和新生儿重复成人住院的矛盾。
    connection.execute("UPDATE inpatient_stays SET discharge_disposition_code='OTHER' WHERE institution_id='H001' AND stay_id='S004'")
    connection.execute("UPDATE inpatient_stays SET rooming_in_newborn_flag=0 WHERE institution_id='H001' AND stay_id='S010'")
    insert(connection, "institutions", institution_id="H002", institution_name="第二合成医院", hospital_class_code="SPECIALTY")
    for institution in INSTITUTIONS:
        existing = {row[0] for row in connection.execute("SELECT department_id FROM departments WHERE institution_id=?", (institution,))}
        for department, name, kind in DEPARTMENTS:
            if department not in existing:
                insert(connection, "departments", institution_id=institution, department_id=department, department_name=name, department_type=kind)

    # 所有目录、DDD、DRG 和风险版本均显式 SYN，数值不能冒充国家目录或市级基准。
    for version in ("SYN_DDD_2025", "SYN_DDD_2026"):
        # 同码跨年标准故意不同，使错误固定旧版本的查询无法偶然数值过关。
        for drug, quantity, unit, antibacterial in (("SYN_DRUG_A", 1 if version.endswith("2025") else 2, "g", 1), ("SYN_DRUG_B", 500, "mg", 1), ("SYN_DRUG_C", 1, "g", 0)):
            insert(connection, "drug_ddd_standards", drug_code_system="SYNTHETIC", drug_code_edition="l0-v1", drug_code=drug,
                   ddd_version=version, is_antibacterial=antibacterial, ddd_quantity=quantity, ddd_unit=unit)
    for year in (2025, 2026):
        for index in range(3):
            insert(connection, "drg_group_reference", reference_year=year, grouper_version=f"SYN_DRG_{year}",
                   drg_code=f"SYN_G{index + 1}", mortality_risk_class_code="LOW" if index == 0 else "OTHER",
                   relative_weight=1 + index * 0.5 + (year - 2025) * 0.1, reference_los_days=3 + index, reference_cost_yuan=3000 + index * 1200 + (year - 2025) * 100)
    for catalog, codes in (("SYN_MINIMALLY_INVASIVE", ["SYN_PROC_C"]), ("SYN_GRADE4", ["SYN_PROC_A", "SYN_PROC_C"]),
                           ("SYN_COMPLICATION", ["SYN_DIAG_B"]), ("SYN_AUX_DRUG", ["SYN_DRUG_A"]),
                           ("SYN_HIGH_VALUE_MATERIAL", ["SYN_MATERIAL_A"])):
        for version, start, end in (("SYN_CATALOG_2025", "2025-01-01", "2025-12-31"), ("SYN_CATALOG_2026", "2026-01-01", "2026-12-31")):
            for code in codes:
                insert(connection, "clinical_code_memberships", catalog_id=catalog, catalog_version=version,
                       code_system="SYNTHETIC", code_edition="l0-v1", code=code, valid_from=start, valid_to=end)

    for institution_index, institution in enumerate(INSTITUTIONS):
        for index in range(1, patients_per_institution + 1):
            patient = f"BP{index:05d}"
            insert(connection, "patients", institution_id=institution, patient_id=patient,
                   date_of_birth=f"{1940 + rng.randrange(65):04d}-{1 + rng.randrange(12):02d}-15", sex_code=("1", "2")[index % 2])
            for year in (2025, 2026):
                # 两年同一患者重复住院但时间不重叠；月份限定一至八月，避免污染手算九月样本。
                admitted = datetime(year, 1 + index % 8, 3 + index % 18, 8)
                discharged = admitted + timedelta(days=2 + index % 8, hours=4)
                stay = f"BS{year}{index:05d}"
                department = "D_SURG" if index % 2 == 0 else "D_MED"
                disposition = "DEATH" if year == 2026 and index % 29 == 0 else "ORDERED"
                insert(connection, "inpatient_stays", institution_id=institution, stay_id=stay, patient_id=patient,
                       admitted_at=stamp(admitted), discharged_at=stamp(discharged), admit_department_id="D_MED",
                       discharge_department_id=department, discharge_disposition_code=disposition, home_bed_flag=0,
                       planned_admission_flag=index % 2, ward_arrived_at=stamp(admitted + timedelta(minutes=15)), rooming_in_newborn_flag=0,
                       day_surgery_planned_admit_at=stamp(admitted) if index % 10 == 0 else None,
                       day_surgery_planned_discharge_at=stamp(admitted + timedelta(hours=20)) if index % 10 == 0 else None,
                       day_surgery_delay_reason_code="MEDICAL_CONDITION" if index % 10 == 0 else None)
                for rank in (1, 2):
                    insert(connection, "inpatient_diagnoses", institution_id=institution, diagnosis_id=f"BD{year}{index:05d}{rank}",
                           stay_id=stay, diagnosis_code=f"SYN_DIAG_{'A' if rank == 1 else 'B'}", code_system="SYNTHETIC",
                           code_edition="l0-v1", diagnosis_rank=rank, present_on_admission_code="4" if rank == 2 and index % 7 == 0 else None)
                procedure = None
                if index % 2 == 0:
                    for occurrence in range(1 + int(index % 6 == 0)):
                        procedure = f"BR{year}{index:05d}{occurrence}"
                        procedure_time = admitted + timedelta(days=1, hours=occurrence * 6)
                        insert(connection, "inpatient_procedures", institution_id=institution, procedure_id=procedure, stay_id=stay,
                               procedure_code="SYN_PROC_C" if index % 4 == 0 else "SYN_PROC_B", code_system="SYNTHETIC", code_edition="l0-v1",
                               performed_at=stamp(procedure_time), surgery_grade_code="4" if index % 4 == 0 else "3",
                               elective_flag=int(occurrence == 0), day_surgery_flag=0, minimally_invasive_flag=int(index % 4 == 0),
                               intervention_flag=int(occurrence == 1), anesthesia_flag=1, operating_location_code="WARD_OR", incision_class_code="I",
                               wound_healing_grade_code="3" if index % 22 == 0 else None, unplanned_return_flag=int(occurrence == 1),
                               prior_procedure_id=f"BR{year}{index:05d}0" if occurrence else None)
                for kind_index, kind in enumerate(("FALL", "PRESSURE_INJURY", "HOSPITAL_INFECTION")):
                    if index % (5 + kind_index) == 0:
                        insert(connection, "clinical_events", institution_id=institution, event_id=f"BE{year}{index:05d}{kind_index}", stay_id=stay,
                               procedure_id=None, event_type_code=kind, event_code=f"SYN_EVENT_{kind}", occurred_at=stamp(admitted + timedelta(hours=24 + kind_index)),
                               present_on_admission_code=None, hospital_acquired_flag=1, pressure_stage_code="2" if kind_index == 1 else None,
                               event_location_code="IN_HOSPITAL", pediatric_physiological_no_harm_fall_flag=0,
                               pressure_injury_kind_code="PRESSURE" if kind_index == 1 else None,
                               infection_present_on_admission_flag=0 if kind_index == 2 else None,
                               infection_incubating_on_admission_flag=0 if kind_index == 2 else None)
                for drug_index, drug in enumerate(("SYN_DRUG_A", "SYN_DRUG_B", "SYN_DRUG_C")):
                    # 死亡出院没有患者带药；家庭病床边界只由无院内事件的原 S005 样本承担。
                    if drug_index == 2 and disposition == "DEATH":
                        continue
                    # 同种药物混合 g/mg，迫使评测显式校验单位换算而不是直接相加。
                    quantity, unit = (2000, "mg") if drug_index == 0 and index % 2 else ((2, "g") if drug_index == 0 else (500, "mg"))
                    insert(connection, "medication_administrations", institution_id=institution, administration_id=f"BM{year}{index:05d}{drug_index}",
                           stay_id=stay, drug_code=drug, drug_code_system="SYNTHETIC", drug_code_edition="l0-v1", ddd_standard_version=f"SYN_DDD_{year}",
                           consumed_at=stamp(discharged if drug_index == 2 else admitted + timedelta(hours=10 + drug_index)), quantity=quantity, quantity_unit=unit,
                           take_home_at_discharge_flag=int(drug_index == 2))
                insert(connection, "drg_case_assignments", institution_id=institution, stay_id=stay, reference_year=year,
                       grouper_version=f"SYN_DRG_{year}", drg_code=f"SYN_G{1 + index % 3}", assigned_at=stamp(discharged + timedelta(days=1)))
                if index % 4 == 0:
                    episode = f"BI{year}{index:05d}"
                    insert(connection, "icu_episodes", institution_id=institution, icu_episode_id=episode, stay_id=stay,
                           icu_entered_at=stamp(admitted + timedelta(hours=1)), icu_left_at=stamp(admitted + timedelta(days=1)),
                           icu_disposition_code="ALIVE", brain_dead_on_entry_flag=0, organ_donation_purpose_flag=0)
                    for attempt in (1, 2):
                        insert(connection, "icu_risk_assessments", institution_id=institution, risk_assessment_id=f"BA{year}{index:05d}{attempt}",
                               icu_episode_id=episode, assessed_at=stamp(admitted + timedelta(hours=attempt + 1)), risk_model_code="SYN_APACHE",
                               risk_model_version="SYN_RISK_v1", apache_ii_score=10 + index % 20, major_disease_score=0.5, emergency_postop_flag=index % 2)

                for visit_index in (0, 1):
                    visit = f"BV{year}{index:05d}{visit_index}"
                    registered = admitted - timedelta(days=1 + visit_index, hours=-1)
                    setting = ("OUTPATIENT", "EMERGENCY", "PHYSICAL_EXAM")[(index + visit_index) % 3]
                    status = "CANCELLED" if index % 13 == 0 else "COMPLETED"
                    insert(connection, "outpatient_visits", institution_id=institution, visit_id=visit, patient_id=patient,
                           department_id="D_ED" if setting == "EMERGENCY" else "D_MED", care_setting_code=setting,
                           registered_at=stamp(registered), visit_status_code=status)
                    if setting == "OUTPATIENT":
                        for item in range(1 + int(index % 5 == 0)):
                            checked = registered + timedelta(minutes=item * 60)
                            insert(connection, "appointment_events", institution_id=institution, appointment_id=f"BQ{year}{index:05d}{visit_index}{item}",
                                   visit_id=visit, appointment_kind_code="EXAM" if item else "REGISTRATION", scheduled_at=stamp(checked),
                                   checked_in_at=stamp(checked) if status == "COMPLETED" else None,
                                   called_at=stamp(checked + timedelta(minutes=5 + index % 40)) if status == "COMPLETED" and index % 17 else None,
                                   appointment_status_code="SUCCESS" if status == "COMPLETED" else "CANCELLED")
                    if setting == "EMERGENCY" and status == "COMPLETED":
                        insert(connection, "emergency_rescue_episodes", institution_id=institution, rescue_episode_id=f"BX{year}{index:05d}{visit_index}",
                               visit_id=visit, entered_at=stamp(registered), left_at=stamp(registered + timedelta(minutes=15 + index % 120)), departure_status_code="ALIVE")
                    # 取消且未接诊的事件不确认诊疗收入，避免收入与实际服务相互矛盾。
                    if status == "COMPLETED":
                        add_revenue(connection, institution, f"BFV{year}{index:05d}{visit_index}", registered.date(), setting,
                                    100 + index % 50 + institution_index * 20 + (year - 2025) * 10, visit=visit)
                add_revenue(connection, institution, f"BFS{year}{index:05d}", discharged.date(), "INPATIENT", 1000 + index * 7 + (year - 2025) * 100, stay=stay)

        # 财务、人员和能耗保留两年、不同月份及正负分录；只给模拟标准，不补官方缺口。
        for year in (2025, 2026):
            for clinician in range(1, 9):
                insert(connection, "clinician_year_roster", institution_id=institution, clinician_id=f"BC{clinician:03d}", roster_year=year,
                       license_type_code="SYN_PHYSICIAN", clinical_work_flag=int(clinician != 8), standard_training_flag=int(clinician == 7),
                       primary_registration_here_flag=int(clinician != 6))
            for month in range(1, 9):
                when = date(year, month, 28)
                for code, kind, amount, quick in (("SYN_CASH", "CURRENT_ASSET", 20000, 1), ("SYN_INVENTORY", "CURRENT_ASSET", 5000, 0),
                                                ("SYN_FIXED_ASSET", "NONCURRENT_ASSET", 40000, 0), ("SYN_PAYABLE", "CURRENT_LIABILITY", 12000, 0),
                                                ("SYN_LONG_LOAN", "NONCURRENT_LIABILITY", 18000, 0)):
                    insert(connection, "balance_snapshots", institution_id=institution, snapshot_date=str(when), account_code=code,
                           balance_yuan=amount + institution_index * 100 + month * 10, balance_class_code=kind, quick_asset_flag=quick)
                for energy, unit, quantity, factor in (("ELECTRICITY", "kWh", 1000 + month * 10, 0.0001), ("WATER", "m3", 100 + month, None),
                                                     ("NATURAL_GAS", "m3", 50 + month, 0.001)):
                    insert(connection, "energy_consumption", institution_id=institution, energy_record_id=f"BEN{year}{month:02d}{energy}",
                           consumed_date=str(when), energy_kind_code=energy, quantity=quantity, quantity_unit=unit,
                           standard_coal_tons_per_unit=factor, conversion_version="SYN_ENERGY_v1")
                for item, amount in (("SYN_PERSONNEL", 3000), ("SYN_MATERIAL", 500), ("SYN_GRANT", -100)):
                    insert(connection, "financial_entries", institution_id=institution, entry_id=f"BFX{year}{month:02d}{item}",
                           accounting_date=str(when), account_code=item, account_kind_code="EXPENSE", amount_yuan=amount,
                           care_setting_code="NON_CLINICAL", payer_category_code="OTHER", item_class_code="OTHER", funding_source_code="SYN_OPERATING")
            for scope in ("OUTPATIENT", "INPATIENT"):
                insert(connection, "insurance_agreements", institution_id=institution, agreement_id=f"BAG{year}{scope}", service_scope_code=scope,
                       valid_from=f"{year}-01-01", valid_to=f"{year}-12-31", agreement_status_code="SYN_ACTIVE")
            for domain in ("BUDGET", "EMR", "QUALITY"):
                insert(connection, "management_evidence", institution_id=institution, evidence_id=f"BME{year}{domain}", department_id="D_MED",
                       assessment_clause_code="2.1.12.4" if domain == "QUALITY" else None, evidence_method_code="DOCUMENT", evidence_domain_code=domain,
                       evidence_stage_code="SYN_UNREVIEWED", effective_date=f"{year}-01-01", assessment_year=year,
                       document_reference=f"synthetic:l0-benchmark:{institution}:{year}:{domain}")
            for item in range(1, 5):
                insert(connection, "emr_assessment_items", institution_id=institution, assessment_year=year, standard_version="SYN_EMR_BENCH_v1",
                       item_code=f"SYN_BITEM_{item}", option_code=f"SYN_BOPT_{item}", target_level=1 + item % 2,
                       option_role_code="SYN_BASIC" if item % 2 else "SYN_OPTIONAL", implemented_flag=int(item != 4),
                       effective_coverage_percent=(80, 81, 50, 51)[item - 1], data_quality_index=None if item == 4 else 0.51)
    rebuild_bed_facts(connection)
    return {"seed": seed, "patients_per_institution": patients_per_institution, "institutions": list(INSTITUTIONS),
            "bulk_period": "2025/2026 年一至八月；住院子事件可延伸至九月", "control_period": "2026 年九月",
            "as_of": AS_OF, "provenance": "synthetic_test_design"}


def add_revenue(connection: sqlite3.Connection, institution: str, entry: str, when: date, setting: str, amount: int,
                visit: str | None = None, stay: str | None = None) -> None:
    """金额用整数元，退款为原分录的一部分冲回，不把收款流水充当权责收入。"""
    for suffix, value in (("", amount), ("R", -10)):
        insert(connection, "financial_entries", institution_id=institution, entry_id=entry + suffix, visit_id=visit, stay_id=stay,
               accounting_date=str(when), account_code="SYN_CLINICAL_REVENUE", account_kind_code="REVENUE", amount_yuan=value,
               care_setting_code=setting, payer_category_code="INSURANCE_FUND", insurance_fund_amount_yuan=value // 2,
               item_class_code="MEDICAL_SERVICE", item_code="SYN_SERVICE_A", item_code_system="SYNTHETIC", item_code_edition="l0-v1",
               funding_source_code="SYN_OPERATING")


def rebuild_bed_facts(connection: sqlite3.Connection) -> None:
    """新包按真实时间顺序重造占床事实；原94行夹具保持不变，不继承其局部日期近似。"""
    connection.execute("DELETE FROM inpatient_census_days")
    connection.execute("DELETE FROM bed_capacity_days")
    snapshot = datetime(2026, 10, 15, 12)
    for institution, stay, admitted, discharged, department, home, arrived, newborn in connection.execute(
        "SELECT institution_id,stay_id,admitted_at,discharged_at,admit_department_id,home_bed_flag,ward_arrived_at,rooming_in_newborn_flag FROM inpatient_stays"
    ).fetchall():
        if arrived is None:
            continue
        start = datetime.fromisoformat(arrived)
        end = datetime.fromisoformat(discharged) if discharged else snapshot
        day = start.date() + timedelta(days=1)
        kind = "HOME" if home else ("ROOMING_IN_NEWBORN" if newborn else "REGULAR")
        while datetime.combine(day, time()) < end:
            insert(connection, "inpatient_census_days", institution_id=institution, stay_id=stay, census_date=str(day),
                   department_id=department, count_basis_code="MIDNIGHT", bed_kind_code=kind)
            day += timedelta(days=1)
        if start.date() == end.date():
            insert(connection, "inpatient_census_days", institution_id=institution, stay_id=stay, census_date=str(start.date()),
                   department_id=department, count_basis_code="SAME_DAY_EXIT", bed_kind_code=kind)
    for institution in INSTITUTIONS:
        for department, _, _ in DEPARTMENTS:
            day = date(2025, 1, 1)
            while day <= date(2026, 10, 15):
                insert(connection, "bed_capacity_days", institution_id=institution, department_id=department, capacity_date=str(day),
                       open_beds_count=500 if institution != "H999" else 700)
                day += timedelta(days=1)
