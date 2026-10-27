# Pi 智能问数 L0 数据包 Claude Code 使用说明

这份说明供 Claude Code 在开发“Pi 智能问数”时使用。六份文件共同描述指标规则、所需原始数据、合成 SQLite 结构、物理绑定和计算缺口。接入后的首期目标是：根据问题找到指标，并追溯到所需表、字段、关系、代码、时间和过滤条件，同时准确说明尚不能计算的原因。

当前版本覆盖 47 项指标、26 个实体、216 个逻辑字段和 39 条关系。其中 32 条关系由合成 SQL 外键声明，7 条保持候选。45 项保留 `blocked_engine_and_hospital_mapping`，上海 M0645 和 S012 保留 `blocked_rule_source`。L0 沿用原文“首期院级管理建议”的含义，不能据名称认定指标都是简单统计。

## 1 文件位置与职责

在当前项目中，以 `Pi-智能问数` 为仓库根目录，数据包位于 `apps/medical-query/fixtures/l0/`。迁移到其他项目时，配置一个数据包根目录，并通过文件名加载；不要把本机绝对路径写进业务规则。

| 文件 | 使用方式 | 不能据此推断的内容 |
| --- | --- | --- |
| `manifest.json` | 检查格式、来源、覆盖范围、指标数量及未处理章节 | `source_export_sha256` 是打印派生文件的哈希，不能替代为 `null` 的原文件 `document_hash`；日期也不能代替未知版本号 |
| `metrics.json` | 从 `metrics` 数组读取指标名称、别名、公式、分子分母、纳排、时间、粒度和依赖 | 定义存在不等于可执行；同名指标在不同体系下不能自动合并 |
| `logical_requirements.json` | 从 `entities`、`fields`、`relations` 建立逻辑索引，理解一行的业务含义及完整关联键 | 同名字段不构成关系；ID 的拼写不能替代显式绑定 |
| `mock_schema.sql` | 在新的 SQLite 库中建立原始记录及参考表，并读取实际表列、主键、唯一约束和外键 | DDL 不含指标结果，也不保证数据齐全或口径已确认 |
| `mock_semantics.json` | 通过 `field_bindings`、`code_mappings`、`metric_bindings` 将逻辑需求定位到物理结构 | 合成绑定不代表真实医院绑定；候选关系不能用于自动执行 |
| `binding_gaps.json` | 从 `items` 按指标读取缺口、受影响字段、原文依据和所需确认 | 缺口不能被模型猜测、样本数据或修改状态字段自动消除 |

当前目录另有 `mock_conventions.json`，它是后续开发增加的可选合成样本约定，不属于原始六文件。它只能补充标记为 `synthetic_test_design` 的测试条件，不能覆盖正式规则、补成真实医院事实或解除阻断。

## 2 来源与缺失值的处理约定

读取每项信息时，同时保留来源性质和来源位置。

| 信息类别 | 当前文件中的常见标记 | Claude Code 的处理要求 |
| --- | --- | --- |
| 文档明确规定 | `provenance: document_explicit`、`source_refs` | 保留原文公式、对象、边界和适用体系；解释性文字不能丢失 |
| 根据文档推导的数据需求 | `provenance: document_derived` | 可用于设计字段需求，但不能宣称原文规定了具体医院表列 |
| 合成测试设计 | `synthetic: true`、`physical_design: synthetic`、`synthetic_design`、`synthetic_test_design` | 只用于 mock 建库、绑定与测试；类型、代码和关联假设须保留标记 |
| 实际医院映射 | `actual_hospital_mapping`、`actual_hospital_field`、`actual_hospital_bindings` | 当前为 `null` 或空数组；后续只能依据医院资料建立，不能自动沿用合成表名 |

指标上的 `synthetic: false` 表示指标定义来自文档，不表示它所绑定的数据是真实医院数据。判断物理数据性质，应同时看数据源、字段绑定及医院映射。

`null` 表示未明确、不适用或未取得，具体原因从 `missing_reason`、`missing_reasons`、`unresolved_items`、`null_meaning` 和缺口项读取。不得统一转成零、否、空字符串或默认时间。尤其不能默认零分母返回 0、缺失时间返回 0 分钟，或自行规定小数精度与窗口端点。

来源追溯保留 `source_refs` 中的 URL、章节、表格位置、`pdf_pages` 和 `printed_pages`。PDF 页序与印刷页码是不同定位方式，不要互相覆盖。

## 3 按指标展开数据需求

先解析 JSON 并以 ID 建索引，再按用户问题选择指标。不要把六份完整资料直接拼进每次模型提示词。

1. 使用 `metric_id`、`original_code`、`name`、`aliases` 和 `definition` 识别指标。现有应用每次最多选择 3 项；无匹配时返回空结果，有歧义时保留候选并说明区别。
2. 读取选中指标的全部规则，特别是 `numerator`、`denominator`、`time_rule`、`dimensions`、`dedup_keys`、`required_operators` 和未明确事项。
3. 通过 `required_field_ids` 查逻辑字段，再用 `field_bindings[].logical_field_id` 找到完整的 `physical_field`，例如 `fld.inpatient_stays.discharged_at` 绑定为 `inpatient_stays.discharged_at`。不要直接删除 ID 前缀来猜物理列。
4. 通过 `required_relation_ids` 和 `metric_bindings[].relation_path` 找关系。核对两端实体、全部键对、基数、可缺失性及重复计数风险。`relation_path` 是依赖清单，不应直接视为已经排好顺序的 JOIN 计划。
5. 收集相关物理表列、代码映射、业务时间及依赖指标；递归展开 `dependency_metric_ids` 时检查引用和循环。
6. 按 `metric_id` 读取 `binding_gaps.items`，并解析绑定中的 `remaining_missing`。输出可定位内容、候选关联和阻断原因。

索引是可重建的派生数据。原始 JSON 作为规则来源；索引、缓存或检索摘要不能变成另一份独立维护的规则真源。检索命中指标后，应由程序按 ID 补齐依赖，不让模型重新编造既有绑定。

`associated_metric_ids` 可用于反向检索，但完整依赖以选中指标的正向引用及实际关联键为准。缺口按原文定义或冲突、医院映射、合成假设、引擎能力、未确认关系、外部评分规则和人工评审分别处理，不要归并为一个泛化的“缺数据”。

### 条件必须保留作用范围

条件对象中的 `all`、`any`、`not` 分别表达 AND、OR、NOT。保留嵌套结构及分子、分母各自的条件，不得扁平化成全局 AND。

`raw_text` 或 `structure_status: partial` 表示规则尚未无损结构化，应保留原文与缺口。`parameter` 表示需要外部参数或目录绑定；`in_official_catalog` 且 `value: null` 不是可执行过滤，不能改成 `IN (NULL)`，也不能用局部 mock 枚举假冒完整官方目录。

`dedup_keys` 必须结合统计对象与分子分母理解，不能把其中所有字段组成一个统一的 `GROUP BY`。患者、挂号就诊、住院、操作、事件和患者日各有不同粒度。合成库中的局部 ID 可在不同机构重复，必须保留机构范围；复合外键不能省略 `institution_id`。

多表查询还应避免两种错误：把互不需要关联的分子、分母明细直接交叉连接；把多个一对多子表先连接再聚合，导致人次或金额被放大。各组件应按自己的粒度形成结果后，再按已确认公式组合。

`aggregation` 中的业务名称不是可直接执行的 SQL 函数。若有 `aggregation_field_id`、`aggregation_expression` 或分层计算说明，必须一起读取；例如医保基金分子不能默认汇总整笔收入。保留 `variants`、`output_variants` 等子输出，不把两个观察窗口合并成一个比率。

## 4 物理绑定与代码类型

`mock_semantics.tables` 以真实 SQL 表名为键，`columns` 以真实列名为键、值为中文释义。真正的字段绑定位于 `field_bindings`，指标绑定位于 `metric_bindings`，读取时不能混用这些结构。

每个代码条件都要对应到 `code_mappings[].physical_field`，并保留 `value` 的 JSON 原始类型。整数 `1` 与字符串 `"1"` 不相等；原文给出代码值，也不代表原文规定了 SQLite 列类型。代码值来源与物理类型来源分开查看。

对单位转换，使用登记的 `unit`、`conversion_rule` 和适用版本。药品剂量、DDD、金额、能源、百分比和千分比不能仅凭列名换算。倍率与显示单位均须按各指标规则处理，未知部分继续列缺口。

### 关系 ID 有三种角色

| 角色 | 来源与用途 |
| --- | --- |
| 稳定逻辑 ID | `logical_requirements.relations[].relation_id`，对应 `mock_semantics.relations[].id` 与指标的关系引用 |
| 数据库运行 ID | 当前领域服务从 SQLite 外键读取后生成的 ID，例如 `fk:<table>:<外键序号>`；它依赖实际库，不能硬编码序号 |
| 映射记录 | `L0Knowledge.select()` 生成的 `relation_bindings`，用 `logical_id` 对应 `runtime_id`；按两端表和完整列对核对 |

合成语义中 `origin: synthetic_sql_fk`、`status: active` 的关系，只有与运行目录中 `origin: database_metadata` 的实际外键完整匹配，才可取得运行 ID。`status: candidate` 或 `non_executable_relation_ids` 中的关系仍是候选，不能改成 `human_confirmed`，也不能用样本中的可连接记录证明关系成立。

## 5 当前 Pi 项目的接入方式

先读取仓库 `AGENTS.md`，然后复用已有入口，避免再建一套平行加载器。

Claude Code 在这里承担开发与校验工作。应用运行时使用的模型、网关和凭据继续由项目配置管理。

| 入口 | 当前职责 |
| --- | --- |
| `apps/medical-query/src/l0-knowledge.ts` | 加载五份 JSON 与可选合成约定，建立精简目录，按指标投影知识并校验匹配引用 |
| `apps/medical-query/python/build_l0_fixtures.py` | 读取原 DDL，生成少量原始合成事实并检查完整性和外键 |
| `apps/medical-query/src/pipeline.ts` | 指标识别、字段与规则匹配两阶段模型调用，保存匹配证据与阻断状态 |
| `apps/medical-query/src/domain.ts`、`python/domain.py` | 读取实际 SQLite 目录；L0 源的执行入口有独立拒绝逻辑 |
| `apps/medical-query/src/l0-evaluate.ts` | 经产品入口运行独立 Schema Linking 评测 |

SQL 由建库器读取，不进入五份 JSON 的知识加载列表。现有流程为：精简指标目录 → 识别指标 → 按 ID 投影规则、字段、关系、代码和缺口 → 模型匹配 → 程序校验 → 返回匹配证据及 blocked 状态。L0 profile 当前不执行指标 SQL。

以下命令在 `Pi-智能问数` 仓库根目录执行，运行项目需 Node.js 24 及以上、Python 3，具体环境配置见应用 README。

```sh
# 首次生成小规模合成事实库；已有同名快照时会拒绝覆盖。
npm run fixtures:l0 --workspace=@medical/pi-query

# 需要另一份快照时，选择一个新的输出目录。
npm run fixtures:l0 --workspace=@medical/pi-query -- --output-dir /absolute/path/to/new-l0-snapshot
```

生成器默认写入 `apps/medical-query/.local/l0/l0-mock.sqlite`，不会改数据源注册表。它输出的是包含 `sources` 数组的对象，而 `PI_DATA_DIR/sources.json` 的顶层是数组。生成器始终输出 `id: l0_mock`：首次仅在不存在该 ID 时追加其中的源条目；切换快照时更新已有 `l0_mock` 的路径并保留其他源。禁止整份覆盖或追加重复 ID，否则当前查找逻辑可能继续选中旧快照。登记项包含 `id`、`name`、`path`、`dictionary_path`、`knowledge_path`；相对路径按 `PI_DATA_DIR` 解析。

```sh
# 配置完成后启动现有应用。
npm run start --workspace=@medical/pi-query
```

L0 网页入口为 <http://127.0.0.1:8787/?source=l0_mock>。是否存在 `knowledge_path` 决定当前 L0 分支；不要删除它、改 blocked 状态或绕过领域校验来强行执行 SQL。

修改知识 JSON、语义字典或运行数据库后，新建会话以使用新来源版本。DDL 本身不直接进入运行知识指纹，修改 SQL 文件不会自动迁移已存在的 SQLite：应生成新快照，再核对表列、外键和绑定。

### 现有匹配输出契约

使用当前 `l0_schema_linking` profile 时，返回一个 `linking` 对象，必须包含以下八个数组：

```json
{
  "linking": {
    "metric_ids": [],
    "tables": [],
    "fields": [],
    "relations": [],
    "candidate_relations": [],
    "time_fields": [],
    "code_filters": [],
    "unresolved_rule_ids": []
  }
}
```

这只是结构示例。匹配存在时填写实际引用，不能为通过校验统一返回空数组。除 `code_filters` 外，各数组元素都是字符串；`fields` 使用 `table.column`，`time_fields` 同时出现在 `fields` 中。

`relations` 只放本次 `relation_bindings` 中非空的 `runtime_id`，`candidate_relations` 只放候选的稳定逻辑 ID。`code_filters` 每项只含 `field`、`op`、`value`；当前允许的操作为 `eq`、`ne`、`in`、`not_in`、`is_null`、`is_not_null`。条件值必须有依据且类型正确，未绑定参数不输出伪造的 `value: null`。`unresolved_rule_ids` 只引用已有 `issue_id`。

匹配输出中的 `code_filters` 是证据集合，不是可直接执行的全局 WHERE；计算阶段仍须回到分子分母的条件树。当前 profile 的输出不包含 SQL、指标数值、完整规则副本或模型自行改变的执行状态。

## 6 计算边界与重点指标

当前基础引擎支持基础聚合、去重计数、AND 过滤、分组排序和有明确关系的 INNER/LEFT 等值关联。比率、派生公式、EXISTS、窗口计算和同表多角色关联等仍需扩展。`required_operators` 和 `required_engine_extensions` 是需求描述，不是已实现算子的注册表。

若后续任务明确要求数值计算，应逐项完成规则确认、数据绑定、关系确认和算子验证，并另行计算运行就绪状态；保留原始包的来源阻断记录。不得通过删除复杂条件、换分母或简化公式后继续使用原指标名称。

| 指标或指标组 | 使用时必须保留的区别 |
| --- | --- |
| 国考 GK-03/04/05/06 与上海手术指标 | 国考解释包含同次住院按人数去重，上海部分指标按手术台次；兼有手术与介入的跨类计数仍有待确认项 |
| GK-17 | DDD 剂量单位及标准版本要一致，出院带药排除，CMI 校正仍有缺口；不能用预计算强度代替原始消耗 |
| GK-23 | 一挂号多预约的时刻配对、成功预约缺报到或叫诊的分母处理未明确；缺时长不能默认零等待 |
| SH-PS-M0085 | 保留 48 小时、31 天两个输出；前后手术各接自身住院并核对同患者，不强制跨期再手术属于同次住院 |
| SH-PS-M0093 | 再入院与索引出院是两个住院角色；分母排除死亡，0—31 天的端点及跨院识别待确认 |
| QC-NQI-08 | 分子按患者与统计周期去重，分母为期初在院加期间新入院；特殊损伤类型与 24 小时边界须保留 |
| QC-ICU-11 | 保留 APACHE II 等原始模型输入、Logistic 风险及多层比率；实际病死率子公式与队列细节有缺口 |
| SH-PS-M0060/M0061 | 需要全市同 DRG 基准、版本及病例数加权，不能从单院原始库伪造全市基准 |
| SH-PS-M0645、SH-PS-S012 | 前者只给“折算得分”而无折算式；后者为四项各 1 分的现场定性评审；两者的 `formula_text: null` 要保留 |

## 7 验证与评测隔离

接入验收至少检查：

- 五份 JSON 可解析，`manifest.format_version` 为 `l0-schema-v1`，清单数量与实际指标数一致；当前快照预期 47 项。
- 指标、实体、字段、关系、缺口 ID 唯一，所有引用存在；字段所属实体、分子分母条件、时间和依赖能追溯。
- DDL 可在空 SQLite 执行；语义文件的表列真实存在，字段绑定唯一，外键完整列对与关系元数据一致。
- 代码值类型、单位和转换来源正确；32 条声明关系和 7 条候选关系保持区分，禁止候选自动执行。
- 每项输出保留未明确口径与引擎缺口；没有真实医院资料时，实际映射为空，不能把指标标为已可计算。
- 若造少量新 mock 数据，覆盖机构复用局部 ID、一对多放大、纳排、跨期、NULL 和零分母；存原始事实，不存标准指标答案。

在当前项目，可使用以下已有离线检查；若修改代码，还需按仓库规则运行相应检查。

```sh
# 离线验证合成库生成器。
python3 -m unittest discover -s apps/medical-query/test -p 'test_l0_fixtures.py'

# 离线验证知识加载与引用校验。
node --import ./scripts/issues/register.mjs --conditions=source --test apps/medical-query/test/l0-knowledge.test.ts
```

独立标准答案 `apps/medical-query/fixtures/l0-linking-cases.json` 位于知识目录之外。开发时可以维护评测，但不能将 gold、预期字段列表或评分规则注入产品提示词、语义字典或检索索引。

```sh
# 按用户的评测任务运行；该命令经运行中的服务调用已配置模型。
npm run eval:linking --workspace=@medical/pi-query -- --concurrency 5 --limit 0
```

评测同时核对指标、表列、业务时间、完整关系列对、候选关系、代码类型和阻断状态。仅匹配到名称或统一拒答不能算通过。报告记录实际数据包与数据库指纹、流程版本、题集、配置和运行结果；样本数据不足、接口能调用与医学口径正确是不同结论。

上述评测需要已登记 `l0_mock` 且 HTTP 服务正在运行；L0 评测入口拒绝 `--standalone`。默认只运行前 3 题，`--limit 0` 才运行当前全部题集；客户端并发不能扩大服务总额度。中途修改来源或流程版本会使快照无效，不能将该次结果当作有效质量分数。

## 8 可直接交给 Claude Code 的启动指令

将下面指令与本说明、原始六文件一并提供。若不在当前仓库，先把文件放到一个确定目录，并替换数据包路径。

```text
请阅读 docs/l0-claude-code-guide.md，并将 apps/medical-query/fixtures/l0/ 下的 manifest.json、metrics.json、logical_requirements.json、mock_schema.sql、mock_semantics.json、binding_gaps.json 作为 Pi 智能问数的指标规则输入。

先读取项目 AGENTS.md，检查已有 L0 加载器、建库器和匹配链路。复用现有实现，先完成或核验数据包加载、空 SQLite 建表、引用与绑定验证，以及“指标识别 → 字段/关系/代码/业务时间匹配 → 缺口说明”的流程。已有功能核对后继续使用，不重复建设。

保留文档规定、推导需求、synthetic 测试设计和真实医院映射的区别。未知口径保持 null 并关联 issue_id；真实医院绑定保持为空。分子分母条件分别保留 AND/OR/NOT、粒度和业务时间，候选关系不执行，代码比较保留原始类型，必要转换须有已登记的依据，官方目录参数不以局部枚举代替。

当前 L0 profile 只做 Schema Linking，保留 blocked 状态。不要修改六个源文件来绕过限制，不自动实现全部指标计算。后续我若指定数值计算任务，逐项按完整规则、原始事实、已确认绑定和所需算子推进。

评测 gold 与产品知识隔离。完成后报告：读取的数据包版本和数量、复用或改动的文件、逐项检查结果、仍缺的定义/医院映射/关系/引擎能力。代码改动添加有意义的中文注释，并按项目规则检查；文件改动留下不超过12条的 Markdown 变更总结。
```

配套阅读：[应用启动与配置](../apps/medical-query/README.md)、[L0 接入与评测记录](l0-linking-evaluation.md)、[原始数据包变更记录](l0-change-summary.md)。
