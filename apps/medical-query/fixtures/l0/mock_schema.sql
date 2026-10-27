-- 合成测试设计：此数据库只描述首期 L0 指标所需原始记录，不代表任何真实医院。
-- 时间统一使用 Asia/Shanghai 本地时间：日期 YYYY-MM-DD，时刻 YYYY-MM-DD HH:MM:SS；时间窗口边界仍按各指标规则决定。
-- 金额单位为元；布尔型用整数 0/1；所有代码为 TEXT，字符 "1" 不与数字 1 混用。
PRAGMA foreign_keys = ON;

-- 表 institutions：机构；行粒度：一行一个合成机构。合成测试结构。
CREATE TABLE institutions (
    -- institution_id：合成机构键。
    institution_id TEXT NOT NULL,
    -- institution_name：机构显示名。
    institution_name TEXT,
    -- hospital_class_code：综合或专科医院类别，供国考医保协议适用性判断；合成代码。
    hospital_class_code TEXT,
    PRIMARY KEY (institution_id)
);

-- 表 departments：科室；行粒度：一行一个机构内科室。合成测试结构。
CREATE TABLE departments (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- department_id：机构内科室键。
    department_id TEXT NOT NULL,
    -- department_name：科室名称。
    department_name TEXT,
    -- department_type：科室类型代码，合成测试分类。
    department_type TEXT,
    PRIMARY KEY (institution_id, department_id),
    FOREIGN KEY (institution_id) REFERENCES institutions (institution_id)
);

-- 表 patients：患者；行粒度：一行一个机构内患者。合成测试结构。
CREATE TABLE patients (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- patient_id：机构内患者键。
    patient_id TEXT NOT NULL,
    -- date_of_birth：出生日期。
    date_of_birth TEXT,
    -- sex_code：病案首页性别代码。
    sex_code TEXT,
    PRIMARY KEY (institution_id, patient_id),
    FOREIGN KEY (institution_id) REFERENCES institutions (institution_id)
);

-- 表 outpatient_visits：门急诊及体检挂号；行粒度：一行一次挂号或就诊。合成测试结构。
CREATE TABLE outpatient_visits (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- visit_id：挂号/就诊键。
    visit_id TEXT NOT NULL,
    -- patient_id：患者键。
    patient_id TEXT NOT NULL,
    -- department_id：挂号科室键。
    department_id TEXT,
    -- care_setting_code：就诊类型代码。
    care_setting_code TEXT NOT NULL,
    -- registered_at：挂号业务时间。
    registered_at TEXT NOT NULL,
    -- visit_status_code：挂号或就诊状态代码。
    visit_status_code TEXT,
    PRIMARY KEY (institution_id, visit_id),
    FOREIGN KEY (institution_id) REFERENCES institutions (institution_id),
    FOREIGN KEY (institution_id, patient_id) REFERENCES patients (institution_id, patient_id),
    FOREIGN KEY (institution_id, department_id) REFERENCES departments (institution_id, department_id)
);

-- 表 appointment_events：预约诊疗记录；行粒度：一行一次预约事项。合成测试结构。
CREATE TABLE appointment_events (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- appointment_id：预约事项键。
    appointment_id TEXT NOT NULL,
    -- visit_id：所属挂号键。
    visit_id TEXT NOT NULL,
    -- appointment_kind_code：预约事项类型代码。
    appointment_kind_code TEXT,
    -- scheduled_at：预约到院时间。
    scheduled_at TEXT,
    -- checked_in_at：报到时间，精确到分钟。
    checked_in_at TEXT,
    -- called_at：进入诊室后医生叫诊时间，精确到分钟。
    called_at TEXT,
    -- appointment_status_code：预约状态代码。
    appointment_status_code TEXT,
    PRIMARY KEY (institution_id, appointment_id),
    FOREIGN KEY (institution_id, visit_id) REFERENCES outpatient_visits (institution_id, visit_id)
);

-- 表 inpatient_stays：住院就诊；行粒度：一行一次住院。合成测试结构。
CREATE TABLE inpatient_stays (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- stay_id：住院键。
    stay_id TEXT NOT NULL,
    -- patient_id：患者键。
    patient_id TEXT NOT NULL,
    -- admitted_at：入院时间。
    admitted_at TEXT NOT NULL,
    -- discharged_at：出院时间；未出院为空。
    discharged_at TEXT,
    -- admit_department_id：入院科室键。
    admit_department_id TEXT,
    -- discharge_department_id：出院科室键。
    discharge_department_id TEXT,
    -- discharge_disposition_code：出院转归代码，死亡与其他转归须分清。
    discharge_disposition_code TEXT,
    -- home_bed_flag：是否家庭病床，合成布尔编码。
    home_bed_flag INTEGER CHECK (home_bed_flag IN (0,1)),
    -- planned_admission_flag：本次入院是否计划内，供再入院判别。
    planned_admission_flag INTEGER CHECK (planned_admission_flag IN (0,1)),
    -- day_surgery_planned_admit_at：日间手术诊疗计划入院时间，用于核对计划24小时窗口。
    day_surgery_planned_admit_at TEXT,
    -- day_surgery_planned_discharge_at：日间手术诊疗计划出院时间。
    day_surgery_planned_discharge_at TEXT,
    -- day_surgery_delay_reason_code：超过计划窗口的延期原因；合成代码需与医院记录核对。
    day_surgery_delay_reason_code TEXT,
    -- ward_arrived_at：实际到达病区时间；排除仅办理手续而未到病区者。
    ward_arrived_at TEXT,
    -- rooming_in_newborn_flag：是否母婴同室新生儿，供护理质控分母排除。
    rooming_in_newborn_flag INTEGER CHECK (rooming_in_newborn_flag IN (0,1)),
    PRIMARY KEY (institution_id, stay_id),
    FOREIGN KEY (institution_id, patient_id) REFERENCES patients (institution_id, patient_id),
    FOREIGN KEY (institution_id, admit_department_id) REFERENCES departments (institution_id, department_id),
    FOREIGN KEY (institution_id, discharge_department_id) REFERENCES departments (institution_id, department_id)
);

-- 表 inpatient_diagnoses：住院诊断；行粒度：一行一次住院的一条诊断。合成测试结构。
CREATE TABLE inpatient_diagnoses (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- diagnosis_id：诊断记录键。
    diagnosis_id TEXT NOT NULL,
    -- stay_id：住院键。
    stay_id TEXT NOT NULL,
    -- diagnosis_code：疾病诊断代码。
    diagnosis_code TEXT NOT NULL,
    -- code_system：诊断编码体系。
    code_system TEXT NOT NULL,
    -- code_edition：诊断编码版本。
    code_edition TEXT,
    -- diagnosis_rank：主诊断或其他诊断次序。
    diagnosis_rank INTEGER,
    -- present_on_admission_code：病案首页入院病情代码，国考并发症使用字符 4。
    present_on_admission_code TEXT,
    PRIMARY KEY (institution_id, diagnosis_id),
    UNIQUE (institution_id, stay_id, diagnosis_rank),
    FOREIGN KEY (institution_id, stay_id) REFERENCES inpatient_stays (institution_id, stay_id)
);

-- 表 inpatient_procedures：住院手术/操作；行粒度：一行一次住院操作。合成测试结构。
CREATE TABLE inpatient_procedures (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- procedure_id：手术操作键。
    procedure_id TEXT NOT NULL,
    -- stay_id：住院键。
    stay_id TEXT NOT NULL,
    -- procedure_code：手术操作代码。
    procedure_code TEXT NOT NULL,
    -- code_system：手术操作编码体系。
    code_system TEXT NOT NULL,
    -- code_edition：手术操作编码版本。
    code_edition TEXT,
    -- performed_at：操作时间。
    performed_at TEXT,
    -- surgery_grade_code：手术分级代码；国考/上海目录版本需另确认。
    surgery_grade_code TEXT,
    -- elective_flag：是否择期手术或介入。
    elective_flag INTEGER CHECK (elective_flag IN (0,1)),
    -- day_surgery_flag：是否日间手术；需结合麻醉、地点、住院时长核验。
    day_surgery_flag INTEGER CHECK (day_surgery_flag IN (0,1)),
    -- minimally_invasive_flag：是否属于该年度国家微创目录。
    minimally_invasive_flag INTEGER CHECK (minimally_invasive_flag IN (0,1)),
    -- intervention_flag：是否介入治疗。
    intervention_flag INTEGER CHECK (intervention_flag IN (0,1)),
    -- anesthesia_flag：是否麻醉状态下完成。
    anesthesia_flag INTEGER CHECK (anesthesia_flag IN (0,1)),
    -- operating_location_code：手术地点代码。
    operating_location_code TEXT,
    -- incision_class_code：切口类别代码。
    incision_class_code TEXT,
    -- wound_healing_grade_code：切口愈合等级代码；国考给出代码值 3，TEXT 属合成设计。
    wound_healing_grade_code TEXT,
    -- unplanned_return_flag：是否非计划重返手术室。
    unplanned_return_flag INTEGER CHECK (unplanned_return_flag IN (0,1)),
    -- prior_procedure_id：候选前次手术键；同一患者和时间顺序须另行确认，故不声明外键。
    prior_procedure_id TEXT,
    PRIMARY KEY (institution_id, procedure_id),
    -- 事件关联操作时同时校验住院键，防止同机构其他住院的操作误连。
    UNIQUE (institution_id, stay_id, procedure_id),
    FOREIGN KEY (institution_id, stay_id) REFERENCES inpatient_stays (institution_id, stay_id)
);

-- 表 clinical_events：住院临床不良事件；行粒度：一行一次事件。合成测试结构。
CREATE TABLE clinical_events (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- event_id：事件键。
    event_id TEXT NOT NULL,
    -- stay_id：住院键。
    stay_id TEXT NOT NULL,
    -- procedure_id：相关手术键。
    procedure_id TEXT,
    -- event_type_code：事件类型代码。
    event_type_code TEXT NOT NULL,
    -- event_code：事件诊断或监测代码。
    event_code TEXT,
    -- occurred_at：事件发生时间。
    occurred_at TEXT,
    -- present_on_admission_code：入院时状态代码。
    present_on_admission_code TEXT,
    -- hospital_acquired_flag：是否院内发生。
    hospital_acquired_flag INTEGER CHECK (hospital_acquired_flag IN (0,1)),
    -- pressure_stage_code：压力性损伤分期代码。
    pressure_stage_code TEXT,
    -- event_location_code：事件发生地点，识别院内跌倒及坠床。
    event_location_code TEXT,
    -- pediatric_physiological_no_harm_fall_flag：住院患儿生理性无伤害跌倒排除标志。
    pediatric_physiological_no_harm_fall_flag INTEGER CHECK (pediatric_physiological_no_harm_fall_flag IN (0,1)),
    -- pressure_injury_kind_code：压力性损伤类型，区分器械、黏膜与非压力性损伤。
    pressure_injury_kind_code TEXT,
    -- infection_present_on_admission_flag：感染入院前已经开始的原始判定。
    infection_present_on_admission_flag INTEGER CHECK (infection_present_on_admission_flag IN (0,1)),
    -- infection_incubating_on_admission_flag：感染入院时已处潜伏期的原始判定。
    infection_incubating_on_admission_flag INTEGER CHECK (infection_incubating_on_admission_flag IN (0,1)),
    PRIMARY KEY (institution_id, event_id),
    FOREIGN KEY (institution_id, stay_id) REFERENCES inpatient_stays (institution_id, stay_id),
    FOREIGN KEY (institution_id, stay_id, procedure_id) REFERENCES inpatient_procedures (institution_id, stay_id, procedure_id)
);

-- 表 inpatient_census_days：住院占床日记录；行粒度：一行一次住院在一个自然日的占床事实。合成测试结构。
CREATE TABLE inpatient_census_days (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- stay_id：住院键。
    stay_id TEXT NOT NULL,
    -- census_date：占床自然日。
    census_date TEXT NOT NULL,
    -- department_id：当天病床所属科室键。
    department_id TEXT,
    -- count_basis_code：占床计数依据。
    count_basis_code TEXT NOT NULL,
    -- bed_kind_code：病床类型。
    bed_kind_code TEXT NOT NULL,
    PRIMARY KEY (institution_id, stay_id, census_date),
    FOREIGN KEY (institution_id, stay_id) REFERENCES inpatient_stays (institution_id, stay_id),
    FOREIGN KEY (institution_id, department_id) REFERENCES departments (institution_id, department_id)
);

-- 表 bed_capacity_days：每日开放床位；行粒度：一行一个机构科室自然日。合成测试结构。
CREATE TABLE bed_capacity_days (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- department_id：科室键。
    department_id TEXT NOT NULL,
    -- capacity_date：开放床位日期。
    capacity_date TEXT NOT NULL,
    -- open_beds_count：当日实际开放床位数；单位：张。
    open_beds_count INTEGER NOT NULL,
    PRIMARY KEY (institution_id, department_id, capacity_date),
    FOREIGN KEY (institution_id, department_id) REFERENCES departments (institution_id, department_id),
    CHECK (open_beds_count >= 0)
);

-- 表 medication_administrations：住院用药消耗；行粒度：一行一次住院药品消耗。合成测试结构。
CREATE TABLE medication_administrations (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- administration_id：给药/消耗记录键。
    administration_id TEXT NOT NULL,
    -- stay_id：住院键。
    stay_id TEXT NOT NULL,
    -- drug_code：药品代码。
    drug_code TEXT NOT NULL,
    -- drug_code_system：药品编码体系。
    drug_code_system TEXT NOT NULL,
    -- drug_code_edition：药品编码版本。
    drug_code_edition TEXT,
    -- ddd_standard_version：本条消耗记录匹配的 DDD 标准版本；合成关联键，医院选版规则待确认。
    ddd_standard_version TEXT,
    -- consumed_at：实际消耗时间。
    consumed_at TEXT,
    -- quantity：实际消耗剂量；单位：随 quantity_unit 指定。
    quantity REAL,
    -- quantity_unit：剂量单位。
    quantity_unit TEXT,
    -- take_home_at_discharge_flag：是否出院带药。
    take_home_at_discharge_flag INTEGER CHECK (take_home_at_discharge_flag IN (0,1)),
    PRIMARY KEY (institution_id, administration_id),
    FOREIGN KEY (institution_id, stay_id) REFERENCES inpatient_stays (institution_id, stay_id)
);

-- 表 drug_ddd_standards：药品 DDD 标准；行粒度：一行一个药品编码版本的 DDD 标准。合成测试结构。
CREATE TABLE drug_ddd_standards (
    -- drug_code_system：药品编码体系。
    drug_code_system TEXT NOT NULL,
    -- drug_code_edition：药品编码版本。
    drug_code_edition TEXT NOT NULL,
    -- drug_code：药品代码。
    drug_code TEXT NOT NULL,
    -- ddd_version：DDD 标准版本。
    ddd_version TEXT NOT NULL,
    -- is_antibacterial：是否抗菌药物。
    is_antibacterial INTEGER NOT NULL CHECK (is_antibacterial IN (0,1)),
    -- ddd_quantity：一 DDD 对应剂量；单位：随 ddd_unit 指定。
    ddd_quantity REAL NOT NULL,
    -- ddd_unit：DDD 剂量单位。
    ddd_unit TEXT NOT NULL,
    PRIMARY KEY (drug_code_system, drug_code_edition, drug_code, ddd_version)
);

-- 表 clinical_code_memberships：指标代码目录成员；行粒度：一行一个目录版本中的一个代码。合成测试结构。
CREATE TABLE clinical_code_memberships (
    -- catalog_id：代码目录标识。
    catalog_id TEXT NOT NULL,
    -- catalog_version：代码目录版本。
    catalog_version TEXT NOT NULL,
    -- code_system：编码体系。
    code_system TEXT NOT NULL,
    -- code_edition：编码版本。
    code_edition TEXT NOT NULL,
    -- code：目录成员代码。
    code TEXT NOT NULL,
    -- valid_from：生效日期。
    valid_from TEXT,
    -- valid_to：失效日期。
    valid_to TEXT,
    PRIMARY KEY (catalog_id, catalog_version, code_system, code_edition, code)
);

-- 表 clinician_year_roster：执业医师年度名册；行粒度：一行一名医师在一个统计年度的状态。合成测试结构。
CREATE TABLE clinician_year_roster (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- clinician_id：医师键。
    clinician_id TEXT NOT NULL,
    -- roster_year：名册年度。
    roster_year INTEGER NOT NULL,
    -- license_type_code：执业或助理医师资格类别。
    license_type_code TEXT,
    -- clinical_work_flag：是否实际在院临床工作。
    clinical_work_flag INTEGER CHECK (clinical_work_flag IN (0,1)),
    -- standard_training_flag：是否参加规范化培训。
    standard_training_flag INTEGER CHECK (standard_training_flag IN (0,1)),
    -- primary_registration_here_flag：主要执业机构是否已变更为本院。
    primary_registration_here_flag INTEGER CHECK (primary_registration_here_flag IN (0,1)),
    PRIMARY KEY (institution_id, clinician_id, roster_year),
    FOREIGN KEY (institution_id) REFERENCES institutions (institution_id)
);

-- 表 financial_entries：财务明细分录；行粒度：一行一条原始财务分录。合成测试结构。
CREATE TABLE financial_entries (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- entry_id：财务分录键。
    entry_id TEXT NOT NULL,
    -- visit_id：相关门急诊或体检就诊键；非患者分录为空。
    visit_id TEXT,
    -- stay_id：相关住院键；非患者分录为空。
    stay_id TEXT,
    -- accounting_date：权责发生或会计归属日期。
    accounting_date TEXT NOT NULL,
    -- account_code：会计科目代码。
    account_code TEXT NOT NULL,
    -- account_kind_code：收入或费用方向。
    account_kind_code TEXT NOT NULL,
    -- amount_yuan：分录金额，冲回以负数表示；单位：元。
    amount_yuan NUMERIC NOT NULL,
    -- care_setting_code：门急诊、住院等业务归属。
    care_setting_code TEXT,
    -- payer_category_code：付款方类别。
    payer_category_code TEXT,
    -- insurance_fund_amount_yuan：该分录中应由医保基金直接支付金额；单位：元。
    insurance_fund_amount_yuan NUMERIC,
    -- item_class_code：药品、卫生材料、检查检验、医疗服务等项目类别。
    item_class_code TEXT,
    -- item_code：药品或耗材原始项目代码。
    item_code TEXT,
    -- item_code_system：项目编码体系。
    item_code_system TEXT,
    -- item_code_edition：项目编码版本。
    item_code_edition TEXT,
    -- funding_source_code：财政基本、项目或科教等资金来源。
    funding_source_code TEXT,
    PRIMARY KEY (institution_id, entry_id),
    FOREIGN KEY (institution_id) REFERENCES institutions (institution_id),
    FOREIGN KEY (institution_id, visit_id) REFERENCES outpatient_visits (institution_id, visit_id),
    FOREIGN KEY (institution_id, stay_id) REFERENCES inpatient_stays (institution_id, stay_id),
    CHECK (visit_id IS NULL OR stay_id IS NULL)
);

-- 表 insurance_agreements：医保服务协议；行粒度：一行一份机构医保服务协议及有效期间。合成测试结构。
CREATE TABLE insurance_agreements (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- agreement_id：协议键。
    agreement_id TEXT NOT NULL,
    -- service_scope_code：门诊或住院协议范围。
    service_scope_code TEXT NOT NULL,
    -- valid_from：协议生效日期。
    valid_from TEXT NOT NULL,
    -- valid_to：协议失效日期。
    valid_to TEXT,
    -- agreement_status_code：协议状态代码。
    agreement_status_code TEXT,
    PRIMARY KEY (institution_id, agreement_id),
    FOREIGN KEY (institution_id) REFERENCES institutions (institution_id)
);

-- 表 balance_snapshots：财务科目余额；行粒度：一行一科目一个期末的余额。合成测试结构。
CREATE TABLE balance_snapshots (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- snapshot_date：期末余额日期。
    snapshot_date TEXT NOT NULL,
    -- account_code：会计科目代码。
    account_code TEXT NOT NULL,
    -- balance_yuan：期末科目余额；单位：元。
    balance_yuan NUMERIC NOT NULL,
    -- balance_class_code：资产负债类别，合成测试分类。
    balance_class_code TEXT NOT NULL,
    -- quick_asset_flag：是否属于速动资产分类。
    quick_asset_flag INTEGER CHECK (quick_asset_flag IN (0,1)),
    PRIMARY KEY (institution_id, snapshot_date, account_code),
    FOREIGN KEY (institution_id) REFERENCES institutions (institution_id)
);

-- 表 energy_consumption：能源消耗原始记录；行粒度：一行一次能源计量或结算记录。合成测试结构。
CREATE TABLE energy_consumption (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- energy_record_id：能源记录键。
    energy_record_id TEXT NOT NULL,
    -- consumed_date：能耗业务日期。
    consumed_date TEXT NOT NULL,
    -- energy_kind_code：能源种类代码。
    energy_kind_code TEXT NOT NULL,
    -- quantity：实际用量；单位：随 quantity_unit 指定。
    quantity REAL NOT NULL,
    -- quantity_unit：用量单位。
    quantity_unit TEXT NOT NULL,
    -- standard_coal_tons_per_unit：吨标煤转换系数；单位：吨标煤/用量单位。
    standard_coal_tons_per_unit REAL,
    -- conversion_version：换算标准版本。
    conversion_version TEXT,
    PRIMARY KEY (institution_id, energy_record_id),
    FOREIGN KEY (institution_id) REFERENCES institutions (institution_id)
);

-- 表 drg_group_reference：DRG 外部基准；行粒度：一行一年度分组器版本的病组基准。合成测试结构。
CREATE TABLE drg_group_reference (
    -- reference_year：基准年份。
    reference_year INTEGER NOT NULL,
    -- grouper_version：DRG 分组器版本。
    grouper_version TEXT NOT NULL,
    -- drg_code：DRG 病组代码。
    drg_code TEXT NOT NULL,
    -- mortality_risk_class_code：该病组死亡风险类别代码。
    mortality_risk_class_code TEXT,
    -- relative_weight：DRG 病组权重，供 CMI 校正的数据需求。
    relative_weight REAL,
    -- reference_los_days：上海市全市同 DRG 平均住院日基准；单位：日，版本待确认。
    reference_los_days REAL,
    -- reference_cost_yuan：上海市全市同 DRG 住院例均费用基准；单位：元，版本待确认。
    reference_cost_yuan NUMERIC,
    PRIMARY KEY (reference_year, grouper_version, drg_code)
);

-- 表 drg_case_assignments：住院 DRG 分组结果；行粒度：一行一次住院的 DRG 分组。合成测试结构。
CREATE TABLE drg_case_assignments (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- stay_id：住院键。
    stay_id TEXT NOT NULL,
    -- reference_year：对应基准年份。
    reference_year INTEGER NOT NULL,
    -- grouper_version：分组器版本。
    grouper_version TEXT NOT NULL,
    -- drg_code：DRG 病组代码。
    drg_code TEXT NOT NULL,
    -- assigned_at：分组完成时间。
    assigned_at TEXT,
    PRIMARY KEY (institution_id, stay_id),
    FOREIGN KEY (institution_id, stay_id) REFERENCES inpatient_stays (institution_id, stay_id),
    FOREIGN KEY (reference_year, grouper_version, drg_code) REFERENCES drg_group_reference (reference_year, grouper_version, drg_code)
);

-- 表 icu_episodes：ICU 收治片段；行粒度：一行一次 ICU 收治片段。合成测试结构。
CREATE TABLE icu_episodes (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- icu_episode_id：ICU 片段键。
    icu_episode_id TEXT NOT NULL,
    -- stay_id：住院键。
    stay_id TEXT NOT NULL,
    -- icu_entered_at：进入 ICU 时间。
    icu_entered_at TEXT NOT NULL,
    -- icu_left_at：离开 ICU 时间。
    icu_left_at TEXT,
    -- icu_disposition_code：离开 ICU 转归代码。
    icu_disposition_code TEXT,
    -- brain_dead_on_entry_flag：进入 ICU 时已脑死亡；用于质控排除。
    brain_dead_on_entry_flag INTEGER CHECK (brain_dead_on_entry_flag IN (0,1)),
    -- organ_donation_purpose_flag：是否仅因器官捐献而收治；用于质控排除。
    organ_donation_purpose_flag INTEGER CHECK (organ_donation_purpose_flag IN (0,1)),
    PRIMARY KEY (institution_id, icu_episode_id),
    FOREIGN KEY (institution_id, stay_id) REFERENCES inpatient_stays (institution_id, stay_id)
);

-- 表 icu_risk_assessments：ICU 死亡风险评估；行粒度：一行一次 ICU 片段的一次风险评估。合成测试结构。
CREATE TABLE icu_risk_assessments (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- risk_assessment_id：风险评估键。
    risk_assessment_id TEXT NOT NULL,
    -- icu_episode_id：ICU 片段键。
    icu_episode_id TEXT NOT NULL,
    -- assessed_at：评估时间。
    assessed_at TEXT NOT NULL,
    -- risk_model_code：风险模型代码。
    risk_model_code TEXT,
    -- risk_model_version：风险模型版本。
    risk_model_version TEXT,
    -- apache_ii_score：用于 2024 版 ICU 风险模型的 APACHE II 原始评分。
    apache_ii_score REAL,
    -- major_disease_score：入 ICU 主要疾病得分，标准版本由 risk_model_version 指定。
    major_disease_score REAL,
    -- emergency_postop_flag：是否急诊术后，决定风险模型是否加入 0.603。
    emergency_postop_flag INTEGER CHECK (emergency_postop_flag IN (0,1)),
    PRIMARY KEY (institution_id, risk_assessment_id),
    FOREIGN KEY (institution_id, icu_episode_id) REFERENCES icu_episodes (institution_id, icu_episode_id)
);

-- 表 emergency_rescue_episodes：急诊抢救室片段；行粒度：一行一次抢救室进入-离开片段。合成测试结构。
CREATE TABLE emergency_rescue_episodes (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- rescue_episode_id：抢救室片段键。
    rescue_episode_id TEXT NOT NULL,
    -- visit_id：关联急诊就诊键。
    visit_id TEXT NOT NULL,
    -- entered_at：进入抢救室时间。
    entered_at TEXT NOT NULL,
    -- left_at：离开抢救室时间。
    left_at TEXT,
    -- departure_status_code：抢救室离开状态。
    departure_status_code TEXT,
    PRIMARY KEY (institution_id, rescue_episode_id),
    FOREIGN KEY (institution_id, visit_id) REFERENCES outpatient_visits (institution_id, visit_id)
);

-- 表 management_evidence：管理/评审证据；行粒度：一行一份证据材料。合成测试结构。
CREATE TABLE management_evidence (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- evidence_id：证据材料键。
    evidence_id TEXT NOT NULL,
    -- department_id：适用科室键；院级材料为空，科室责任制材料关联具体科室。
    department_id TEXT,
    -- assessment_clause_code：评审细则项号，供四项责任制证据分别追溯。
    assessment_clause_code TEXT,
    -- evidence_method_code：证据核查方式（文件、记录、访谈、现场）。
    evidence_method_code TEXT,
    -- evidence_domain_code：预算、质量责任、信息化评审等证据域。
    evidence_domain_code TEXT,
    -- evidence_stage_code：制度、编制、审批、执行、调整、分析、考核、公开等阶段。
    evidence_stage_code TEXT,
    -- effective_date：材料生效日期。
    effective_date TEXT,
    -- assessment_year：对应评审或监测年度。
    assessment_year INTEGER,
    -- document_reference：材料可核对引用。
    document_reference TEXT,
    PRIMARY KEY (institution_id, evidence_id),
    FOREIGN KEY (institution_id) REFERENCES institutions (institution_id),
    FOREIGN KEY (institution_id, department_id) REFERENCES departments (institution_id, department_id)
);

-- 表 emr_assessment_items：电子病历分级评价项目；行粒度：一行一个机构年度标准版本下的评价项目选项。合成测试结构。
CREATE TABLE emr_assessment_items (
    -- institution_id：机构键。
    institution_id TEXT NOT NULL,
    -- assessment_year：评价年度。
    assessment_year INTEGER NOT NULL,
    -- standard_version：电子病历评价标准版本。
    standard_version TEXT NOT NULL,
    -- item_code：评价项目代码。
    item_code TEXT NOT NULL,
    -- option_code：评价项目选项代码。
    option_code TEXT NOT NULL,
    -- target_level：所属目标等级。
    target_level INTEGER,
    -- option_role_code：基本或选择项目类别。
    option_role_code TEXT,
    -- implemented_flag：功能是否实现。
    implemented_flag INTEGER CHECK (implemented_flag IN (0,1)),
    -- effective_coverage_percent：有效应用覆盖率；单位：%。
    effective_coverage_percent REAL,
    -- data_quality_index：数据质量指数。
    data_quality_index REAL,
    PRIMARY KEY (institution_id, assessment_year, standard_version, item_code, option_code),
    FOREIGN KEY (institution_id) REFERENCES institutions (institution_id),
    CHECK (target_level IS NULL OR target_level BETWEEN 0 AND 8),
    CHECK (effective_coverage_percent IS NULL OR effective_coverage_percent BETWEEN 0 AND 100)
);
