# 问数评测 v2：开源案例与采用记录

调研日期：2026-10-19。配套：[评测设计 v2](metric-evaluation-design.md)。目标是改进现有 Pi 医疗问数的验收方法，优先复用已安装能力；本轮不安装框架、不运行外部榜单、不调用真实模型。

## 1. 调研方式及结论

先使用 Firecrawl 开发者索引检索 Agent 评测和 Inspect；普通抓取额度已耗尽，随后通过官方仓库、官方文档和 GitHub 公共 API 核查。索引结果仅用于发现，下面的决定基于一手材料。仓库最近提交、许可和目录结构已查看；未安装运行上游测试，不能据此声称测试全部通过。

推荐保留 Pi 与当前 HTTP 业务入口。借鉴成熟项目的任务契约、评分方法和实验协议，新增薄适配器及独立评分函数。各案例解决不同问题，不选一个框架包办全部验收。

## 2. 候选方案对比

| 候选 | 匹配度及采用内容 | 文档、测试及维护证据 | 许可与接入成本 | 决定 |
| --- | --- | --- | --- | --- |
| 本地 Pi / 已安装 vitest-evals | 高：case×variant×repetition、运行记录、harness/judge 分离 | 已读本地 evals 文档、通用类型和业务运行代码；现有 coding-agent harness 不适配本应用 | Pi 为 MIT；已有依赖，薄 HTTP 适配成本低 | 优先复用通用 API；不依赖 private 包的内部实现，不改 Pi 核心 |
| Test Suite SQL Eval | 高：发现单个数据库上“碰巧相等”的 SQL | 有论文说明、比较与执行脚本；仓库最新提交为 2022 年，属于较老研究实现 | Apache-2.0；SQLite 适配容易，构造有效多快照及独立 gold 有成本 | 借鉴测试套件思想，保留医疗业务的严格列角色、去重、单位语义 |
| Spider2 | 中高：大目录、业务资料、执行任务与产物 | 有多任务说明、样例及评测脚本；2026 年有更新，最新提交属文档维护，不能推断运行质量 | MIT；Lite 含 SQLite，完整迁入还涉及云库与其他运行条件 | 借鉴复杂度和覆盖设计，不搬整套 Agent 或云环境 |
| BIRD-Interact | 高：歧义澄清、后续修改、交互预算 | 有 ADK/Agent 文档、接口与运行说明；2026 年仍有文档更新；完整 gold/testcases 需另行申请，本轮未取得 | 代码 MIT、数据 CC-BY-SA-4.0；主 ADK 的服务和环境成本高，另有官方 SQLite Mini-Interact | 先做确定性用户脚本，参考案例结构；不引入第二套 Agent 或用户模型 |
| τ-bench（仓库 tau2-bench） | 高：最终任务结果、约束和重复稳定性 | 有 evaluation 文档、tests 和发布记录；2026 年仍活跃，当前 README 已展示 τ³，不能把 main 当固定 τ² | MIT；Python 3.12～3.13、uv、LiteLLM 和模拟用户带来新运行栈 | 借鉴判定和可靠性统计，不复刻服务及用户模拟器 |
| Inspect AI | 高：执行与评分分离、多评分器、日志重评 | 官方文档完整，仓库有测试，2026 年持续更新；本轮未运行其测试 | MIT；迁入 Python 运行器会重复当前 TypeScript/Pi 执行层 | 采用观察留存、版本化重评和错误分类，保持现有运行器 |
| EHRSQL-2024 | 中高：医疗问数的可回答性、错误回答风险 | 有任务说明、评分实现及比赛基线；2026 年最新提交属 README 更新，不等于评测器持续改进 | 仓库 CC-BY-4.0，底层 MIMIC-IV demo 另有 ODbL-1.0；SQLite 方法容易参考，数据规范不同 | 借鉴拒答与风险分项；不以其题库替代 L0，不照抄宽松结果比较 |

许可证记录用于说明评估时的接入条件。本轮没有复制外部代码或数据；未来实际引入时按选定版本和文件确认适用许可。

## 3. 关键方法及适用边界

### SQL 正确性：多快照，但不宽松处理业务角色

[Test Suite 官方说明](https://github.com/taoyds/test-suite-sql-eval/blob/e97acc546ecbee8fa27fa8dbf025ef61493a876c/README.md)通过多个数据库区分候选与参考 SQL 的行为。我们的适配是冻结实际首次候选，重放机构键、去重、时间边界、单位和分子分母反例；重放期间不让模型修正，再将完整问答重跑单独计分。

[上游比较器](https://github.com/taoyds/test-suite-sql-eval/blob/e97acc546ecbee8fa27fa8dbf025ef61493a876c/exec_eval.py)允许列排列等处理；默认流程对 DISTINCT 的处理也不适合作为医疗规则。我们保留 DISTINCT、不使用 gold 值替换选项，并按业务列角色比较。有限快照能提高检错能力，不能证明 SQL 普遍等价。

[EHRSQL 评分代码](https://github.com/glee4810/ehrsql-2024/blob/f9e1aa02160d39e3f8df52bf5c69c5cf2e472499/scoring_program/scoring_utils.py)存在只比较前 100 行、数值保留三位、字符串化与排序的处理。当前项目必须核验完整结果及声明的单位/容差，不能直接使用该比较器当正式计算验收门。

### 大目录及交互：测实际输入和任务，不只报表数

[Spider2 官方任务说明](https://github.com/xlang-ai/Spider2/blob/cafb867313aab4e674652054198f383cf4018943/README.md)展示多来源业务上下文和复杂工作流；[Lite 评测说明](https://github.com/xlang-ai/Spider2/blob/cafb867313aab4e674652054198f383cf4018943/spider2-lite/evaluation_suite/README.md)提供执行评测方式。其 Lite 包含 135 个 SQLite 任务。对本项目的启发是记录候选目录、知识输入和业务覆盖；“106 表存在”不等于“106 表业务均被考核”。使用参考 schema 的 oracle 条件必须单列，不可与自然检索混报。

[BIRD-Interact ADK](https://github.com/bird-bench/BIRD-Interact/blob/451fe2c3518ee1cf908d8139e2913483bd519381/BIRD-Interact-ADK/README.md)可参考澄清和任务修改的交互形式。其主方案环境较重，但[官方主页](https://bird-bench.github.io/)另有 [Mini-Interact SQLite](https://huggingface.co/datasets/birdsql/mini-interact)，不能笼统判断为不支持 SQLite。[Agent 说明](https://github.com/bird-bench/BIRD-Interact/blob/451fe2c3518ee1cf908d8139e2913483bd519381/bird_interact_agent/README.md)的完整 gold 申请机制用于控制污染，本轮未申请或发送邮件。

[BIRD Mini-Dev](https://github.com/bird-bench/mini_dev/blob/abd11b6db92a1c9f809b32f7564c7c71b34d67f0/README.md)还提示应明确额外专家 evidence 的输入条件。因此本项目的登记规则投影、全目录输入、将来的 RAG 召回应分别记录，不能把一个模式的优势解释成另一个模式的能力。

### 最终结果和重复稳定性：允许有效路径不同

[τ 官方评价说明](https://github.com/sierra-research/tau2-bench/blob/main/docs/evaluation.md)按任务选择最终状态、沟通和动作等判据；参考动作可以用于生成预期最终状态，并非每个任务都要求复制工具路径。只读问数的数据库自然不变，故本项目必须同时核对答案和结果，不能直接以 DB 一致判成功。

[τ 指标实现](https://github.com/sierra-research/tau2-bench/blob/96a3ef92329baf908ffe9dfe188cea34e8701d2a/src/tau2/metrics/agent_metrics.py)的 `pass^k` 为 `C(成功次数,k)/C(总次数,k)`，每任务计算后再平均，衡量 k 次均成功的可靠性，区别于至少成功一次的 pass@k。我们保留预定产品失败与超时，不以挑选成功重复提高分数。2026 年上游还调整过部分域的判分，说明 scorer 版本必须跟随报告。

### 独立评分：重评不重新生成

[Inspect 多评分器](https://inspect.aisi.org.uk/multiple-scorers.html)支持保留多维结果；[评分工作流](https://inspect.aisi.org.uk/scoring-workflow.html)支持生成后再评分和重新评分。对应设计是留存不可变观察，以不同版本评分器重评，既节省多次 LLM 调用，也让旧新评分差异可审查。

[Inspect 错误处理](https://inspect.aisi.org.uk/handling-errors.html)说明失败及部分状态可以纳入评价，但需要区分 Agent 失败和评分错误。我们据此明确：产品失败留在分母；驱动器、gold 或评分器失效会使报告不完整，不把剩余成功样本包装成全量成绩。

### Pi 接入：借接口，保留应用调用链

已核查本地 [Pi evals 文档](../packages/evals/README.md)及已安装 `vitest-evals` 的通用 harness/judge 类型。建议 `createHarness` 包装现有 HTTP 查询、回复、轮询和取消接口，`createJudge` 复用独立纯评分函数；coding-agent 的提示词、工作目录和 Docker 文档对照流程不引入本应用。

这项接入仍需实施。现有两套应用评测器尚未读取百表包的 136 题，也未形成完整首次候选和修复尝试契约。不能把本轮设计写成已完成的新评测能力。

## 4. 版本证据

以下为检查时的仓库版本，不代表生产依赖已升级；最新提交日期尤其可能只是文档维护。涉及代码行为的链接尽量固定到提交，动态官方文档以本次访问日期为准。

| 项目 | 核查提交 | 提交日期 |
| --- | --- | --- |
| 本地 Pi | `550f1f3ecd75bf756ab3c379ca9503e808a6c6d1` | 本地版本，非远端最新声明 |
| Test Suite SQL Eval | [e97acc5](https://github.com/taoyds/test-suite-sql-eval/commit/e97acc546ecbee8fa27fa8dbf025ef61493a876c) | 2022-08-03 |
| EHRSQL-2024 | [f9e1aa0](https://github.com/glee4810/ehrsql-2024/commit/f9e1aa02160d39e3f8df52bf5c69c5cf2e472499) | 2026-06-25 |
| BIRD-Interact | [451fe2c](https://github.com/bird-bench/BIRD-Interact/commit/451fe2c3518ee1cf908d8139e2913483bd519381) | 2026-03-29 |
| Spider2 | [cafb867](https://github.com/xlang-ai/Spider2/commit/cafb867313aab4e674652054198f383cf4018943) | 2026-08-12 |
| τ / tau2-bench | [96a3ef9](https://github.com/sierra-research/tau2-bench/commit/96a3ef92329baf908ffe9dfe188cea34e8701d2a) | 2026-10-15 |
| Inspect AI | [a699376](https://github.com/UKGovernmentBEIS/inspect_ai/commit/a699376315c95b6410f5aec01af37c8dec452aea) | 2026-10-16 |

官方仓库许可与入口：[Pi](https://github.com/earendil-works/pi)、[Test Suite](https://github.com/taoyds/test-suite-sql-eval)、[Spider2](https://github.com/xlang-ai/Spider2)、[BIRD-Interact](https://github.com/bird-bench/BIRD-Interact)、[τ](https://github.com/sierra-research/tau2-bench)、[Inspect](https://github.com/UKGovernmentBEIS/inspect_ai)、[EHRSQL-2024](https://github.com/glee4810/ehrsql-2024)。

## 5. 本项目的采用优先级

先落实 **Pi 薄适配＋Inspect 式独立重评＋EHRSQL 式可回答性分组**，让现有 136 题形成可信基线；再落实 **Test Suite 式定向多快照＋Spider2 式真实业务覆盖＋BIRD 式多轮脚本**；最后以 **τ 式重复可靠性和最终任务判定**，对归因修复进行配对评价。

已有合成数据继续使用自己的 L0 规范和独立 oracle。公开项目提供方法参照，不作为医院正式口径、生产事实或 gold 的来源。
