"""为 L0 合成核心事实补充 80 张医院业务支撑表；不计算指标、不存标准答案。"""

from __future__ import annotations

import random
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta


# 指标标识沿用来源 JSON；支撑关系仅说明业务相关性，不宣称已完成正式口径绑定。
def GK(*codes: int) -> list[str]:
    return [f"met.gk-{code:02d}" for code in codes]


def SH(*codes: int) -> list[str]:
    return [f"met.sh-ps-m{code:04d}" for code in codes]


SURGERY = GK(3, 4, 5, 6, 8, 9) + SH(34, 36, 37, 85, 103)
QUALITY = ["met.qc-nqi-07", "met.qc-nqi-08", "met.qc-haiqi-03"] + GK(8, 9)
FINANCE = GK(27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 40, 56) + SH(43, 44, 51, 61)
MANAGEMENT = GK(24, 42) + SH(645) + ["met.sh-ps-s012"]


def _time(value: str, minutes: int = 0) -> str:
    """统一从父事实时间派生，避免混用固定年份或随机日期导致先后倒置。"""
    return (datetime.fromisoformat(value) + timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")


def _during(stay: dict, minutes: int = 0) -> str:
    start = datetime.fromisoformat(stay["admitted_at"])
    candidate = start + timedelta(minutes=minutes)
    if stay.get("discharged_at"):
        candidate = min(candidate, datetime.fromisoformat(stay["discharged_at"]))
    return max(start, candidate).strftime("%Y-%m-%d %H:%M:%S")


def _fk(parent: str, *columns: str) -> str:
    """机构业务关系始终携带机构键；只有显式全局版本目录不使用此助手。"""
    names = ",".join(("institution_id", *columns))
    return f"FOREIGN KEY ({names}) REFERENCES {parent} ({names})"


class _Builder:
    """小型内部建表助手只减少参数化插入重复；每张表独立定义业务列与粒度。"""

    def __init__(self, connection: sqlite3.Connection, seed: int):
        self.connection = connection
        self.random = random.Random(seed)
        self.metadata: dict[str, dict] = {}
        self.rows: dict[str, list[dict]] = {}

    def read(self, table: str) -> list[dict]:
        if table not in self.rows:
            cursor = self.connection.execute(f'SELECT * FROM "{table}" ORDER BY 1,2')
            names = [column[0] for column in cursor.description]
            self.rows[table] = [dict(zip(names, row)) for row in cursor.fetchall()]
        return self.rows[table]

    def table(self, name: str, identifier: str, description: str, domain: str, grain: str,
              metrics: list[str], columns: list[tuple[str, str, str]],
              foreign_keys: tuple[str, ...] = (), role: str = "support"):
        definitions = ["institution_id TEXT NOT NULL", f"{identifier} TEXT NOT NULL"]
        definitions.extend(f"{column} {kind}" for column, kind, _ in columns)
        definitions += [f"PRIMARY KEY (institution_id,{identifier})", _fk("institutions"), *foreign_keys]
        self.connection.execute(f"CREATE TABLE {name} ({','.join(definitions)})")
        self.metadata[name] = {
            "description": f"{description}；全部为合成测试事实，不代表正式指标口径。",
            "domain": domain, "grain": grain, "role": role,
            "related_metric_ids": sorted(set(metrics)),
            "columns": {"institution_id": "机构键；与所有本机构业务键共同关联，禁止仅用局部编号跨机构连接。",
                        identifier: f"机构内{description}记录键。", **{c: d for c, _, d in columns}},
        }
        fields = ["institution_id", identifier, *[c for c, _, _ in columns]]
        self.rows[name] = []

        def insert(institution: str, local_id: str, *values):
            row = (institution, local_id, *values)
            self.connection.execute(f"INSERT INTO {name} ({','.join(fields)}) VALUES ({','.join('?' for _ in fields)})", row)
            self.rows[name].append(dict(zip(fields, row)))
        return insert


def _organization(b: _Builder) -> None:
    """空间与组织维度保留历史、别名和护理/财务归属，不能替代实际占床日。"""
    metrics = GK(1, 25, 34) + SH(3, 34) + MANAGEMENT
    campus = b.table("hospital_campuses", "campus_id", "院区", "机构空间", "一机构一院区", metrics,
                     [("campus_name", "TEXT NOT NULL", "合成院区名称"), ("opened_on", "TEXT NOT NULL", "启用日期"), ("campus_status", "TEXT NOT NULL", "院区运行状态")])
    building = b.table("hospital_buildings", "building_id", "院区建筑", "机构空间", "一院区一建筑", GK(34),
                       [("campus_id", "TEXT NOT NULL", "所属院区"), ("building_name", "TEXT NOT NULL", "合成楼宇名称"), ("floor_count", "INTEGER NOT NULL", "地上楼层数，单位层")], (_fk("hospital_campuses", "campus_id"),))
    ward = b.table("hospital_wards", "ward_id", "住院病区", "机构空间", "一科室一病区", GK(25) + SH(3, 35),
                   [("department_id", "TEXT NOT NULL", "管理科室"), ("building_id", "TEXT NOT NULL", "所在建筑"), ("ward_name", "TEXT NOT NULL", "合成病区名称")], (_fk("departments", "department_id"), _fk("hospital_buildings", "building_id")))
    alias = b.table("department_aliases", "alias_id", "科室系统别名", "机构空间", "一科室一来源系统别名", metrics,
                    [("department_id", "TEXT NOT NULL", "规范科室"), ("source_system", "TEXT NOT NULL", "别名所属系统"), ("alias_name", "TEXT NOT NULL", "来源科室别名，不是另一个科室")], (_fk("departments", "department_id"),))
    history = b.table("department_history", "department_version_id", "科室历史版本", "机构空间", "一科室一有效版本", metrics,
                      [("department_id", "TEXT NOT NULL", "科室键"), ("valid_from", "TEXT NOT NULL", "版本生效日期"), ("valid_to", "TEXT", "版本结束日期，空表示当前"), ("department_name", "TEXT NOT NULL", "该版本显示名称")], (_fk("departments", "department_id"),))
    center = b.table("cost_centers", "cost_center_id", "科室成本中心", "机构空间", "一科室一成本中心", FINANCE,
                     [("department_id", "TEXT NOT NULL", "归属科室"), ("allocation_basis", "TEXT NOT NULL", "合成成本归集依据"), ("valid_from", "TEXT NOT NULL", "启用日期")], (_fk("departments", "department_id"),))
    unit = b.table("nursing_units", "nursing_unit_id", "护理单元", "机构空间", "一病区一护理单元", QUALITY,
                   [("ward_id", "TEXT NOT NULL", "负责病区"), ("unit_name", "TEXT NOT NULL", "护理单元名称"), ("shift_pattern", "TEXT NOT NULL", "轮班方式")], (_fk("hospital_wards", "ward_id"),))
    bed = b.table("location_beds", "bed_id", "物理床位资产", "机构空间", "一病区一物理床位", SH(3) + GK(25),
                  [("ward_id", "TEXT NOT NULL", "所在病区"), ("bed_label", "TEXT NOT NULL", "床位显示编号"), ("bed_type", "TEXT NOT NULL", "床资产类型；不代表当天开放床位"), ("asset_status", "TEXT NOT NULL", "床资产在册状态")], (_fk("hospital_wards", "ward_id"),), role="distractor")
    for row in b.read("institutions"):
        inst = row["institution_id"]
        campus(inst, "C_MAIN", "合成主院区", "2020-01-01", "ACTIVE")
        building(inst, "BL_INPATIENT", "C_MAIN", "合成医疗楼", 8)
    # 资产台账至少容纳核心已开放床位；资产数和某日开放数仍保留不同业务含义。
    capacity = defaultdict(int)
    for row in b.read("bed_capacity_days"):
        key = row["institution_id"], row["department_id"]
        capacity[key] = max(capacity[key], row["open_beds_count"])
    for row in b.read("departments"):
        inst, dep = row["institution_id"], row["department_id"]
        ward(inst, f"W_{dep}", dep, "BL_INPATIENT", f"{row['department_name']}病区")
        unit(inst, f"NU_{dep}", f"W_{dep}", f"{row['department_name']}护理单元", "THREE_SHIFTS")
        center(inst, f"CC_{dep}", dep, "SYN_DIRECT_RECORD", "2020-01-01")
        for system in ("HIS", "NURSING"):
            alias(inst, f"{dep}_{system}", dep, system, f"{row['department_name']}_{system}")
        history(inst, f"{dep}_V1", dep, "2020-01-01", "2025-12-31", f"{row['department_name']}旧称")
        history(inst, f"{dep}_V2", dep, "2026-01-01", None, row["department_name"])
        for number in range(1, max(3, capacity[inst, dep]) + 1):
            bed(inst, f"BED_{dep}_{number}", f"W_{dep}", f"{number:02d}", "REGULAR", "IN_SERVICE")


def _patients(b: _Builder) -> None:
    """患者扩展只生成合成偏好、筛查和登记历史，不生成真实姓名、电话或证件号。"""
    metric = GK(1, 14) + SH(93) + QUALITY
    identity = b.table("patient_local_identifiers", "identifier_id", "患者系统内标识", "患者背景", "一患者一系统标识", metric,
                       [("patient_id", "TEXT NOT NULL", "患者主键"), ("system_code", "TEXT NOT NULL", "系统标识类型"), ("local_identifier", "TEXT NOT NULL", "仅供合成系统内部使用的编号")], (_fk("patients", "patient_id"),))
    demographics = b.table("patient_demographic_history", "demographic_version_id", "患者基本信息版本", "患者背景", "一患者一次信息核对", metric,
                           [("patient_id", "TEXT NOT NULL", "患者键"), ("verified_at", "TEXT NOT NULL", "信息核对时间"), ("date_of_birth", "TEXT", "当前登记出生日期；缺失原样保留"), ("verification_status", "TEXT NOT NULL", "资料核对状态")], (_fk("patients", "patient_id"),))
    insurance = b.table("patient_insurance_enrollments", "enrollment_id", "患者参保登记", "患者背景", "一患者一次参保资料登记", GK(28, 30),
                        [("patient_id", "TEXT NOT NULL", "患者键"), ("plan_code", "TEXT NOT NULL", "合成保险计划，不是医院医保协议"), ("valid_from", "TEXT NOT NULL", "登记有效开始日"), ("verification_status", "TEXT NOT NULL", "未核验登记不等于基金支付资格")], (_fk("patients", "patient_id"),))
    preference = b.table("patient_contact_preferences", "preference_id", "患者联络偏好", "患者背景", "一患者一类通知偏好", SH(93),
                         [("patient_id", "TEXT NOT NULL", "患者键"), ("channel_code", "TEXT NOT NULL", "通知渠道；不存地址和联系方式"), ("opt_in_flag", "INTEGER NOT NULL CHECK(opt_in_flag IN (0,1))", "是否同意通知")], (_fk("patients", "patient_id"),))
    allergy = b.table("patient_allergy_records", "allergy_record_id", "过敏史采集记录", "患者背景", "一患者一次过敏史询问", GK(17),
                      [("patient_id", "TEXT NOT NULL", "患者键"), ("recorded_at", "TEXT NOT NULL", "询问时间"), ("allergy_status", "TEXT NOT NULL", "UNKNOWN 表示未获确定答案，不能解释为无过敏"), ("substance_code", "TEXT", "过敏原，未知保持空")], (_fk("patients", "patient_id"),))
    risk = b.table("patient_risk_screenings", "screening_id", "患者风险初筛", "患者背景", "一患者一次通用风险问卷", QUALITY,
                   [("patient_id", "TEXT NOT NULL", "患者键"), ("screened_at", "TEXT NOT NULL", "初筛时间"), ("form_version", "TEXT NOT NULL", "合成初筛表版本"), ("review_status", "TEXT NOT NULL", "筛查状态，不是已发生不良事件")], (_fk("patients", "patient_id"),))
    merge = b.table("patient_merge_audits", "merge_audit_id", "患者主索引查重审核", "患者背景", "一患者一次查重审核", SH(93) + GK(1),
                    [("patient_id", "TEXT NOT NULL", "审核患者"), ("reviewed_at", "TEXT NOT NULL", "审核时间"), ("decision_code", "TEXT NOT NULL", "KEEP_SEPARATE 表示保持原主索引，不产生跨机构合并")], (_fk("patients", "patient_id"),))
    consent = b.table("patient_consent_records", "consent_id", "服务知情确认", "患者背景", "一患者一次服务知情确认", MANAGEMENT,
                      [("patient_id", "TEXT NOT NULL", "患者键"), ("document_version", "TEXT NOT NULL", "合成告知文本版本"), ("recorded_at", "TEXT NOT NULL", "记录时间"), ("consent_status", "TEXT NOT NULL", "确认状态")], (_fk("patients", "patient_id"),))
    first_seen = {}
    for row in b.read("outpatient_visits") + b.read("inpatient_stays"):
        key = row["institution_id"], row["patient_id"]
        stamp = row.get("registered_at") or row["admitted_at"]
        first_seen[key] = min(first_seen.get(key, stamp), stamp)
    for row in b.read("patients"):
        inst, pid = row["institution_id"], row["patient_id"]
        stamp = first_seen.get((inst, pid), "2025-01-01 00:00:00")
        identity(inst, f"{pid}_HIS", pid, "HIS", f"SYN_{pid}")
        demographics(inst, f"{pid}_VERIFY", pid, stamp, row["date_of_birth"], "RECORDED")
        insurance(inst, f"{pid}_PLAN", pid, "SYN_PLAN", stamp[:10], "PENDING")
        preference(inst, f"{pid}_CONTACT", pid, "IN_APP", 1)
        allergy(inst, f"{pid}_ALLERGY", pid, stamp, "UNKNOWN", None)
        risk(inst, f"{pid}_RISK", pid, stamp, "SYN_SCREEN_V1", "COLLECTED")
        merge(inst, f"{pid}_MERGE", pid, stamp, "KEEP_SEPARATE")
        consent(inst, f"{pid}_CONSENT", pid, "SYN_SERVICE_V1", stamp, "CONFIRMED")


def _outpatient(b: _Builder) -> None:
    """预约申请、状态日志、队列和收费回执分别建模；日志一对多不能当作就诊次数。"""
    metric = GK(1, 23, 38)
    session = b.table("clinic_sessions", "session_id", "门诊出诊时段", "门急诊流程", "一科室一个出诊日时段", metric,
                      [("department_id", "TEXT NOT NULL", "出诊科室"), ("session_date", "TEXT NOT NULL", "出诊日期"), ("session_code", "TEXT NOT NULL", "时段代码"), ("capacity", "INTEGER NOT NULL", "计划号源容量，不等于实际挂号数")], (_fk("departments", "department_id"),))
    channel = b.table("appointment_channels", "channel_id", "预约受理渠道", "门急诊流程", "一机构一个预约渠道", GK(23),
                      [("channel_name", "TEXT NOT NULL", "合成渠道名称"), ("enabled_flag", "INTEGER NOT NULL CHECK(enabled_flag IN (0,1))", "是否启用")])
    request = b.table("appointment_requests", "request_id", "预约申请单", "门急诊流程", "一就诊一次预约申请", GK(23),
                      [("visit_id", "TEXT NOT NULL", "目标就诊"), ("channel_id", "TEXT NOT NULL", "申请渠道"), ("requested_at", "TEXT NOT NULL", "申请提交时间；不是报到时间"), ("request_status", "TEXT NOT NULL", "申请处理状态")], (_fk("outpatient_visits", "visit_id"), _fk("appointment_channels", "channel_id")), "distractor")
    history = b.table("appointment_status_history", "status_change_id", "预约申请状态变更", "门急诊流程", "一预约申请一次状态变更", GK(23),
                      [("request_id", "TEXT NOT NULL", "预约申请"), ("changed_at", "TEXT NOT NULL", "变更发生时间"), ("from_status", "TEXT", "前状态"), ("to_status", "TEXT NOT NULL", "后状态"), ("sequence_no", "INTEGER NOT NULL", "申请内顺序号")], (_fk("appointment_requests", "request_id"),))
    queue = b.table("outpatient_queue_tickets", "queue_ticket_id", "门诊候诊队列票", "门急诊流程", "一就诊一次队列入列", GK(23),
                    [("visit_id", "TEXT NOT NULL", "目标就诊"), ("enqueued_at", "TEXT NOT NULL", "入列时间；不是预约事实的报到时间"), ("queue_status", "TEXT NOT NULL", "候诊队列状态")], (_fk("outpatient_visits", "visit_id"),), "distractor")
    triage = b.table("outpatient_triage_records", "triage_id", "门诊预检分诊", "门急诊流程", "一就诊一次预检分诊", metric,
                     [("visit_id", "TEXT NOT NULL", "挂号就诊"), ("triaged_at", "TEXT NOT NULL", "分诊时间"), ("destination_department_id", "TEXT", "建议去向科室"), ("triage_status", "TEXT NOT NULL", "分诊状态")], (_fk("outpatient_visits", "visit_id"), "FOREIGN KEY(institution_id,destination_department_id) REFERENCES departments(institution_id,department_id)"))
    consultation = b.table("outpatient_consultations", "consultation_id", "门诊接诊过程", "门急诊流程", "一就诊一次接诊过程", metric,
                           [("visit_id", "TEXT NOT NULL", "挂号就诊"), ("started_at", "TEXT", "实际接诊开始；未接诊为空"), ("completed_at", "TEXT", "实际接诊结束"), ("consultation_status", "TEXT NOT NULL", "接诊状态")], (_fk("outpatient_visits", "visit_id"),))
    receipt = b.table("outpatient_registration_receipts", "receipt_id", "挂号受理回执", "门急诊流程", "一挂号一受理回执", GK(1, 27, 38),
                      [("visit_id", "TEXT NOT NULL", "挂号就诊"), ("issued_at", "TEXT NOT NULL", "受理回执生成时间"), ("receipt_status", "TEXT NOT NULL", "回执状态；不是财务入账凭证"), ("document_kind", "TEXT NOT NULL", "非财务受理文书类型")], (_fk("outpatient_visits", "visit_id"),), "distractor")
    for row in b.read("institutions"):
        channel(row["institution_id"], "APP", "合成自助预约", 1)
    sessions = set()
    called_at = {}
    for row in b.read("appointment_events"):
        if row["appointment_kind_code"] == "REGISTRATION" and row["appointment_status_code"] == "SUCCESS" and row["called_at"]:
            key = row["institution_id"], row["visit_id"]
            called_at[key] = max(called_at.get(key, row["called_at"]), row["called_at"])
    for row in b.read("outpatient_visits"):
        inst, vid, stamp = row["institution_id"], row["visit_id"], row["registered_at"]
        dep = row["department_id"]
        key = (inst, dep, stamp[:10])
        if dep and key not in sessions:
            session(inst, f"{dep}_{stamp[:10]}", dep, stamp[:10], "ALL_DAY", 80)
            sessions.add(key)
        cancelled = row["visit_status_code"] == "CANCELLED"
        state = "CANCELLED" if cancelled else "ACCEPTED"
        request(inst, f"REQ_{vid}", vid, "APP", _time(stamp, -30), state)
        history(inst, f"{vid}_H1", f"REQ_{vid}", _time(stamp, -30), None, "SUBMITTED", 1)
        history(inst, f"{vid}_H2", f"REQ_{vid}", stamp, "SUBMITTED", state, 2)
        queue(inst, f"Q_{vid}", vid, stamp, "CANCELLED" if cancelled else "CLOSED")
        triage(inst, f"TR_{vid}", vid, stamp, dep, "CANCELLED" if cancelled else "RECORDED")
        # 已有挂号叫诊事实时先叫诊再接诊，避免支撑链与核心时间角色冲突。
        started = max(_time(stamp, 20), called_at.get((inst, vid), stamp))
        consultation(inst, f"CONS_{vid}", vid, None if cancelled else started, None if cancelled else _time(started, 15), "CANCELLED" if cancelled else "COMPLETED")
        receipt(inst, f"RCPT_{vid}", vid, stamp, "VOID" if cancelled else "ISSUED", "REGISTRATION_ACKNOWLEDGEMENT")


def _inpatient(b: _Builder) -> None:
    """住院申请、实际转科、床位分配和出院医嘱保留不同时间角色。"""
    metric = GK(1, 25, 40) + SH(3, 35, 93, 103)
    admission = b.table("admission_requests", "admission_request_id", "住院申请", "住院床位流程", "一次住院一张入院申请", metric,
                        [("stay_id", "TEXT NOT NULL", "关联住院"), ("requested_at", "TEXT NOT NULL", "申请时间；不是实际入院时间"), ("planned_flag", "INTEGER CHECK(planned_flag IN (0,1))", "是否计划入院，继承核心事实"), ("request_status", "TEXT NOT NULL", "申请处理状态")], (_fk("inpatient_stays", "stay_id"),), "distractor")
    transfer = b.table("inpatient_transfer_events", "transfer_event_id", "住院科室接收事件", "住院床位流程", "一次住院一次科室接收或转入", metric,
                       [("stay_id", "TEXT NOT NULL", "住院键"), ("from_department_id", "TEXT", "原科室，首次入院为空"), ("to_department_id", "TEXT NOT NULL", "接收科室"), ("transferred_at", "TEXT NOT NULL", "科室接收时间"), ("transfer_kind", "TEXT NOT NULL", "首次入院或院内转科")], (_fk("inpatient_stays", "stay_id"), "FOREIGN KEY(institution_id,from_department_id) REFERENCES departments(institution_id,department_id)", "FOREIGN KEY(institution_id,to_department_id) REFERENCES departments(institution_id,department_id)"))
    assignment = b.table("inpatient_bed_assignments", "bed_assignment_id", "住院分床申请", "住院床位流程", "一次住院一笔分床流程", SH(3, 35) + QUALITY,
                         [("stay_id", "TEXT NOT NULL", "住院键"), ("bed_id", "TEXT", "实际分配床位，尚未确认时为空"), ("requested_at", "TEXT NOT NULL", "分床申请时间"), ("assignment_status", "TEXT NOT NULL", "REQUESTED 不等于已占床")], (_fk("inpatient_stays", "stay_id"), _fk("location_beds", "bed_id")), "distractor")
    discharge = b.table("discharge_orders", "discharge_order_id", "出院医嘱", "住院床位流程", "一次住院一份出院医嘱流程", SH(35, 93) + GK(1),
                        [("stay_id", "TEXT NOT NULL", "住院键"), ("ordered_at", "TEXT", "医嘱时间；未出院为空"), ("actual_departed_at", "TEXT", "核心事实实际出院时间"), ("order_status", "TEXT NOT NULL", "完成或尚未开立")], (_fk("inpatient_stays", "stay_id"),), "distractor")
    followup = b.table("discharge_followup_tasks", "followup_task_id", "出院随访任务", "住院床位流程", "一次住院一个随访计划", SH(93),
                       [("stay_id", "TEXT NOT NULL", "住院键"), ("scheduled_at", "TEXT", "随访计划时间；未出院为空"), ("task_status", "TEXT NOT NULL", "计划状态，不是假定已经再入院")], (_fk("inpatient_stays", "stay_id"),))
    home = b.table("home_bed_service_plans", "home_service_plan_id", "家庭病床服务评估", "住院床位流程", "一次住院一次家庭病床适用性评估", GK(1) + SH(3),
                   [("stay_id", "TEXT NOT NULL", "住院键"), ("assessed_at", "TEXT NOT NULL", "评估时间"), ("plan_status", "TEXT NOT NULL", "核心家庭病床标记对应的服务或不适用状态")], (_fk("inpatient_stays", "stay_id"),))
    cleaning = b.table("bed_cleaning_tasks", "cleaning_task_id", "床位清洁计划", "住院床位流程", "一物理床位一例行清洁计划", SH(3) + ["met.qc-haiqi-03"],
                       [("bed_id", "TEXT NOT NULL", "物理床位"), ("scheduled_on", "TEXT NOT NULL", "例行清洁日期"), ("task_status", "TEXT NOT NULL", "计划状态，不能据此减少实际开放床位")], (_fk("location_beds", "bed_id"),))
    shifts = b.table("ward_nursing_shifts", "nursing_shift_id", "病区护理班次", "住院床位流程", "一护理单元一个排班班次", QUALITY,
                     [("nursing_unit_id", "TEXT NOT NULL", "护理单元"), ("shift_date", "TEXT NOT NULL", "班次日期"), ("shift_code", "TEXT NOT NULL", "排班时段"), ("planned_staff_count", "INTEGER NOT NULL", "计划人数，单位人")], (_fk("nursing_units", "nursing_unit_id"),))
    dates = defaultdict(set)
    census = defaultdict(list)
    for row in b.read("inpatient_census_days"):
        if row["department_id"]:
            census[row["institution_id"], row["stay_id"]].append(row)
    for row in b.read("inpatient_stays"):
        inst, sid = row["institution_id"], row["stay_id"]
        dates[inst].add(row["admitted_at"][:10])
        admission(inst, f"ADM_{sid}", sid, _time(row["admitted_at"], -60), row["planned_admission_flag"], "ADMITTED")
        dep = row["admit_department_id"]
        if dep:
            transfer(inst, f"TR_{sid}_1", sid, None, dep, row["admitted_at"], "ADMISSION")
        # 有占床日时按其科室变化生成接收事件；只知道出院科室时不倒推出更早转科时刻。
        sequence = 1
        for day in sorted(census[inst, sid], key=lambda item: item["census_date"]):
            target = day["department_id"]
            if target != dep:
                sequence += 1
                stamp = max(row["admitted_at"], day["census_date"] + " 00:00:00")
                transfer(inst, f"TR_{sid}_{sequence}", sid, dep, target, stamp, "INTERNAL_TRANSFER")
                dep = target
        target = row["discharge_department_id"]
        if target and target != dep and row["discharged_at"]:
            sequence += 1
            transfer(inst, f"TR_{sid}_{sequence}", sid, dep, target, row["discharged_at"], "DISCHARGE_HANDOVER")
        assignment(inst, f"BA_{sid}", sid, None, row["admitted_at"], "NOT_APPLICABLE" if row["home_bed_flag"] else "REQUESTED")
        end = row["discharged_at"]
        discharge(inst, f"DC_{sid}", sid, max(row["admitted_at"], _time(end, -30)) if end else None, end, "COMPLETED" if end else "NOT_ORDERED")
        deceased = row["discharge_disposition_code"] == "DEATH"
        followup(inst, f"FU_{sid}", sid, _time(end, 7 * 1440) if end and not deceased else None, "NOT_APPLICABLE_DEATH" if deceased else "SCHEDULED" if end else "AWAITING_DISCHARGE")
        home(inst, f"HOME_{sid}", sid, row["admitted_at"], "ACTIVE" if row["home_bed_flag"] else "NOT_APPLICABLE")
    for row in b.read("location_beds"):
        inst = row["institution_id"]
        cleaning(inst, f"CLEAN_{row['bed_id']}", row["bed_id"], min(dates[inst], default="2025-01-01"), "SCHEDULED")
    for row in b.read("nursing_units"):
        inst = row["institution_id"]
        shifts(inst, f"SHIFT_{row['nursing_unit_id']}", row["nursing_unit_id"], min(dates[inst], default="2025-01-01"), "DAY", 3)


def _surgery(b: _Builder) -> None:
    """手术排程与实际操作分开，麻醉和切口观察只附着已存在的操作事实。"""
    room = b.table("operating_rooms", "operating_room_id", "手术间资源", "手术麻醉", "一机构一手术间", SURGERY,
                   [("building_id", "TEXT NOT NULL", "所在建筑"), ("room_name", "TEXT NOT NULL", "合成手术间名称"), ("resource_status", "TEXT NOT NULL", "手术间资源状态")], (_fk("hospital_buildings", "building_id"),))
    request = b.table("surgery_requests", "surgery_request_id", "手术申请", "手术麻醉", "一次实际操作对应一份申请", SURGERY,
                      [("procedure_id", "TEXT NOT NULL", "实际操作键"), ("requested_at", "TEXT NOT NULL", "申请时间；不是手术执行时间"), ("request_status", "TEXT NOT NULL", "申请状态")], (_fk("inpatient_procedures", "procedure_id"),), "distractor")
    schedule = b.table("surgery_schedule_versions", "schedule_version_id", "手术排程版本", "手术麻醉", "一申请一个排程版本", SURGERY,
                       [("surgery_request_id", "TEXT NOT NULL", "手术申请"), ("operating_room_id", "TEXT NOT NULL", "计划手术间"), ("version_no", "INTEGER NOT NULL", "排程版本号"), ("scheduled_at", "TEXT NOT NULL", "计划开台时间"), ("version_status", "TEXT NOT NULL", "已替代或最终排程")], (_fk("surgery_requests", "surgery_request_id"), _fk("operating_rooms", "operating_room_id")), "distractor")
    evaluation = b.table("anesthesia_evaluations", "anesthesia_evaluation_id", "麻醉术前评估", "手术麻醉", "一操作一次麻醉适用性评估", SURGERY,
                         [("procedure_id", "TEXT NOT NULL", "实际操作键"), ("evaluated_at", "TEXT NOT NULL", "术前评估时间"), ("anesthesia_required_flag", "INTEGER CHECK(anesthesia_required_flag IN (0,1))", "是否需要麻醉，来自核心事实"), ("assessment_status", "TEXT NOT NULL", "评估记录状态")], (_fk("inpatient_procedures", "procedure_id"),))
    observation = b.table("anesthesia_observations", "anesthesia_observation_id", "麻醉观察流程", "手术麻醉", "一操作一次麻醉观察登记", GK(8, 9),
                          [("procedure_id", "TEXT NOT NULL", "实际操作键"), ("observed_at", "TEXT", "观察时间；无需麻醉为空"), ("pulse_per_minute", "INTEGER", "合成脉搏值，单位次/分；非临床参考"), ("observation_status", "TEXT NOT NULL", "已记录或不适用")], (_fk("inpatient_procedures", "procedure_id"),))
    check = b.table("surgery_safety_checks", "safety_check_id", "手术安全核查", "手术麻醉", "一操作一个安全核查节点", SURGERY,
                    [("procedure_id", "TEXT NOT NULL", "实际操作键"), ("checked_at", "TEXT NOT NULL", "核查时间"), ("check_stage", "TEXT NOT NULL", "核查节点"), ("check_status", "TEXT NOT NULL", "核查完成状态")], (_fk("inpatient_procedures", "procedure_id"),))
    coding = b.table("procedure_coding_reviews", "coding_review_id", "操作编码复核", "手术麻醉", "一操作一次编码复核", SURGERY,
                     [("procedure_id", "TEXT NOT NULL", "实际操作键"), ("code_system", "TEXT", "原编码体系"), ("code_edition", "TEXT", "原编码版本"), ("reviewed_at", "TEXT NOT NULL", "复核时间"), ("review_status", "TEXT NOT NULL", "仅复核录入，不认定进入正式指标目录")], (_fk("inpatient_procedures", "procedure_id"),))
    wound = b.table("wound_assessments", "wound_assessment_id", "切口随访观察", "手术麻醉", "一操作一次切口观察", GK(9),
                    [("procedure_id", "TEXT NOT NULL", "实际操作键"), ("assessed_at", "TEXT NOT NULL", "观察时间"), ("incision_class_code", "TEXT", "切口分类，继承核心事实"), ("healing_grade_code", "TEXT", "愈合等级，缺失不推测"), ("review_status", "TEXT NOT NULL", "观察资料登记状态")], (_fk("inpatient_procedures", "procedure_id"),))
    stays = {(r["institution_id"], r["stay_id"]): r for r in b.read("inpatient_stays")}
    for row in b.read("institutions"):
        room(row["institution_id"], "OR_01", "BL_INPATIENT", "合成第 1 手术间", "AVAILABLE")
    room_counts = defaultdict(lambda: 1)
    simultaneous = defaultdict(int)
    for row in b.read("inpatient_procedures"):
        inst, pid = row["institution_id"], row["procedure_id"]
        stay = stays[inst, row["stay_id"]]
        performed = row["performed_at"] or stay["admitted_at"]
        before = max(stay["admitted_at"], _time(performed, -60))
        # 同一机构同期开台分配不同手术间，避免固定一个房间造成资源重复占用。
        simultaneous[inst, performed] += 1
        room_number = simultaneous[inst, performed]
        if room_number > room_counts[inst]:
            room(inst, f"OR_{room_number:02d}", "BL_INPATIENT", f"合成第 {room_number} 手术间", "AVAILABLE")
            room_counts[inst] = room_number
        room_id = f"OR_{room_number:02d}"
        request(inst, f"SURG_{pid}", pid, before, "COMPLETED")
        schedule(inst, f"{pid}_SV1", f"SURG_{pid}", room_id, 1, _time(performed, 30), "SUPERSEDED")
        schedule(inst, f"{pid}_SV2", f"SURG_{pid}", room_id, 2, performed, "FINAL")
        evaluation(inst, f"AE_{pid}", pid, before, row["anesthesia_flag"], "RECORDED")
        needs = row["anesthesia_flag"] == 1
        observation(inst, f"AO_{pid}", pid, performed if needs else None, b.random.randint(65, 90) if needs else None, "RECORDED" if needs else "NOT_APPLICABLE")
        check(inst, f"SC_{pid}", pid, performed, "BEFORE_PROCEDURE", "CONFIRMED")
        coding(inst, f"CR_{pid}", pid, row["code_system"], row["code_edition"], performed, "RECORDED")
        wound(inst, f"WA_{pid}", pid, performed, row["incision_class_code"], row["wound_healing_grade_code"], "RECORDED")


def _quality(b: _Builder) -> None:
    """风险筛查、主动监测、送检及已上报事件的状态分离；阴性/待核不等于院感事件。"""
    report = b.table("clinical_event_reports", "event_report_id", "住院安全事件筛查表", "护理院感", "一次住院一份安全事件筛查报告", QUALITY,
                     [("stay_id", "TEXT NOT NULL", "住院键"), ("event_id", "TEXT", "若有核心事件则关联；无事件不虚构"), ("reported_at", "TEXT NOT NULL", "报告时间"), ("report_status", "TEXT NOT NULL", "EVENT_REPORTED 或 NO_EVENT_RECORDED")], (_fk("inpatient_stays", "stay_id"), _fk("clinical_events", "event_id")))
    action = b.table("incident_review_actions", "review_action_id", "安全报告审核动作", "护理院感", "一筛查报告一次审核动作", QUALITY,
                     [("event_report_id", "TEXT NOT NULL", "安全筛查报告"), ("reviewed_at", "TEXT NOT NULL", "审核时间"), ("action_code", "TEXT NOT NULL", "资料审核动作，不修改原核心判定")], (_fk("clinical_event_reports", "event_report_id"),))
    fall = b.table("fall_risk_assessments", "fall_risk_id", "跌倒风险筛查", "护理院感", "一次住院一次跌倒风险筛查", ["met.qc-nqi-07"],
                   [("stay_id", "TEXT NOT NULL", "住院键"), ("assessed_at", "TEXT NOT NULL", "风险评估时间"), ("form_version", "TEXT NOT NULL", "合成筛查表版本"), ("risk_category", "TEXT NOT NULL", "风险类别，不代表已经跌倒")], (_fk("inpatient_stays", "stay_id"),), "distractor")
    pressure = b.table("pressure_injury_screenings", "pressure_screening_id", "压力性损伤风险筛查", "护理院感", "一次住院一次皮肤风险筛查", ["met.qc-nqi-08"],
                       [("stay_id", "TEXT NOT NULL", "住院键"), ("screened_at", "TEXT NOT NULL", "筛查时间"), ("assessment_status", "TEXT NOT NULL", "需进一步评估，不替代损伤分期"), ("form_version", "TEXT NOT NULL", "合成表单版本")], (_fk("inpatient_stays", "stay_id"),), "distractor")
    surveillance = b.table("infection_surveillance_reviews", "surveillance_review_id", "院感主动监测审核", "护理院感", "一次住院一次监测资料审核", ["met.qc-haiqi-03"] + GK(9),
                           [("stay_id", "TEXT NOT NULL", "住院键"), ("reviewed_at", "TEXT NOT NULL", "监测审核时间"), ("review_status", "TEXT NOT NULL", "仅监测状态，不是院内感染确诊"), ("rule_version", "TEXT NOT NULL", "合成监测流程版本")], (_fk("inpatient_stays", "stay_id"),))
    order = b.table("infection_specimen_orders", "specimen_order_id", "感染筛查检验申请", "护理院感", "一次住院一份感染筛查申请", ["met.qc-haiqi-03"] + GK(9, 17),
                    [("stay_id", "TEXT NOT NULL", "住院键"), ("ordered_at", "TEXT NOT NULL", "检验申请时间"), ("test_code", "TEXT NOT NULL", "合成检查代码"), ("order_status", "TEXT NOT NULL", "检验申请状态")], (_fk("inpatient_stays", "stay_id"),))
    specimen = b.table("laboratory_specimens", "specimen_id", "实验室标本", "护理院感", "一检验申请一份标本", ["met.qc-haiqi-03"] + GK(9),
                       [("specimen_order_id", "TEXT NOT NULL", "检验申请"), ("collected_at", "TEXT NOT NULL", "采样时间"), ("specimen_kind", "TEXT NOT NULL", "合成标本类型"), ("received_at", "TEXT NOT NULL", "实验室接收时间")], (_fk("infection_specimen_orders", "specimen_order_id"),))
    result = b.table("microbiology_results", "microbiology_result_id", "微生物培养原始结果", "护理院感", "一标本一个结果版本", ["met.qc-haiqi-03"] + GK(9, 17),
                     [("specimen_id", "TEXT NOT NULL", "标本键"), ("reported_at", "TEXT NOT NULL", "结果报告时间"), ("result_status", "TEXT NOT NULL", "结果状态"), ("organism_code", "TEXT", "未检出时为空；不能据此替代院感判定"), ("result_version", "INTEGER NOT NULL", "报告版本")], (_fk("laboratory_specimens", "specimen_id"),))
    events = {}
    for row in b.read("clinical_events"):
        events.setdefault((row["institution_id"], row["stay_id"]), row)
    for row in b.read("inpatient_stays"):
        inst, sid = row["institution_id"], row["stay_id"]
        event = events.get((inst, sid))
        stamp = (event.get("occurred_at") if event else None) or _during(row, 60)
        report(inst, f"ER_{sid}", sid, event["event_id"] if event else None, stamp, "EVENT_REPORTED" if event else "NO_EVENT_RECORDED")
        action(inst, f"EA_{sid}", f"ER_{sid}", stamp, "SOURCE_RECORD_REVIEW")
        fall(inst, f"FR_{sid}", sid, _during(row, 10), "SYN_FALL_V1", "REVIEW_REQUIRED")
        pressure(inst, f"PR_{sid}", sid, _during(row, 10), "SCREENED", "SYN_SKIN_V1")
        surveillance(inst, f"IS_{sid}", sid, _during(row, 120), "RECORD_REVIEWED", "SYN_SURVEILLANCE_V1")
        order(inst, f"IO_{sid}", sid, _during(row, 30), "SYN_CULTURE", "COMPLETED")
        specimen(inst, f"SP_{sid}", f"IO_{sid}", _during(row, 40), "SYN_SWAB", _during(row, 50))
        result(inst, f"MR_{sid}", f"SP_{sid}", _during(row, 180), "NO_GROWTH", None, 1)


def _pharmacy(b: _Builder) -> None:
    """独立药事链表达医嘱、发药、退药和库存；发药量不能冒充核心实际消耗量。"""
    metrics = GK(17, 32, 56) + SH(51)
    product = b.table("drug_products", "product_id", "院内药品商品档案", "药事供应", "一机构一个药品商品", metrics,
                      [("product_name", "TEXT NOT NULL", "合成药品名称，非临床用药建议"), ("local_drug_code", "TEXT NOT NULL", "院内合成商品编码"), ("dose_unit", "TEXT NOT NULL", "单次发药计量单位"), ("catalog_version", "TEXT NOT NULL", "本院商品目录版本，非 DDD 版本")])
    batch = b.table("drug_batches", "batch_id", "药品库存批次", "药事供应", "一药品一个库存批次", metrics,
                    [("product_id", "TEXT NOT NULL", "药品商品"), ("received_on", "TEXT NOT NULL", "收货日期"), ("expires_on", "TEXT NOT NULL", "库存有效期"), ("batch_status", "TEXT NOT NULL", "库存批次状态")], (_fk("drug_products", "product_id"),))
    order = b.table("medication_orders", "medication_order_id", "住院用药医嘱", "药事供应", "一次住院一份合成用药医嘱", GK(17),
                    [("stay_id", "TEXT NOT NULL", "住院键"), ("ordered_at", "TEXT NOT NULL", "医嘱开立时间，非消耗时间"), ("order_status", "TEXT NOT NULL", "医嘱状态，不证明已经给药")], (_fk("inpatient_stays", "stay_id"),), "distractor")
    line = b.table("medication_order_lines", "medication_order_line_id", "用药医嘱明细", "药事供应", "一医嘱一药品项目", GK(17),
                   [("medication_order_id", "TEXT NOT NULL", "用药医嘱"), ("product_id", "TEXT NOT NULL", "药品商品"), ("ordered_quantity", "REAL NOT NULL CHECK(ordered_quantity>0)", "医嘱计划数量"), ("quantity_unit", "TEXT NOT NULL", "数量单位")], (_fk("medication_orders", "medication_order_id"), _fk("drug_products", "product_id")), "distractor")
    dispense = b.table("pharmacy_dispense_records", "dispense_id", "药房发药记录", "药事供应", "一医嘱明细一次药房发出", GK(17, 32),
                       [("medication_order_line_id", "TEXT NOT NULL", "医嘱明细"), ("batch_id", "TEXT NOT NULL", "发出药品批次"), ("dispensed_at", "TEXT NOT NULL", "药房发药时间"), ("quantity", "REAL NOT NULL CHECK(quantity>0)", "发出数量，不等于患者实际消耗"), ("quantity_unit", "TEXT NOT NULL", "发药单位")], (_fk("medication_order_lines", "medication_order_line_id"), _fk("drug_batches", "batch_id")), "distractor")
    returned = b.table("medication_returns", "medication_return_id", "药品退库记录", "药事供应", "一发药记录一次未使用退库", GK(17, 32),
                       [("dispense_id", "TEXT NOT NULL", "原发药记录"), ("returned_at", "TEXT NOT NULL", "退药时间"), ("quantity", "REAL NOT NULL CHECK(quantity>0)", "退回未使用数量"), ("quantity_unit", "TEXT NOT NULL", "退药单位"), ("reason_code", "TEXT NOT NULL", "合成退药原因")], (_fk("pharmacy_dispense_records", "dispense_id"),))
    inventory = b.table("pharmacy_inventory_movements", "inventory_movement_id", "药房批次库存移动", "药事供应", "一药品批次一次库存增减", metrics,
                        [("batch_id", "TEXT NOT NULL", "库存批次"), ("moved_at", "TEXT NOT NULL", "库存动作时间"), ("movement_kind", "TEXT NOT NULL", "入库、发药或退库"), ("quantity_delta", "REAL NOT NULL", "带正负号数量变化"), ("quantity_unit", "TEXT NOT NULL", "库存单位"), ("dispense_id", "TEXT", "发药或对应退库的原发药记录")], (_fk("drug_batches", "batch_id"), _fk("pharmacy_dispense_records", "dispense_id")))
    conversion = b.table("drug_unit_conversions", "unit_conversion_id", "药品包装单位换算", "药事供应", "一商品一个有效换算版本", GK(17),
                         [("product_id", "TEXT NOT NULL", "药品商品"), ("from_unit", "TEXT NOT NULL", "原包装单位"), ("to_unit", "TEXT NOT NULL", "目标剂量单位"), ("conversion_factor", "REAL NOT NULL CHECK(conversion_factor>0)", "目标单位数量/原单位；不是 DDD 数量"), ("conversion_version", "TEXT NOT NULL", "合成换算版本")], (_fk("drug_products", "product_id"),), "distractor")
    stays = b.read("inpatient_stays")
    counts = defaultdict(int)
    earliest = {}
    for row in stays:
        inst = row["institution_id"]
        counts[inst] += 1
        earliest[inst] = min(earliest.get(inst, row["admitted_at"]), row["admitted_at"])
    for row in b.read("institutions"):
        inst = row["institution_id"]
        stamp = earliest.get(inst, "2025-01-01 00:00:00")
        product(inst, "SYN_PRODUCT_A", "合成药品甲", "SYN_LOCAL_A", "tablet", "SYN_LOCAL_V1")
        batch(inst, "BATCH_A", "SYN_PRODUCT_A", _time(stamp, -1440)[:10], _time(stamp, 3 * 366 * 1440)[:10], "AVAILABLE")
        conversion(inst, "BOX_TO_TABLET", "SYN_PRODUCT_A", "box", "tablet", 10, "SYN_PACK_V1")
        inventory(inst, "STOCK_INITIAL", "BATCH_A", _time(stamp, -1440), "RECEIPT", max(100, counts[inst] * 10), "tablet", None)
    for row in stays:
        inst, sid = row["institution_id"], row["stay_id"]
        order(inst, f"MO_{sid}", sid, _during(row, 15), "CLOSED" if row["discharged_at"] else "ACTIVE")
        line(inst, f"ML_{sid}", f"MO_{sid}", "SYN_PRODUCT_A", 6, "tablet")
        dispense(inst, f"DP_{sid}", f"ML_{sid}", "BATCH_A", _during(row, 20), 6, "tablet")
        returned(inst, f"RT_{sid}", f"DP_{sid}", _during(row, 90), 1, "tablet", "UNUSED_ORDER_ADJUSTMENT")
        inventory(inst, f"OUT_{sid}", "BATCH_A", _during(row, 20), "DISPENSE", -6, "tablet", f"DP_{sid}")
        inventory(inst, f"IN_{sid}", "BATCH_A", _during(row, 90), "RETURN", 1, "tablet", f"DP_{sid}")


def _finance(b: _Builder) -> None:
    """凭证、基金申请、能耗计量与资产在册各有粒度；草稿凭证和申请不是核心入账事实。"""
    period = b.table("accounting_periods", "accounting_period_id", "会计期间", "财务医保能源", "一机构一个自然月会计期间", FINANCE,
                     [("period_start", "TEXT NOT NULL", "期间开始日期"), ("period_end", "TEXT NOT NULL", "期间末日期"), ("period_status", "TEXT NOT NULL", "合成会计期间状态")])
    voucher = b.table("financial_vouchers", "voucher_id", "记账凭证单据", "财务医保能源", "一机构一凭证单据", FINANCE,
                      [("accounting_period_id", "TEXT NOT NULL", "归属会计期间"), ("voucher_date", "TEXT NOT NULL", "制单日期，不等于实际入账日期"), ("voucher_status", "TEXT NOT NULL", "POSTED 或 DRAFT；草稿不构成入账"), ("currency_code", "TEXT NOT NULL", "币种")], (_fk("accounting_periods", "accounting_period_id"),), "distractor")
    line = b.table("financial_voucher_lines", "voucher_line_id", "记账凭证明细", "财务医保能源", "一凭证一来源分录或待填明细", FINANCE,
                   [("voucher_id", "TEXT NOT NULL", "凭证单据"), ("entry_id", "TEXT", "对应核心已入账分录；未入账为空"), ("account_code", "TEXT", "来源科目，未填写为空"), ("amount_yuan", "NUMERIC", "来源分录金额，未入账不虚构金额"), ("line_status", "TEXT NOT NULL", "已引用或待填")], (_fk("financial_vouchers", "voucher_id"), _fk("financial_entries", "entry_id")), "distractor")
    claim = b.table("insurance_claims", "insurance_claim_id", "门诊医保申报申请", "财务医保能源", "一门诊一次医保申报草稿", GK(28, 30),
                    [("visit_id", "TEXT NOT NULL", "门诊就诊"), ("submitted_at", "TEXT", "提交时间；草稿为空"), ("claim_status", "TEXT NOT NULL", "DRAFT 不等于医保已结算"), ("requested_fund_amount_yuan", "NUMERIC", "未核定申请金额保持空")], (_fk("outpatient_visits", "visit_id"),), "distractor")
    claim_history = b.table("insurance_claim_status_history", "claim_status_change_id", "医保申请处理日志", "财务医保能源", "一申报一次状态变化", GK(28, 30),
                            [("insurance_claim_id", "TEXT NOT NULL", "申报申请"), ("changed_at", "TEXT NOT NULL", "状态生成时间"), ("status_code", "TEXT NOT NULL", "申请状态"), ("response_code", "TEXT", "未发送时无医保平台响应")], (_fk("insurance_claims", "insurance_claim_id"),))
    meter = b.table("energy_meters", "meter_id", "能源计量设备", "财务医保能源", "一建筑一计量设备", GK(34),
                    [("building_id", "TEXT NOT NULL", "建筑归属"), ("energy_kind_code", "TEXT NOT NULL", "计量能源类型"), ("reading_unit", "TEXT NOT NULL", "累计读数单位"), ("installed_on", "TEXT NOT NULL", "安装日期")], (_fk("hospital_buildings", "building_id"),))
    reading = b.table("energy_meter_readings", "meter_reading_id", "能源设备累计读数", "财务医保能源", "一计量设备一次抄表", GK(34),
                      [("meter_id", "TEXT NOT NULL", "计量设备"), ("read_at", "TEXT NOT NULL", "抄表时间"), ("cumulative_quantity", "REAL NOT NULL", "累计表盘值，不是本期消耗量"), ("reading_unit", "TEXT NOT NULL", "读数单位"), ("reading_status", "TEXT NOT NULL", "抄表校验状态")], (_fk("energy_meters", "meter_id"),), "distractor")
    asset = b.table("asset_register", "asset_id", "固定资产卡片", "财务医保能源", "一机构一在册资产", GK(36) + SH(43, 44),
                    [("building_id", "TEXT NOT NULL", "资产放置建筑"), ("asset_category", "TEXT NOT NULL", "资产分类，不替代正式余额分类"), ("acquired_on", "TEXT NOT NULL", "购置日期"), ("original_cost_yuan", "NUMERIC NOT NULL", "原始购置价，非期末净值"), ("asset_status", "TEXT NOT NULL", "资产使用状态")], (_fk("hospital_buildings", "building_id"),), "distractor")
    dates = defaultdict(set)
    for row in b.read("financial_entries"):
        dates[row["institution_id"]].add(row["accounting_date"][:7])
    for row in b.read("balance_snapshots"):
        dates[row["institution_id"]].add(row["snapshot_date"][:7])
    for row in b.read("outpatient_visits"):
        dates[row["institution_id"]].add(row["registered_at"][:7])
    for row in b.read("institutions"):
        inst = row["institution_id"]
        months = sorted(dates[inst] or {"2025-01"})
        for month in months:
            start = datetime.fromisoformat(f"{month}-01")
            end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
            period(inst, month, start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"), "OPEN")
        day = months[0] + "-01"
        voucher(inst, "DRAFT_OPENING", months[0], day, "DRAFT", "CNY")
        line(inst, "DRAFT_OPENING_1", "DRAFT_OPENING", None, None, None, "PENDING_INPUT")
        meter(inst, "ELECTRIC_MAIN", "BL_INPATIENT", "SYN_ELECTRICITY", "kWh", "2020-01-01")
        reading(inst, "ELECTRIC_START", "ELECTRIC_MAIN", day + " 00:00:00", 1000, "kWh", "VALIDATED")
        reading(inst, "ELECTRIC_END", "ELECTRIC_MAIN", _time(day, 1440), 1000 + b.random.randint(100, 300), "kWh", "VALIDATED")
        asset(inst, "SYN_MONITOR", "BL_INPATIENT", "SYN_MEDICAL_DEVICE", "2024-01-01", 8000, "IN_USE")
    for row in b.read("financial_entries"):
        inst, eid = row["institution_id"], row["entry_id"]
        voucher(inst, f"V_{eid}", row["accounting_date"][:7], row["accounting_date"], "POSTED", "CNY")
        line(inst, f"VL_{eid}", f"V_{eid}", eid, row["account_code"], row["amount_yuan"], "SOURCE_REFERENCED")
    for row in b.read("outpatient_visits"):
        inst, vid = row["institution_id"], row["visit_id"]
        claim(inst, f"CL_{vid}", vid, None, "DRAFT", None)
        claim_history(inst, f"CH_{vid}", f"CL_{vid}", row["registered_at"], "DRAFT", None)


def _staff_acute(b: _Builder) -> None:
    """人员名册之外保留排班/培训；重症申请和设备不冒充 ICU 实际收治片段。"""
    staff = b.table("personnel_profiles", "personnel_id", "人事基础档案", "人员重症急诊", "一机构一人员档案", GK(25, 33),
                    [("synthetic_staff_label", "TEXT NOT NULL", "合成员工称谓，不含真实姓名"), ("employment_type", "TEXT NOT NULL", "用工类型"), ("staff_status", "TEXT NOT NULL", "在岗状态，不能代替年度执业医师资格")])
    assignment = b.table("clinician_department_assignments", "staff_assignment_id", "人员科室岗位关系", "人员重症急诊", "一人员一个有效岗位版本", GK(25, 33),
                         [("personnel_id", "TEXT NOT NULL", "人员档案"), ("department_id", "TEXT NOT NULL", "岗位所在科室"), ("valid_from", "TEXT NOT NULL", "岗位起始日"), ("assignment_role", "TEXT NOT NULL", "合成岗位角色")], (_fk("personnel_profiles", "personnel_id"), _fk("departments", "department_id")))
    training = b.table("clinician_training_records", "training_record_id", "人员继续教育记录", "人员重症急诊", "一人员一次继续教育活动", GK(25, 33),
                       [("personnel_id", "TEXT NOT NULL", "人员档案"), ("course_code", "TEXT NOT NULL", "合成继续教育课程；非规范化培训资格"), ("completed_on", "TEXT NOT NULL", "完成日期"), ("duration_hours", "REAL NOT NULL", "学时，单位小时")], (_fk("personnel_profiles", "personnel_id"),), "distractor")
    shift = b.table("staff_shift_assignments", "staff_shift_id", "人员排班计划", "人员重症急诊", "一岗位一天一个班次", GK(25, 33),
                    [("staff_assignment_id", "TEXT NOT NULL", "有效岗位关系"), ("shift_on", "TEXT NOT NULL", "排班日期"), ("shift_code", "TEXT NOT NULL", "班次类型"), ("attendance_status", "TEXT NOT NULL", "计划排班不等于实际出勤")], (_fk("clinician_department_assignments", "staff_assignment_id"),))
    transfer = b.table("icu_transfer_requests", "icu_transfer_request_id", "ICU 会诊转入申请", "人员重症急诊", "一次住院一次 ICU 适用性会诊申请", ["met.qc-icu-11"],
                       [("stay_id", "TEXT NOT NULL", "住院键"), ("requested_at", "TEXT NOT NULL", "申请时间，非 ICU 实际进入时间"), ("request_status", "TEXT NOT NULL", "申请状态，不能据此增加 ICU 人次"), ("icu_episode_id", "TEXT", "实际收治片段，仅存在时引用")], (_fk("inpatient_stays", "stay_id"), _fk("icu_episodes", "icu_episode_id")), "distractor")
    device = b.table("icu_device_inventory", "icu_device_id", "重症设备资源", "人员重症急诊", "一机构一重症设备", ["met.qc-icu-11"],
                     [("asset_id", "TEXT NOT NULL", "固定资产卡片"), ("device_kind", "TEXT NOT NULL", "重症设备种类"), ("calibration_version", "TEXT NOT NULL", "校准版本"), ("device_status", "TEXT NOT NULL", "设备状态")], (_fk("asset_register", "asset_id"),))
    triage = b.table("emergency_triage_assessments", "emergency_triage_id", "急诊分级预检记录", "人员重症急诊", "一门急诊一次抢救适用性预检", ["met.qc-em-03"],
                     [("visit_id", "TEXT NOT NULL", "就诊键"), ("assessed_at", "TEXT NOT NULL", "预检时间，非抢救室进入时间"), ("triage_status", "TEXT NOT NULL", "急诊已分诊或非急诊不适用"), ("triage_level", "TEXT", "合成急诊等级；不适用为空")], (_fk("outpatient_visits", "visit_id"),), "distractor")
    rescue = b.table("emergency_rescue_orders", "rescue_order_id", "抢救室接收申请", "人员重症急诊", "一就诊一份抢救室接收适用性记录", ["met.qc-em-03"],
                     [("visit_id", "TEXT NOT NULL", "就诊键"), ("requested_at", "TEXT NOT NULL", "接收申请时间"), ("order_status", "TEXT NOT NULL", "实际接收、待审核或不适用"), ("rescue_episode_id", "TEXT", "实际抢救片段，仅存在时引用")], (_fk("outpatient_visits", "visit_id"), _fk("emergency_rescue_episodes", "rescue_episode_id")), "distractor")
    for row in b.read("institutions"):
        inst = row["institution_id"]
        device(inst, "ICU_MONITOR", "SYN_MONITOR", "MONITOR", "SYN_CAL_V1", "READY")
    for row in b.read("departments"):
        inst, dep = row["institution_id"], row["department_id"]
        # 每科室独立合成人员，避免一人同一天被排到所有科室的重叠班次。
        staff(inst, f"STAFF_{dep}", f"合成{row['department_name']}职员", "EMPLOYEE", "ACTIVE")
        training(inst, f"TRAIN_{dep}", f"STAFF_{dep}", "SYN_SAFETY_CONTINUING_ED", "2025-01-01", 4)
        assignment(inst, f"JOB_{dep}", f"STAFF_{dep}", dep, "2020-01-01", "SUPPORT")
        shift(inst, f"SHIFT_{dep}", f"JOB_{dep}", "2025-01-01", "DAY", "PLANNED")
    icu = {(r["institution_id"], r["stay_id"]): r for r in b.read("icu_episodes")}
    for row in b.read("inpatient_stays"):
        inst, sid = row["institution_id"], row["stay_id"]
        episode = icu.get((inst, sid))
        transfer(inst, f"ICUR_{sid}", sid, min(_during(row, 30), episode["icu_entered_at"]) if episode else _during(row, 30), "ADMITTED" if episode else "REVIEW_PENDING", episode["icu_episode_id"] if episode else None)
    rescues = {(r["institution_id"], r["visit_id"]): r for r in b.read("emergency_rescue_episodes")}
    for row in b.read("outpatient_visits"):
        inst, vid = row["institution_id"], row["visit_id"]
        is_emergency = row["care_setting_code"] == "EMERGENCY"
        episode = rescues.get((inst, vid))
        triage(inst, f"ET_{vid}", vid, row["registered_at"], "ASSESSED" if is_emergency else "NOT_APPLICABLE", "SYN_LEVEL_3" if is_emergency else None)
        rescue(inst, f"ERQ_{vid}", vid, min(row["registered_at"], episode["entered_at"]) if episode else row["registered_at"], "RECEIVED" if episode else "REVIEW_PENDING" if is_emergency else "NOT_APPLICABLE", episode["rescue_episode_id"] if episode else None)


def _management(b: _Builder) -> None:
    """管理材料、预算审批和信息系统版本是过程证据，不生成外部质控成绩或评审得分。"""
    document = b.table("management_document_versions", "document_version_id", "管理材料版本", "管理信息化目录", "一证据材料一个发布版本", MANAGEMENT,
                       [("evidence_id", "TEXT", "核心证据材料，缺失时为空"), ("document_kind", "TEXT NOT NULL", "材料类别"), ("version_label", "TEXT NOT NULL", "材料版本"), ("effective_on", "TEXT NOT NULL", "版本生效日"), ("publication_status", "TEXT NOT NULL", "发布状态")], (_fk("management_evidence", "evidence_id"),))
    budget = b.table("budget_plan_lines", "budget_plan_line_id", "科室预算编制明细", "管理信息化目录", "一成本中心一年度预算草案项目", GK(42, 33, 35),
                     [("cost_center_id", "TEXT NOT NULL", "预算成本中心"), ("budget_year", "INTEGER NOT NULL", "预算年度"), ("budget_item_code", "TEXT NOT NULL", "合成预算项目"), ("planned_amount_yuan", "NUMERIC NOT NULL", "计划金额，非实际财务支出"), ("approval_status", "TEXT NOT NULL", "草案审批状态")], (_fk("cost_centers", "cost_center_id"),), "distractor")
    adjustment = b.table("budget_adjustment_requests", "budget_adjustment_id", "预算调整申请", "管理信息化目录", "一预算明细一次调整申请", GK(42),
                         [("budget_plan_line_id", "TEXT NOT NULL", "原预算计划"), ("requested_on", "TEXT NOT NULL", "申请日期"), ("requested_delta_yuan", "NUMERIC NOT NULL", "申请调整差额，非已批准金额"), ("approval_status", "TEXT NOT NULL", "审批状态")], (_fk("budget_plan_lines", "budget_plan_line_id"),))
    meeting = b.table("quality_committee_meetings", "quality_meeting_id", "质量委员会会议记录", "管理信息化目录", "一机构一次计划或已举行的质量管理会议", SH(645) + ["met.sh-ps-s012"],
                      [("document_version_id", "TEXT NOT NULL", "会议材料版本"), ("scheduled_on", "TEXT NOT NULL", "计划会议日期"), ("held_on", "TEXT", "实际举行日期；仅计划时为空"), ("agenda_code", "TEXT NOT NULL", "合成议题"), ("minutes_status", "TEXT NOT NULL", "纪要状态，不代表外部质控分数")], (_fk("management_document_versions", "document_version_id"),))
    module = b.table("emr_system_modules", "emr_module_id", "电子病历系统模块", "管理信息化目录", "一机构一个已部署软件模块", GK(24),
                     [("module_name", "TEXT NOT NULL", "模块名称"), ("software_version", "TEXT NOT NULL", "软件版本，非电子病历评审标准版本"), ("deployed_on", "TEXT NOT NULL", "部署日期"), ("deployment_status", "TEXT NOT NULL", "部署状态，不代表评级通过")])
    change = b.table("emr_change_requests", "emr_change_request_id", "电子病历变更申请", "管理信息化目录", "一软件模块一次变更申请", GK(24),
                     [("emr_module_id", "TEXT NOT NULL", "系统模块"), ("requested_on", "TEXT NOT NULL", "变更申请日"), ("target_version", "TEXT NOT NULL", "目标软件版本"), ("change_status", "TEXT NOT NULL", "变更流程状态")], (_fk("emr_system_modules", "emr_module_id"),))
    catalog = b.table("clinical_catalog_imports", "catalog_import_id", "临床目录导入批次", "管理信息化目录", "一机构一次临床目录导入任务", SURGERY + GK(17, 32, 56),
                      [("catalog_id", "TEXT NOT NULL", "目录标识"), ("catalog_version", "TEXT NOT NULL", "目录版本"), ("imported_on", "TEXT NOT NULL", "导入日期"), ("import_status", "TEXT NOT NULL", "导入任务状态，不能据此认定代码属于正式目录"), ("source_kind", "TEXT NOT NULL", "合成目录来源")])
    drg = b.table("drg_coding_submissions", "drg_submission_id", "DRG 编码提交记录", "管理信息化目录", "一次住院一次编码提交尝试", GK(14, 17, 31, 40) + SH(60, 61),
                  [("stay_id", "TEXT NOT NULL", "住院键"), ("submitted_at", "TEXT NOT NULL", "编码提交时间"), ("grouper_version", "TEXT", "核心分组器版本，无结果时为空"), ("submission_status", "TEXT NOT NULL", "已分组或待分组；不是最终分组结果")], (_fk("inpatient_stays", "stay_id"),), "distractor")
    evidence_by_inst = defaultdict(list)
    for row in b.read("management_evidence"):
        evidence_by_inst[row["institution_id"]].append(row)
    imports = b.read("clinical_code_memberships")
    for row in b.read("institutions"):
        inst = row["institution_id"]
        documents = evidence_by_inst[inst]
        if not documents:
            document(inst, "DOC_DRAFT", None, "QUALITY_MEETING_MINUTES", "SYN_V1", "2025-01-01", "DRAFT")
        for source in documents:
            document(inst, f"DOC_{source['evidence_id']}", source["evidence_id"], source["evidence_domain_code"] or "QUALITY", "SYN_V1", source["effective_date"] or f"{source['assessment_year'] or 2025}-01-01", "REFERENCED")
        # 专门的会议草稿不借用制度材料证明开过会议，保持证据文书与事件语义一致。
        document(inst, "DOC_MEETING_PLAN", None, "QUALITY_MEETING_AGENDA", "SYN_V1", "2025-01-01", "DRAFT")
        meeting(inst, "QUALITY_MEETING_PLAN", "DOC_MEETING_PLAN", "2025-01-01", None, "SYN_QUALITY_REVIEW", "PLANNED")
        module(inst, "EMR_NOTES", "合成病程记录模块", "SYN_APP_V1", "2025-01-01", "DEPLOYED")
        change(inst, "EMR_CHANGE_1", "EMR_NOTES", "2025-01-02", "SYN_APP_V2", "REVIEW_PENDING")
        seen = set()
        for source in imports:
            key = source["catalog_id"], source["catalog_version"]
            if key not in seen:
                catalog(inst, f"IMPORT_{len(seen) + 1}", *key, source["valid_from"] or "2025-01-01", "LOADED", "SYNTHETIC_TEST_DESIGN")
                seen.add(key)
        if not seen:
            catalog(inst, "IMPORT_PENDING", "SYN_CATALOG", "SYN_V1", "2025-01-01", "PENDING", "SYNTHETIC_TEST_DESIGN")
    for row in b.read("cost_centers"):
        inst, cid = row["institution_id"], row["cost_center_id"]
        budget(inst, f"BUDGET_{cid}", cid, 2025, "SYN_SUPPLIES", 10000, "DRAFT")
        adjustment(inst, f"ADJ_{cid}", f"BUDGET_{cid}", "2025-03-01", 500, "PENDING")
    grouped = {(r["institution_id"], r["stay_id"]): r for r in b.read("drg_case_assignments")}
    for row in b.read("inpatient_stays"):
        inst, sid = row["institution_id"], row["stay_id"]
        group = grouped.get((inst, sid))
        stamp = group.get("assigned_at") if group else None
        drg(inst, f"DRGS_{sid}", sid, stamp or row["discharged_at"] or row["admitted_at"], group["grouper_version"] if group else None, "GROUPED" if group else "PENDING")


def create_and_populate(connection: sqlite3.Connection, seed: int = 20261016) -> dict[str, dict]:
    """向已填充的 26 核心表旁新增 80 表；不提交、不覆写、不改变调用者事务及 row_factory。"""
    builder = _Builder(connection, seed)
    # 仅依赖旧版最小样例也具备的基础事实；空药品/财务/ICU 等核心域保持空，不擅自补核心数据。
    for table in ("institutions", "departments", "patients", "outpatient_visits", "inpatient_stays", "inpatient_procedures"):
        if not builder.read(table):
            raise ValueError(f"支撑造数需要非空核心基础事实：{table}")
    for populate in (_organization, _patients, _outpatient, _inpatient, _surgery, _quality, _pharmacy, _finance, _staff_acute, _management):
        populate(builder)
    if len(builder.metadata) != 80:
        raise AssertionError("支撑表契约应恰好为 80 张")
    for table in builder.metadata:
        if not builder.rows[table]:
            raise ValueError(f"支撑表不能空置：{table}")
    return builder.metadata
