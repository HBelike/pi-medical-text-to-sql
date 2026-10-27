# 新版评测中心设计记录

更新：2026-10-23。此页对应 `/evaluation/tasks`；原 `/evaluation` 仍是旧版工作台。

## 目标与界面

用户提供的七张企业原型确定了交互主线：评测记录列表支持名称、题集、答案模型筛选；点“详情”打开右侧抽屉，先看任务摘要、模型覆盖、评分/耗时和归因，再滚动到逐题列表并展开执行过程；“发起评测”弹窗选择题集、并发和各环节模型。新版沿用问数应用现有黑白主题与语义色，而不是复制原型的独立深色品牌样式。

## 技术取舍与调用链

- 页面入口在 `web/evaluation-tasks.html`，样式和交互分别在同名 CSS、JS。`server.ts` 仅增加固定静态资源白名单，问数首页和历史页链接到新版；旧版入口仍可直达。
- 列表调用 `GET /api/eval/experiments`，筛选、统计和分页由服务端完成。详情依次调用实验记录、`overview`、`questions`，展开单题再读取 `slots/:id`；展开时才获取较大的执行证据。配置弹窗读取轻量 `config`、已登记题集和方案，创建时沿用既有 `datasets`、`variants`、`experiments` 接口和幂等键。
- 评分展示只使用当前有效评分。已判定准确率是 `pass/(pass+fail)`；未判定、未评分和证据缺失不计为正确。全量通过率仅在全部题次已评分时显示。耗时分位数只基于有实际耗时证据的样本，失败检查项只称“归因分析”，不推断因果根因。
- 当前运行链路可单独冻结的模型角色只有决策模型与答案模型。原型中的六个环节在新版展示为真实的模型覆盖和执行环节；选表检索、SQL 执行等不创建无效的独立模型配置。上传沿用已实现的 `questions.jsonl` 与 `gold.jsonl` 成对格式。旧工作台保留重评、比较、质量门和产物管理能力。
- 页面不增加框架或 UI 组件依赖；原生 `dialog`、表格和表单足以实现抽屉、弹窗及下拉，直接复用现有 CSS 变量。轻量模型配置接口避免新页面为显示两个模型名而读取完整的长期运行账本。

## 已有方案调研

先尝试 Firecrawl；其检索返回 HTTP 402，因此改查下列官方文档与仓库。评估结果用于交互和信息架构，未引入第三方服务或代码。

| 方案 | 功能匹配与维护 | 文档、测试与许可 | 接入成本及决定 |
| --- | --- | --- | --- |
| [Langfuse](https://langfuse.com/docs/evaluation/experiments/data-model) | 评测集→实验→逐题→Trace 模型与[运行比较](https://langfuse.com/docs/evaluation/experiments/compare-experiments)匹配度高；[发布记录](https://github.com/langfuse/langfuse/releases)仍活跃。 | [贡献指南](https://github.com/langfuse/langfuse/blob/main/CONTRIBUTING.md)列出 Vitest、Playwright 与 CI；核心 MIT，`ee/` 另有商业许可。 | [自托管](https://langfuse.com/self-hosting/configuration/scaling)涉及 Web/Worker、PostgreSQL、Redis、ClickHouse 和对象存储；本项目已有统一账本，只借鉴信息层次。 |
| [Promptfoo](https://www.promptfoo.dev/docs/usage/web-ui/) | Web UI 的结果筛选、逐题详情、延迟与比较及 [Trace](https://www.promptfoo.dev/docs/tracing/)匹配度高；[PR](https://github.com/promptfoo/promptfoo/pulls)和[发布](https://github.com/promptfoo/promptfoo/releases)持续更新。 | [贡献指南](https://www.promptfoo.dev/docs/contributing/)列出 Vitest、Playwright；MIT。 | CLI/Node 与本地 SQLite 起步较轻，但[自托管说明](https://www.promptfoo.dev/docs/usage/self-hosting/)不建议生产单副本；替换现有调用和账本成本高，只借鉴交互。 |
| [Phoenix](https://arize.com/docs/phoenix/) | 数据集、实验、评估与 Trace 适合过程诊断；[发布记录](https://github.com/Arize-ai/phoenix/releases)活跃。 | [贡献指南](https://github.com/Arize-ai/phoenix/blob/main/CONTRIBUTING.md)覆盖测试；许可为 [ELv2](https://github.com/Arize-ai/phoenix/blob/main/docs/phoenix/self-hosting/license.mdx)。 | [部署](https://arize.com/docs/phoenix/self-hosting/deploying-phoenix)需单独服务与链路埋点，本次无需引入。 |

## 验证与边界

验证结果记录在[本次变更总结](evaluation-tasks-change-summary.md)。新页直接展示已有真实实验，未伪造截图中的任务数、模型清单或评分。独立删除评测、六个环节分别指定不同模型、单文件 `id/question/gold` 导入不属于当前已实现的接口；对应能力继续以现有工作台和题集契约为准。既有 4GB 历史库在 512MB Node 堆下的启动内存限制仍需另行处理。
