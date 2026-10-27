# L0 落库与 Schema Linking 验证

更新：2026-10-15。当前目标是验证指标识别、字段/关系/代码/业务时间匹配，以及不可计算边界；本期不实现 47 项指标的数值计算。

## 数据与知识来源

`apps/medical-query/fixtures/l0/` 的原始六文件保持不变、作为唯一规则来源。不另建可编辑知识库。新增 `mock_conventions.json` 仅承载标注为 `synthetic_test_design` 的样本约定，不能解除来源规则缺口或替代医院映射。

`python/build_l0_fixtures.py` 按原始 DDL 生成 `.local/l0/l0-mock.sqlite`：26 表、216 列，15 表共 94 条原始合成事实，11 表暂空。一个数据源包含 H001 样本及 H999 机构隔离对照，复用局部患者/就诊/住院编号；覆盖重复人次、排除项、日期边界、缺失时间、零等待、床日、科目余额和人工核查证据。没有预计算指标结果。生成器验证完整性和外键后排他发布，已有快照拒绝覆盖。

本机注册表已追加 `l0_mock`，保留医院 A/B。字段枚举优先读原字典；原字典未登记的合成枚举只经 `global_rules` 中 `extra_code_values.field_values` 明确登记，并保留合成来源。比如 GK17 的抗菌标志使用数值 0/1，字符串 `"1"` 不等价。

## 调用链与边界

`HTTP → Application → 共享运行队列 → L0Knowledge → 两次 ModelGateway decision → 引用校验 → blocked + 匹配证据`。

第一次调用只输入 47 项精简指标目录，识别最多 3 项指标；第二次按选定指标投影原规则、缺口、字段绑定、物理目录、代码及合成约定，不发送整份大字典。模型只生成匹配结构，服务器核对引用；没有匹配时返回空结构。知识 JSON 与可选约定纳入来源指纹，提示词纳入链路签名。

32 个实际 FK 按完整列对映射运行关系；7 个候选关联保留逻辑标识，不提升为可执行关系。45 项保留 `blocked_engine_and_hospital_mapping`，两项外部评分/人工审核保留 `blocked_rule_source`。L0 分支及领域入口均不允许执行 SQL。代码条件是匹配证据集合，不能把分子和分母不同条件误作全局 AND。

网页入口为 <http://127.0.0.1:8787/?source=l0_mock>，会话存储与原首页分开。首页仍隐藏数据源信息，保持黑白主题与双栏；左栏呈现两次实际提示词，右栏呈现真实阶段与匹配缺口，不套用普通查询的 SQL 执行层。

## 独立评测

标准答案存放在 `fixtures/l0-linking-cases.json`，位于知识目录之外。14 题独立手写，覆盖 8 项指标、同义问法、复合 FK、候选关系和无匹配。产品仅接收问题、固定时间和数据源，标准答案及评分规则不进入模型。

`src/l0-evaluate.ts` 先校验 gold 引用，再经本机 HTTP 共用运行、模型额度。默认并发 5、前三题；全题使用：

```sh
npm run eval:linking --workspace=@medical/pi-query -- --concurrency 5 --limit 0
```

逐项评分：指标、表、字段、业务时间、完整关系列对、候选关系、类型敏感代码条件、阻断状态。required 项必须全部出现，额外项需显式允许；反向关系和列对换序等价，缺机构键不等价。全题通过要求全部匹配且未执行 SQL，统一拒答不能通过。报告保留错误、用量、耗时、题集哈希、来源/链路版本；快照改变则质量分数无效。

## 方案调研

本轮通过 Firecrawl 阅读官方仓库，采用评测方法、不新增依赖：

| 方案 | 证据与取舍 |
| --- | --- |
| [RAT-SQL](https://github.com/microsoft/rat-sql) | MIT；页面显示 2026-10-08 归档。复现文档包含 CoreNLP/JVM、预处理和训练要求；完整训练器与当前 Pi/LLM 接口不同，接入成本高，本期不引入。未运行其训练或测试。 |
| [Spider](https://github.com/taoyds/spider) | 官方组件评测采用集合比较；借鉴按维度核对的思路，避免用字符串完全相同替代结构等价。没有复制其实现或数据集。 |
| [Test Suite SQL Eval](https://github.com/taoyds/test-suite-sql-eval) | Apache-2.0；抓取页面最新提交为 2022-08-03，有执行评测说明与样例，依赖 SQL gold/测试数据库。可计算阶段再评估接入；当前不替代独立 Linking gold。未运行其测试。 |

## 验证记录与后续

已验证：生成器 13 项、gold 6 项 Python 测试通过；最终 TypeScript 目标集共 45 项通过（新评分器 11、L0 后端 8、原评分器 16、模型 2、pipeline/trace 8）。后续收紧提示词时重跑 L0 8 项通过。全部 47 项知识投影可加载，45＋2 阻断状态保留。最终仓库根检查、应用格式与类型检查通过。

首轮真实 14 题在 4096 输出额度下 8 题匹配通过，6 题模型输出截断；评分器缺失证据汇总也暴露异常，已修复并加入回归。原始失败报告保留在 `.local/evaluations/l0-linking-2026-10-15T12-38-38-229Z-f655b95a.json`，不能视为完整有效基线。

第二轮仅把 L0 第二次调用额度调为 8192，识别及普通查询仍为 4096；额度写入实际调用记录及流程签名。并发 5、14 题耗时 112.6 秒，**9/14 全维度通过**；5 题失败为 3 次输出截断、1 次关系数组格式错误、1 次未知运行关系。报告 `.local/evaluations/l0-linking-2026-10-15T12-45-36-226Z-3bae73b5.json` 的来源快照有效，流程签名 `54cfd040c9dc10efd96930f86428034d87b3ff5b9ed14da8d5f1fbc488830ff8`。此分数只属于该版本、该合成题集。

随后明确关系仅返回 ID 字符串，最新签名为 `73cc6567755b87129c7601e997ec965bcf32aae4845016253f18709be1dcec42`。网页 GK23 单题重验完成两次调用，关系格式/表/字段/时间匹配通过，仍漏掉两个非空条件，**全维度未通过**。该记录为 `.local/evaluations/l0-ui-gk23-recheck.json`；未重跑最新版本全题集，不混合版本拼通过率。页面已验证实际提示词、四条真实阶段与不可计算边界，截图 `.local/ui-checks/l0-linking-verified.png`。

服务观测到运行与模型峰值均为 5，网页在线查询与评测共享该额度。后续需减少冗余知识输入、避免模型重新生成既定依赖，并补充业务口径；数值计算与真实医院评测仍未完成。

## SQLite 与 RAG 的选型建议（本轮调研，尚未实施）

SQLite 是存储，Schema Linking 是匹配任务，RAG 是检索资料后增强生成的方法，三者不互斥。当前 47 项精简目录约 2850 输入 token，已识别指标的第二阶段却达到约 7200～29600 token；实际还有关联重写错误与条件遗漏。因此优先优化指标包与确定性依赖展开，不能把问题直接归因于数据库类型。

建议继续以原始 JSON 为单一真源；需要表查询或维护页面时，将指标/别名/规则/依赖/版本导入 SQLite 派生目录。召回返回指标 ID，程序按 ID、规则版本、数据源补齐分子分母、过滤、粒度、业务时间、关系和缺口。模型负责指标选择、歧义和用户条件解析，不重复抄写已绑定字段。只有经过确认的定义与绑定才能进入后续编译执行。

先比较完整小目录、编号/别名/关键词检索；向量召回作为同义问法补充，需同题集验证召回率、依赖完整率、无匹配误报、token 与延迟再接入。保留并发 5 默认、10 上限；向量、重排或额外 LLM 调用不能绕开资源配置。中文全文检索需专门验证分词；[SQLite FTS5](https://www.sqlite.org/fts5.html#the_trigram_tokenizer) 支持子串检索，但 trigram 的全文查询不匹配少于 3 个字符的子串，不能直接当作完整中文语义检索。

| 官方方案 | 与本项目相关的事实和取舍 |
| --- | --- |
| [WrenAI 记忆系统](https://docs.getwren.ai/oss/concepts/memory_system)、[架构](https://github.com/Canner/WrenAI/blob/main/docs/core/reference/architecture.md) | MDL/业务知识是持久来源，LanceDB 为可重建索引；检索与语义定义分开。可借鉴其分层，不引入整套引擎。默认 grep 只做确认问答召回，向量 schema 检索需 memory extra；不可混用旧版 Qdrant 架构说明。 |
| [LlamaIndex 官方 SQL 检索示例](https://developers.llamaindex.ai/python/examples/index_structs/struct_indices/sqlindexdemo/) | 用表 schema 对象索引按需检索，适用于 schema 超出上下文；不会自动保证医疗指标分母、桥接关系与业务缺口完整，仍需指标依赖展开。当前规模不据此引入整个框架。 |
| [Vanna 经典 RAG](https://github.com/vanna-ai/vanna/blob/main/README_LEGACY.md)、[当前仓库](https://github.com/vanna-ai/vanna) | 经典 RAG 使用 DDL/业务文档/SQL 示例；2.0 已转 Agent 架构，主仓库页面显示 2026-03-29 归档。本期不作为新核心依赖。 |

以上通过 Firecrawl 查询官方文档与仓库，未安装或运行这些框架。LlamaIndex 为 MIT；Wren core/sdk/skills 为 Apache-2.0、文档为 CC BY 4.0，整套接入还需 MDL 迁移及引擎/索引依赖。此建议未将当前实现改为向量检索或新的可编辑知识库。
