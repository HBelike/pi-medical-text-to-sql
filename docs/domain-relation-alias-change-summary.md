# SQLite 关系别名适配修复

- 目标：修复事实问答中模型使用 L0 字典 `rel.*` 关系名，而执行目录只认识 `fk:*` 导致的 `UNKNOWN_RELATION` 误阻断；不修改题集或 gold。
- `apps/medical-query/python/domain.py` 继续从 SQLite PRAGMA 读取物理外键，原 `fk:table:id` 保持可用；仅对 active 的 `synthetic_sql_fk` 声明核对实际表方向、全部列对与列对数量。
- 列对顺序不影响匹配；缺少机构列、重复列对、替换机构列、错误表或不存在列均不能取得可执行身份。核验失败返回 `INVALID_DICTIONARY`，不默默接受字典的来源声明。
- 核验通过的逻辑 ID 作为物理关系别名加入目录，记录 `origin=database_metadata`、`declared_origin=synthetic_sql_fk` 及 `physical_relation_id`。别名与原物理 ID 均参与目录指纹，所有已接受 ID 禁止冲突。
- candidate、inactive 和未经人工确认的模型推断关系仍不进入执行目录；既有 active human_confirmed 审核路径保留。
- 调用链：登记字典＋只读 SQLite → `load_catalog` 核验别名 → 原有 `compile_dsl` 完整生成 JOIN → 参数绑定执行；未引入新依赖，也未放开任意 SQL。
- 新增 `test/test_domain_relation_aliases.py`，通过真实多机构复合键 SQLite 验证别名与原 ID 等价、隐式引用主键、错误/重复映射、候选及停用状态、ID 冲突；通过生产 JSON 子进程入口验证 L0F-004 与 L0F-019 的实际关系名。
- 两个场景实际结果为操作记录 3 条、合成内科预约记录 6 条；SQL 中的机构列连接仍在。新测试及既有领域/L0 合成库回归共 40 项通过。
- 工作台将阻断计数标为“运行阻断”，并说明运行状态不代表评分通过；现有槽位列表没有权威预期动作，页面不猜测哪些阻断正确，也不重算原成绩。该文案通过 JavaScript 语法检查，尚未补视觉验证。
- 修复后词法召回回归 11 项通过；临时真实 106 表包的 40 道事实题保留全部必需表，入模 15–30 表、153505–237798 字符，仍在默认 256000 字符预算内。没有调用模型。
- 后续跨模块回归发现物理 FK 与已核验别名被 `src/l0-knowledge.ts` 当成两个匹配。现按 `physical_relation_id` 校验同形、有效且非别名的原关系后去重，L0 仍输出旧 `fk:*` 引用；缺失/不完整/错机构列/停用/候选/循环别名不能补位，真正不同物理 FK 仍报歧义、重复 ID 拒绝。新增三组回归，连同原 L0 知识与百表测试共 37 项通过，未修改 gold。
- 验证边界：这些检查证明领域适配与明确合成条件下的执行，不代表正式 L0 指标已获计算授权。后续 L0 canonical 修复形成新执行指纹；先前真实模型及 HTTP 恢复记录保留原指纹，不视为新版本实测；全仓检查由集成验收统一执行。
