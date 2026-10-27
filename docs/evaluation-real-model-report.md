# v3 真实 DeepSeek 实验记录

日期：2026-10-21。以下是固定执行版本的实际服务实验，区别于本机 SSE 替身测试。完整观察、评分与导出仍在应用 .local/evaluations/；可分享的逐题摘要、指纹及比较回执见 [JSON 证据](evidence/evaluation-real/20261021-summary.json)。

## 身份与条件

| 项目 | 值 |
| --- | --- |
| 全量实验 | e45b1553-d1b3-4e59-adbf-02e196a883a0 |
| 三组实验 | 927bab5a-9e22-43a8-810c-22f70002fcec |
| 冻结执行 hash | 7d664dc3269585e32543f864121e997b2b77b89c8319b45f6acfce526a0e58b0 |
| 数据集 | dataset-918f4a06cb9b73334a4c729fcb0dd38de916128e53717af614ac64cb1f9d05c0 |
| 全量评分 | scores-05fb6b1900dc8b03b108e78f02174e03d80ae809d69bd972d18326ea393e39f3 |
| 三组评分 | scores-a58a92049d69b21d25876ce55193f02a7dc0df3eefc553e89f536b7e5f5c0008 |
| 模型 | tencent-deepseek-v4-flash；供应商实际 revision 未核验 |
| 策略 | lexical，topK 12，256000 字上下文预算，单题模型调用上限 8 |
| 并发 | 两实验各配置 5，在线与评测共用实际总额度 5 |
| 修复对照 | off/0、targeted/1、ordinary_retry/1；其他允许差异按创建时协议冻结 |

全量 136 槽全部评分；终态 blocked=108、failed=12、completed=14、waiting_for_user=2。单轮澄清是可评分结束点，不由程序代用户补充。三组为 7 题×3 方案共 21 槽，不能取代全题集三组对照。

## 原始冻结契约下的质量

| 轨道 | 通过 / 计划 | 说明 |
| --- | --- | --- |
| clarification | 0 / 1 | 原 linking 档位 |
| no_match | 1 / 1 | 原 linking 档位 |
| official_metric_boundary | 43 / 47 | 匹配/阻断验证，不是正式指标数值验收 |
| official_metric_linking | 47 / 47 | 匹配/阻断验证，不是正式指标数值验收 |
| synthetic_calculation | 0 / 10 | 原 result_only 档位，列名按原 gold exact 契约 |
| synthetic_fact_query | 3 / 30 | 原 result_only 档位，列名按原 gold exact 契约 |

不将这些轨道合并为医院问数准确率。47 项正式指标完整数值 gold 仍为 0/47。全部 95 个正式/无匹配边界检查未发现执行或数值泄漏；正式边界整题仍有 4 个失败：GK-03 与 SH-PS-M0037 各多选另一个指标，GK-38 与 SH-PS-S012 的代码过滤被校验器拒绝。

40 个合成数值问题实际 completed=14、blocked=15、failed=10、waiting_for_user=1。已完成但未得分的 11 个样本均触发原列角色 exact 比较；例如 L0F-001 实际值 7、列名 completed_outpatient_registration_visits，gold 为 visit_count=7。此处没有把列名改写后计入成功。多列结果还需要明确角色对应，不能用“值一样”推断语义正确。CLARIFY 已追问科室、指标与时间，但原 gold 为逐字槽集合，仍记原契约失败。

实际能力失败另外包括：当前 DSL 不支持的运算、目录与执行器关系身份未对齐、输出长度截断、修复触及受保护条件，以及应答问题被转为澄清。它们保留计划分母，不能通过换 gold 为拒答消除。列角色/澄清概念的新版本契约与原分数分别保存，见[契约审查](evaluation-comparison-contract-review.md)。

进一步逐题核对：15 次非预期阻断中，13 次主要卡在当前 DSL 能力；2 次关联 ID 实际来自语义目录，旧执行器未将它们与相同物理 FK 对齐，不能简单归为模型幻觉。95 道预设阻断题实际为93 blocked＋2 failed，合成数值题15 blocked，因此总计108 blocked。详见[15题阻断清单与归因](evaluation-blocked-cases.md)。

## 修复、费用与可比性

全量 N=136，首次失败 F=49（必要条件已证明 23，完整观察失败 26），首次正确 C=87，首次未知 W=0；触发修复 T=23，最终救回 R=7。这些是当前冻结评分契约下的描述性计数，列名契约变化会改变整题分类，不能据此单独宣称因果收益。

全量记录 277 次调用，已知输入 4430579 tokens、输出 382183 tokens；其中 10 次缺用量，费用 null。端到端样本 p50=19007ms、p95=72086ms，包含当时共享负载。三组另有 39 次调用，不与全量拼成一个质量实验。

预注册三组比较已通过服务生成记录 6761c40a-f855-4a39-b149-6759e90f7813：comparable=false、comparisons=null，原因是三组 actual_model_revision 均未核验。诊断性配对保留，严格效果结论没有发布。未知版本不能因模型别名相同而被当作已核验。

在线竞争请求 bfecccaf-9fbb-41f4-9c1d-7712c4a728b3 在同一配额下完成，返回合成医院 A 的 65 岁及以上患者 3 人；排队 2164ms、从接受到最后更新 7355ms。控制端实际 active/模型峰值均为 5，排空后 active/pending/unknown 为 0。该请求是一次有限竞争观测，不是响应 SLA。

## 资格、归档与后续版本

两实验均未冻结完整质量政策，发布判断均为 evidence_insufficient，没有激活为默认配置。真实结果也未达到可宣称完整业务质量的状态。工作台裁定→重评→质量门→激活的功能验证使用另一个明确登记的本机 SSE 实验，不能替代本节真实质量。

全量导出 SHA-256：84e9f788521dbf049e013ec073608feefb70f5771aa0628f68433ba381d08946；三组导出 SHA-256：8130123c9ec9d3f2c006b6fa4e9057bd8b040b85a5e4609647a91479fa9d9a40。导出分别约 88MiB/13MiB，含原始提示词与阶段。旧 r1/r2 失败/取消实验保留，不合并成绩。完成后停止旧控制端，再修复恢复窗口与评分契约；后续代码 hash 不同，本节成绩仅代表上面的冻结版本，不冒充修改后的新模型全量验证。

## 关系与空值修复专项回归

2026-10-21 通过实际 CLI 创建并导出实验 `59a7d3eb-57d7-4993-983d-dcfb2c03287f`，执行与评分 hash 均为 `3f2be0a7b69863a161e62ebc74a8ec9656e702399c1caaee965a56d5ebffe9fd`。继续使用原数据集与 exact gold，未修改题目或标准答案；评分 `scores-4befe295170e48befa012b8d16f8cf3183218f0bcbb9b34eb9126ad120beae56`。三题均完成，无阻断，原契约得分 1/3，不能称为三题全部评分通过。

| 题号 | 实际结果 | 原契约判定 |
| --- | --- | --- |
| L0F-004 | 操作记录数 3 | fail：实际列名 operation_record_count，gold 为 procedure_count；数值一致 |
| L0F-019 | D_MED／合成内科／预约数 6 | pass：三列及值均一致 |
| L0F-040 | 出生日期缺失数 1 | fail：实际列名 missing_dob_count，gold 为 missing_birth_date_count；数值一致 |

共 9 次真实调用，8 次原生用量经完整性校验、1 次 HTTP 429 缺用量，保留 null；已知输入 245521、输出 11214 tokens，费用未知。019 曾输出截断后重新调用；040 经空值条件修复，并在 429 冷却后成功；等待期间其他调用也遵守同账号冷却。排空后运行、模型和未知占位均为 0。此小样本只证明相应路径本次可执行，不提供全量准确率或因果收益结论。

CLI 导出约 9.16MiB，SHA-256 `63975eae738e6fbbbd58c4d890ec45c81f15c0c9866abebab95d1c3659d91f82`；包含同一实验、原 gold、评分及完整产物，见[专项摘要](evidence/evaluation-real/20261021-postfix-summary.json)。此前旧服务加载版本与磁盘源码不一致的实验 `34a32390-b093-4329-b216-ff4a15f6912d` 在派发前被拦截，未产生模型调用，原失败记录保留。后续 L0 别名去重修复另有定向回归，不将本实验冒充后续源码的全量验证。
