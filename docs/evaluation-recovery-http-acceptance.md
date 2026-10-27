# 未知调用、显式续跑与删除验收

- **范围**：2026-10-21，在独立回环实例 57844 使用临时合成 SQLite、真实 Application/Pi Durable/控制 API/评分进程验证；仅模型由本地 SSE 替身提供，无生产密钥或真实远端费用。所有操作通过 HTTP 完成，未冒称浏览器验收。
- **冻结身份**：执行指纹 `3f2be0a7b69863a161e62ebc74a8ec9656e702399c1caaee965a56d5ebffe9fd`；父实验 `ea7f5c84-8adb-4aea-bf76-77c6c36c01e2`，续跑实验 `a7d83251-480b-4603-a624-4aacbe7053ee`。使用 Python 别名修复及完整导出补充后的新实例，没有拼接旧实验版本；该指纹早于随后 `L0Knowledge` canonical 兼容修复，保留为独立版本证据，不冒充后续源码重新执行。
- **未知恢复（A09/A10）**：首次 SSE 已接收请求后受控断开，真实账本记录 `07f598c9-8e27-45ac-beb5-88e07fd80821` 为 unknown。重启 Application 后保留同一调用身份、active=1 的预约和已发 1 次的事实；重启没有自动重发。未处置时 fork 返回 `reconciliation_required`。
- **人工处置**：keep 保留预约；manual_release 将本地 active 降为 0，旧状态仍 unknown，审计保留两次处置及依据。重复相同释放命令返回相同回执、不增加处置。至显式续跑前，提供方请求仍为 1 次。
- **显式续跑**：新实验、槽位、request、execution、conversation、turn 六项身份全部改变；case、variant、snapshot 和 execution hash 保持冻结一致，origin_experiment_id/origin_slot_id 可回溯。重复 fork 命令只得到同一个子实验。父实验保持 incomplete/待对账，未覆盖旧尝试。
- **额度与结果（A25 接口链）**：子实验真实完成两个模型调用并通过 1/1 task_complete 评分，包括 action/semantic/result/answer/process/publication；提供方总请求 3 次（旧未知 1＋新成功 2），模型并发峰值 1，最终 active=0。该结果验证控制与执行链，不评价真实模型质量。
- **删除审计（A23）**：对子实验 observation 先读取全部 experiment＋score_set 引用；非空但遗漏一个引用时返回 `409 shared_artifact`。完整范围、操作者和理由提交后形成墓碑，重复命令幂等，读取正文返回 410；导出明确 `artifact_deleted`，保留槽位、历史评分、删除事件与完整性清单。父实验原观察保持完整。删除前的原始正文已保存在证据导出。
- **原始证据**：`docs/evidence/evaluation-workbench/isolated-frozen-recovery-fork-http.json` 保留重启、对账、逐次资源采样、父子完整导出和真实操作账本；`isolated-frozen-deletion-http.json` 保留影响查询、拒绝/删除回执及前后完整导出。更早的 61009 验证独立保留，不充当此冻结版本证据。
- **边界与清理**：用户接管 Chrome 并打开正式实验后已停止所有界面操作；未知对账与删除的 UI 最终提交仍未验收。未访问或修改 8787 数据。隔离进程已停止并清理自身临时数据，保留上述原始 JSON；不把本记录扩展成全部 A01–A25 或正式医院验收结论。
