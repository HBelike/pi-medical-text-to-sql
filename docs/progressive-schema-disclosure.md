# 渐进式 Schema 披露

更新：2026-10-23。范围为普通问数的选表、元信息读取和 DSL 规划；没有修改 Pi 上游核心、引入新框架或开放任意 SQL。

## 目标与依据

百表目录不应在首次模型请求中展开全部字段。首轮让模型查看所有表的轻量索引，选择最多五张直接相关表；字段、代码和已确认关系按需读取。首次选择可以纠正，完整的必要规则不能被字符截断。

实施前只读核查本机 106 表包：完整目录 407,798 Unicode 字符；ID、表名和 description 的精简索引 12,041 字符。现有词法 Top 12 加依赖对 40 道事实/合成题的必需表覆盖为 40/40，实际披露 15–30 表、153,505–237,825 字符；Top 5 加依赖为 38/40，遗漏 L0F-016 的操作表和 L0F-017 的事件表。这是检索与上下文体积核查，不是 LLM 准确率或速度评测。现有 `metric_bindings` 约 115,445 字符，说明仅减少字段不足以解决输入体积问题。

Firecrawl developer 检索因 HTTP 402 额度不足停止，改读以下官方来源：

| 候选 | 功能、维护与验证证据 | 采用取舍 |
| --- | --- | --- |
| LlamaIndex | [查询时表检索及列值检索](https://developers.llamaindex.ai/python/examples/index_structs/struct_indices/sqlindexdemo/)；[后台索引完整 schema 的源码](https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/objects/table_node_mapping.py#L42)；[SQL 测试](https://github.com/run-llama/llama_index/blob/main/llama-index-core/tests/indices/struct_store/test_sql_query.py)。检查到 2026-10-14 主分支提交；MIT。测试存在，本次未运行上游测试。 | 借鉴后台丰富索引与模型按需披露。引入其 Python、SQLAlchemy、workflows 等依赖会增加现有 TS/Python DSL 的适配成本，本次不引入。项目 README 已说明主要投入方向变化，不能仅靠知名度判断 SQL 模块投入。 |
| Wren AI | [memory fetch](https://github.com/Canner/WrenAI/blob/main/docs/core/reference/cli.md)按 schema 大小返回全文或检索，覆盖 model/column/relationship/view；[架构](https://github.com/Canner/WrenAI/blob/main/docs/core/reference/architecture.md)支持补取上下文及修复；[memory 测试](https://github.com/Canner/WrenAI/blob/main/core/wren/tests/unit/test_memory.py)。检查到 2026-10-23 主分支提交；core/sdk/skills Apache 2.0，docs CC BY 4.0，包仍标 Beta。 | 借鉴多粒度检索及可恢复取证。直接迁移需转换 MDL 并接入其规划、执行和向量依赖，超过本次范围。未运行上游测试，不推导医疗场景准确率。 |

## 调用链

`Application` 冻结配置 → `pipeline.ts` 读取当前来源 → `ProgressivePlanner` → `SchemaDisclosure.index/search/read` → 同一个 Pi AI decision 网关 → 需求覆盖与已读引用校验 → 原 DSL 编译、SQLite 只读执行、发布校验 → 原 answer 单元格选择。

首轮 `table_index` 包含全部真实表 ID、名称、description、别名，以及来源明确声明的粒度和时间角色；没有逐列定义、代码字典或全量指标规则。缺少描述时保留 null，不从名称猜业务含义。已有同源、同版本历史作为选择线索，但不自动赋予本轮已读资格。

后台仍以现有字段名、中文释义和代码含义检索；只把轻量表提示发给模型。`search_schema` 不算读取字段，也不授权执行。`read_schema` 累积已读表；桥接只使用已确认的关系，父外键必须与完整列对匹配，复合机构键不能遗漏。

普通 `semantics.metrics` 按明确所属表完整加载并展开字段依赖；大型 `metric_bindings` 通过 `metric_ids` 显式读取并完整展开指标依赖。未读取规则在 `disclosure_omissions` 中明确说明；未知全局约束保留。候选关系可以作为缺口材料，不能成为执行关联。

模型首先提取带稳定 ID 的必要数据需求，规划时逐项给出 `coverage`。程序要求每项都引用 DSL 实际使用且已经读取的表、字段或关系，并要求 `linking` 覆盖 DSL 引用。这只证明机械引用与清单完整性，不能证明模型已经识别原问题的全部语义或选择了正确的业务事实。

## 动作与预算

- `read_schema`：每轮最多五张新种子表，可同时请求明确的指标 ID；必要依赖可以超过五张。
- `search_schema`：描述缺少的字段、业务概念或代码，最多两次；重复搜索拒绝。
- 元信息读取最多三轮，包含首轮和两次追加；最多六个取证/规划动作。格式修复仍使用原 repair 预算，所有调用使用原全局模型调用预算。
- 索引和已读元信息总量使用冻结的 Unicode 字符预算。超限明确失败并留收据，不回退全库、不截断字段或规则。
- DSL 引用未读但真实存在的表时，先补读，再重新规划，不能直接交给全库编译器。补读草稿已有过滤条件必须保留；仅允许严格的空值谓词语法等价修正，或不存在字段在保留操作符和值时纠正。
- 正常空结果沿原流程返回，不作为补表或放宽过滤的理由。来源版本变化停止执行。

普通非空成功通常三次模型调用：选表、规划、回答；空结果通常两次。补查、格式修复或限流重试会增加次数，原单题预算继续有效。

## 配置与评测

新建在线任务默认 `PI_RETRIEVAL_STRATEGY=progressive`，默认 `PI_RETRIEVAL_TOP_K=5`；渐进模式将首轮上限限制为最多五张。`lexical` 和 `full_catalog` 保留为对照，未显式设置 Top K 时为 12。`PI_RETRIEVAL_MAX_CONTEXT_CHARS` 默认 256000。

显式本地配置或已激活方案优先于代码默认值；既有冻结实验不改写。代码变更需重启服务后使用，新代码指纹下创建新实验。工作台可选择三种策略并冻结预算。旧完整目录若超预算仍失败，不能把它作为自动回退。

L0 的 `knowledge_path` 分支继续先识别指标再完整展开知识依赖；`progressive` 在该分支映射为词法指标检索、12 个候选，保持两次 decision 和原有阻断状态，不进入物理表自选或 SQL 执行。

每轮索引、搜索和读取收据保存来源、版本、索引 hash、run_id、请求表、已读表、依赖表、指标和实际字符量。评分版本导出新增 `retrieval` 和按方案划分的 `variant_retrieval`：逐题首次/最终完整集合覆盖、缺表、读次数、字符量、已知/未知及恢复数量；仅统计最新运行段成功读取，搜索提示和失败读取不计作已读。缺少金标准或收据保留 null，L0 单列不适用，诊断不参与质量门。

评测器才可读取独立 gold；金标准不能进入索引、提示词或补读动作。当前诊断采用金标准 `required_tables` 标注的完整集合；存在合法替代解时应先完善标注，不能据此误判方案。结合结果正确率、实际 token、调用次数及全链路 P50/P95；不要用 SQL 可执行率替代答案正确率。

## 验证与边界

定向测试采用真实 SQLite、Pi Durable 与模型替身，覆盖首选错误后恢复、字段/代码搜索、未读引用、候选关系、复合外键、规则闭包、读取上限、预算失败留证、来源变化、历史继承、需求覆盖和过滤保护。实际执行结果记录在[变更总结](progressive-schema-disclosure-change-summary.md)。没有新增数据表或修改原始指标定义、独立 gold。

最终模块在本机原 106 表库上完成只读冒烟：完整轻量索引 16,491 Unicode 字符；手工指定“事件＋患者”“财务分录”“实际用药＋DDD 标准”三组种子并展开依赖，索引与局部目录合计分别为 64,345、58,365、46,458 字符，大型指标绑定未显式请求时加载数为零。这些是代表性结构投影，不是模型选表实验，也不是全链路提示词 token 测量。

当前没有运行新旧方案的真实模型对照，不报告 token、时延或准确率提升。固定 Top 5 且禁止补读的额外消融方案尚未登记为独立运行策略；可先比较 progressive 与 lexical，再按评测需要补充消融。新增模型调用是否抵消输入缩减收益，仍需冻结模型、源快照、问题和并发后验证。
