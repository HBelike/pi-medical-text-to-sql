# Pi 智能问数：运行与评测工作台

问数与评测共用 Pi Durable 任务、Pi AI 网关和一份模型额度。当前交付涵盖单机多进程执行、持久实验、恢复对账、分层评分归因、比较、质量门和黑白主题工作台。设计依据是[完整产品方案 v3](../../docs/metric-evaluation-design.md)，实际验证结果与未通过项见[验收记录](../../docs/evaluation-acceptance-report.md)。

## 启动与页面

需要 Node.js 24 及以上、Python 3。Python 领域服务只使用标准库。首次克隆后，在仓库根目录复制配置样例：

```sh
cp apps/medical-query/.env.example apps/medical-query/.env.local
```

在 `apps/medical-query/.env.local` 中填写个人 `PI_MODEL_API_KEY`；默认模型为 DeepSeek 的 `deepseek-chat`，如使用兼容网关，再调整模型端点与模型名。然后在仓库根目录安装依赖、生成本地合成医院数据并启动：

```sh
npm ci --ignore-scripts
npm run fixtures --workspace=@medical/pi-query
npm start
```

本地配置样例见 [.env.example](.env.example)。`.env.local` 与生成的数据位于忽略目录，不随源码提交；修改配置后重启服务。

- 问数首页：<http://127.0.0.1:8787/>；提示词和证据链在提问后展开，支持拖动调宽、黑白主题、澄清补充及取消。
- 问答记录：<http://127.0.0.1:8787/history>。
- 新版评测中心：<http://127.0.0.1:8787/evaluation/tasks>；按任务查看进度、评分与耗时，打开右侧详情抽屉并展开逐题执行证据，也可选择题集和模型发起评测。
- 旧版评测工作台：<http://127.0.0.1:8787/evaluation>；继续提供重评裁定、模型对比、质量检查、配置激活和产物管理。
- L0 知识匹配：<http://127.0.0.1:8787/?source=l0_mock>。源由本地注册表管理，首页隐藏数据源信息。

新版发起窗口使用现有的 `questions.jsonl` 与 `gold.jsonl` 成对导入格式。当前运行方案只支持独立选择决策模型（理解、规划与修复）和答案模型；选表检索与 SQL 执行沿用冻结方案的既有实现，不提供虚假的独立模型开关。列表的准确率按已有有效评分中的正确题次 / 已判定题次计算，未判定或未评分题次不进入该分母。

首次运行上述命令会生成两所合成医院；已有数据会拒绝覆盖。L0 与百表夹具的生成、登记及独立 gold 见[L0 百表数据说明](../../docs/l0-benchmark-data.md)。本机已有 106 张表、136,742 行、136 道题，均为合成数据。演示相对时间基准为 `2026-10-15T12:00:00+08:00`。

## 并发与预算

环境变量优先于本地配置；非法值阻止启动。实验的并发只限制自身，不能扩大全局额度。

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `PI_MAX_ACTIVE_RUNS` | 5 | 活动任务总额度，1～10 |
| `PI_LLM_MAX_CONCURRENCY` | 5 | 所有角色、重试、修复共用的在途模型额度，1～10 |
| `PI_EVAL_MAX_ACTIVE_RUNS` | min(5, 总额度) | 评测活动任务子额度 |
| `PI_QUEUE_MAX_PENDING` | 100 | 总等待队列，1～10000 |
| `PI_ONLINE_QUEUE_RESERVE` | min(20, 队列容量/5 向下取整) | 在线请求保留等待位置 |
| `PI_SQL_CONCURRENCY` | 2 | SQL 子进程共享额度，1～10；评分另用共用的两个子进程名额 |
| `PI_QUEUE_WAIT_TIMEOUT_S` | 300 | 准入和资源等待超时 |
| `PI_LLM_REQUEST_TIMEOUT_S` | 120 | 单次模型请求超时 |
| `PI_RUN_TIMEOUT_S` | 600 | 单个活动运行段超时，等待用户补充不计入 |
| `PI_TURN_REPAIR_LIMIT` | 1 | 单题修复次数上限，0～2 |
| `PI_TURN_MODEL_CALL_LIMIT` | 8 | 单题累计模型调用预算，1～32 |
| `PI_RESULT_MAX_ROWS` | 5000 | 内部完整结果行数上限，1～100000；页面预览最多 200 行 |
| `PI_RETRIEVAL_STRATEGY` | progressive | 轻量目录选表并按需补读；lexical、full_catalog 保留对照 |
| `PI_RETRIEVAL_TOP_K` | 5 | 渐进模式每轮最多5张新表；旧策略未设置时默认12，必要依赖另行展开 |
| `PI_RETRIEVAL_MAX_CONTEXT_CHARS` | 256000 | 检索上下文字数预算；超限明确失败 |
| `PI_ACCOUNT_RPM` / `PI_ACCOUNT_TPM` | 未设置 | 供应商账户每分钟请求/令牌限额；设置后统一预约 |
| `PI_RESOURCE_SCOPE_ID` | primary-account | 共享配额的账户标识 |

同一会话串行；在线优先，持续有评测等待时给予最低服务份额，不同实验和方案轮转，空闲额度可借用。已发出的请求不会因高优先级任务到达而强行终止。安装级控制进程锁防止换数据目录重复领取额度。多客户端、多 SQL/评分进程都经过同一控制端；未实现跨机器分布式调度。

RPM/TPM 在准入时统一预约，发送时间与提供方回执持久化。完整用量回执用于结算；缺失或不完整的用量保留估算和未知标记。429 的 `Retry-After` 冷却在重启后继续生效；408/5xx 没有证明上游结束时仍按未知调用处理，不自动重发。速率等待不占在途模型名额，尚未发送的预约也不会在准备阶段被提前清走。

## 创建实验与统一 CLI

工作台、API、CLI 写入同一实验账本。CLI 不加载密钥，不启动第二份模型池，退出也不会取消服务端实验。旧的 `--standalone`、`--limit`、`--concurrency` 参数已停用。

```sh
npm run eval --workspace=@medical/pi-query -- --help
npm run eval --workspace=@medical/pi-query -- GET datasets
npm run eval --workspace=@medical/pi-query -- GET variants
npm run eval --workspace=@medical/pi-query -- POST experiments request.json
npm run eval --workspace=@medical/pi-query -- GET experiments/实验ID/export - experiment-export.json
```

`request.json` 使用查询得到的实际数据集与方案 ID：

```json
{
  "idempotency_key": "my-experiment-001",
  "name": "提示词与修复策略对照",
  "dataset_id": "替换为数据集ID",
  "variant_ids": ["替换为方案ID"],
  "concurrency": 5,
  "repeats": 3
}
```

方案冻结模型、修复策略、检索方式和预算；实验冻结题目×方案×重复次数的完整矩阵、源快照与代码指纹。运行中代码变化会阻止新派发，不能把不同代码的结果混为一个实验。质量政策、比较协议应在实验创建时冻结。

API 均位于 `/api/eval/`，详情见 [http.ts](src/evaluation/http.ts)：

| 入口 | 用途 |
| --- | --- |
| `config`、`datasets`、`variants`、`experiments` | 读取当前评测模型配置，查询或创建冻结数据集、方案和实验 |
| `experiments/:id/overview`、`questions` | 汇总已保存的评分与耗时，筛选分页逐题记录 |
| `experiments/:id/slots`、`events` | 分页逐题状态、增量事件 |
| `experiments/:id/commands` | 暂停、继续、取消、显式续跑 |
| `experiments/:id/score-sets` | 只重评已有观察，不调用模型；保留旧评分 |
| `slots/:id`、`slots/:id/reply` | 逐题证据与澄清补充 |
| `status`、`operations`、`operations/:id`、`operations/:id/reconcile` | 共享资源状态、调用账本索引与按需详情、未知调用对账 |
| `comparisons`、`adjudications` | 对比与有证据的裁定 |
| `release-decisions`、`activations` | 质量判断与默认方案激活 |
| `experiments/:id/export` | 导出观察、评分和证据索引 |
| `artifacts/:id/impact`、`DELETE artifacts/:id` | 查询删除影响并显式删除产物 |

修改请求需带幂等键；版本敏感操作还需 `expected_revision`。CLI 缺省生成幂等键并在请求前打印，断网重试应复用该键。导出文件拒绝覆盖。可通过 `PI_EVAL_URL` 指定控制端。

## 恢复、评分和发布

未派发任务可恢复，已完成槽位不重跑。模型已发出但缺少完成证据的调用保留为结果未知，并占用未释放预约；先对账，再由显式续跑创建新尝试，保留旧尝试及费用不确定性。服务端接受请求后客户端断线，可用相同请求身份读取已有任务。

完整产物保留至手动删除。删除先记录影响与墓碑，提交成功才删除文件；物理清理失败可重试。已删除、损坏、丢失证据分别标识，相关实验不得继续声称可完整重放。

评分分离行动、结果、语义、发布、答案和过程；单纯结果相等不代表任务全部正确。每题可查看首次产物、修复事件、局部复核、最终评分和错误归因。检查器故障和缺证据不能计成模型答错。裁定产生新 gold/评分版本，并对所有受影响方案重评。

严重约束违规阻断发布。质量阈值、必要覆盖或证据缺失时显示“证据不足”；耗时、令牌和费用只作提示，未知费用保持 null。严格对比核对冻结协议、预算与已验证模型版本；供应商未提供实际版本时，不输出严格因果结论。

主对话只展示通过发布校验的完整数值；未通过的候选在工作台用于诊断。结果超限时停止发布，不从预览推断全部数据。

## 模块与边界

```text
问数网页 / 评测工作台 / CLI
  → server → Application / EvaluationService
  → Pi Durable 任务、会话顺序、共享资源与调用账本
  → Pi AI 模型调用 → 字段绑定 / 受约束 DSL / 有界修复
  → Python 子进程 → SQLite 只读执行 → 校验与发布
  → 冻结观察 → 独立评分子进程 → 评分版本 / 比较 / 质量门
```

Pi 上游核心未修改。模型不能直接提交任意 SQL；执行器只接受受约束 DSL。普通问数先披露全库轻量目录，再读取选中表字段、代码与关系，最多两轮追加；DSL 必须有本轮已读元信息及需求覆盖依据。L0 继续先识别指标、完整展开规则依赖并保留阻断。旧词法检索与完整目录可作对照，检索不能改写权威规则。详见[渐进披露设计与使用](../../docs/progressive-schema-disclosure.md)。当前没有证明向量检索收益，因此没有引入向量库。

运行账本位于 `.local/runtime.sqlite`，评测账本和不可变产物位于 `.local/evaluation/`；实验报告可导出到 `.local/evaluations/`。数据源、题集、运行和评分相互隔离。

47 项 L0 的正式医院计算 gold 仍为 **0/47**。现有合成事实题不能替代医院口径与绑定验收；未支持的 DSL 运算应明确失败。百表存在不等于百表业务覆盖。真实模型题集结果、已测并发规模及测试局限以验收记录为准。

## 验证

从仓库根目录执行：

```sh
npm run check
npm run check --workspace=@medical/pi-query
python3 -m unittest discover -s apps/medical-query/test -p 'test_*.py'
```

TypeScript 回归采用 Node 测试运行器逐项运行应用测试文件，不运行上游会触发外部端点的全量 Vitest。实测命令、次数、故障注入、规模与浏览器证据见[验收记录](../../docs/evaluation-acceptance-report.md)、[规模报告](../../docs/evaluation-scale-report.md)和[持续负载报告](../../docs/runtime-load-report.md)。真实模型实验需运行中的控制端，会消耗已配置网关额度。
