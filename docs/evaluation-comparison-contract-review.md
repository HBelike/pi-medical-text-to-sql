# 结果列与澄清概念的版本化比较契约

更新：2026-10-21。契约已在 `datasets.ts` 和 `scoring.ts` 实现，结果/澄清检查器版本为 `2.0.0`。只有明确声明新契约的题目才启用；没有修改既有 136 题 gold、score set 或实验结论。

## 已核实的问题

`L0F-001` 原始 `evaluation/gold.jsonl` 明确声明 `comparison.column_names="exact"`、`expected_rows=[{"visit_count":7}]`。`parseDataset` 原样保留 gold，并未丢失列别名。实际观察 `completed_outpatient_visits=7` 按原契约不能通过。原题自然语言没有要求输出名为 `visit_count`，因此后续可以调整评测契约，但调整必须形成新版本，不能重写原成绩。

`L0B-CLARIFY` 原 gold 只有 `required_clarifications=["统计对象或指标","科室","统计区间"]`；没有概念编号或别名表。产品返回自由文本 slots，当前评分器对其作逐字集合比较。原始导入同样完整，缺陷在于接口与评测采用了不同语义粒度。问题文本问得完整与 structured slots 是否逐字相同应分别记录，不能把后者直接称为“业务澄清错误”。

旧 `evaluate.ts` 的二维数组按位置比较、不核列名，且澄清仅核行动；这属于旧 11 题包的不同契约，不代表新 136 题包导入时应自动沿用旧规则。

## 结果列契约

新增显式版本，数据导入时冻结；未知版本、未知枚举、未声明 v2 的新模式及错拼字段在启动前拒绝。旧已存记录保留原评分器版本；新代码重评旧 gold 时仍使用原比较行为，并记录新的评分器身份。

```json
{
  "comparison": {
    "contract_version": "comparison/v2",
    "column_names": "single_value",
    "row_order": "unordered_multiset",
    "numeric_tolerance": 0,
    "null_is_zero": false
  },
  "result_contract": {
    "columns": ["visit_count"],
    "column_settings": {"visit_count": {"type": "integer"}}
  },
  "expected_rows": [{"visit_count": 7}]
}
```

| 模式 | 必须执行的规则 |
| --- | --- |
| `exact` | 保持原精确列名契约，不用看过的模型输出补别名，不用值相等寻找对应列。 |
| `declared_aliases` | 每个角色只接受版本中预登记名称；角色映射须一对一，别名不得跨角色重叠，不接受多余或重复列；多列不得退化成任意位置或无名值集合比较。 |
| `single_value` | 仅用于单输出角色：gold 每行恰有同一个键、声明 `columns` 恰一项；实际完整结果也必须恰一列且每行一格。将实际唯一列绑定到预登记角色，保留原始列名和映射回执。模式只放宽单列名称，不放宽数值或数据形状。 |

`single_value` 允许多个结果行，仍按冻结的有序/无序多重集规则比较；重复数量、类型、NULL、整数精确性、浮点容差、完整性和截断检查全部保留。不能把“存在一个正确值”当作整列通过，不能把字符串 `"7"` 当数值 `7`，不能把 NULL 当 0。

空结果必须有双侧结构依据：gold 的 `result_contract.columns` 明确单角色，实际结果 `columns` 明确单物理列。gold 未声明角色属于 `invalid_gold`；实际产物缺少列结构属于 `evidence_unavailable`，整题 unknown。实际存在多列属于真实契约失败，不能改为 unknown。声明与行键不一致、别名冲突或列数不合法在导入时拒绝。

v2 比较回执保留 `contract_version/mode/role_bindings/actual_columns/gold_columns`、`structure` 与包含类型约束的 `values` 结果。先核原产物内容 hash，再创建只供评分的角色映射视图，原观察及列名不变。旧协议失败仍保留原判定；列映射后的通过不能被写回原成绩。

`result_contract.columns` 在全部 v2 模式必填；实际 `columns` 也必须存在、无重复且与每行结构相符。列设置仅接受 `integer/decimal/string/boolean`，NULL 单独精确比较；数值容差须有限且非负，整数不因全局容差而放宽。直接调用评分器绕开数据导入时，仍执行同一验证器，非法 gold 返回 `invalid_gold`，不归因成模型错误。

## 澄清概念契约

```json
{
  "clarification_contract": {
    "version": "clarification/v2",
    "vocabulary_id": "medical-query-clarification/v1",
    "vocabulary_hash": "实际审核词表的SHA256",
    "required_concepts": ["metric_or_population", "department", "time_window"],
    "permitted_extra_concepts": [],
    "matching": "reviewed_exact_aliases",
    "normalization": "nfkc_trim",
    "vocabulary": {
      "id": "medical-query-clarification/v1",
      "version": "clarification-vocabulary/v1",
      "review_status": "approved",
      "reviewer": "审核人身份",
      "reason": "审核理由；示例不构成真实审批",
      "source_refs": ["审核依据的不可变引用"],
      "concepts": [
        {"id": "metric_or_population", "definition": "统计对象或指标", "aliases": ["统计对象或指标"]},
        {"id": "department", "definition": "科室限定", "aliases": ["科室"]},
        {"id": "time_window", "definition": "统计起止区间", "aliases": ["统计区间"]}
      ]
    }
  }
}
```

词表直接内嵌私有 gold，一起进入题集 hash，不进入公开模型问题。`vocabulary_hash` 必须等于 `contentHash(vocabulary)`，即项目稳定 JSON 序列化后的 SHA256；词表正文自身不含 hash 字段。审核状态、审核人、理由、非空来源引用均必填；该记录证明冻结声明可追踪，不代表评分器能独立验证审核人的业务资质。概念 ID 为小写字母开头的字母/数字/下划线，定义必填；ID 本身与审核 aliases 均可映射。重复 ID、别名跨概念或 NFKC 后碰撞在导入时拒绝。正式业务词表仍需审核，本文示例不自动成为线上词表。

待审核的业务候选包括：`metric_or_population` 对应“统计对象或指标”“统计指标”“统计对象”；`department` 对应“科室”“科室名称”；`time_window` 对应“统计区间”“统计周期”“统计时间范围”。这些只是审查候选，不因本文出现就自动激活。单独“范围”“时间”等宽泛词是否明确，必须在词表审核中决定，不用子串或向量相似度自动放行。

映射仅做 `nfkc_trim`（Unicode NFKC 后去除首尾空白），随后精确查审核词表。歧义词表属于 invalid_gold；未登记表达保留原文并报告 `evidence_unavailable`/unknown，不能删除它再让其余集合通过。所有必需概念必须出现；额外概念只有在题集明确允许时才接受；重复输出同一概念也不通过。不使用 LLM 对自己回答进行通过判定。

原 `required_clarifications` 的逐字行为保留为旧契约；同题同时声明旧 slots 和 v2 概念会拒绝导入，避免冲突。新评分保留问题文本、原始 slots、概念映射、未映射表达、缺失概念和多问项，并明确 `question_semantics="not_evaluated"`。词表映射不验证自然语言问句是否真的包含这些概念；问句与 slots 不一致仍需人工复核或另行登记独立检查。完整澄清质量还需查看后续用户回答能否让业务任务正确完成；概念召回通过不等于多轮任务完成。

## 迁移、裁定及验证

先对全部候选题的语义角色和输出形状进行审查，不按已看到的答案逐题挑选有利规则。只允许经说明的单列 `result_only` 子集切到 `single_value`；多列题必须单独标注列角色/别名。正式口径、机构/时间/单位、expected 数值、题目与 source 均保持原有冻结事实。

每次迁移形成新 dataset/gold hash，记录父版本、影响 case/family/variant/experiment 列表、修改人、原因和前后契约差异。对已有观察重评时创建关联新 score set，保留旧分数；新报告同时展示旧契约成绩与修订后成绩，禁止拿新分数替换原实验的“当时结果”。评分代码升级后必须记录新 scorer hash，严格比较重新校验各组均按同一新契约重评。

新增 `evaluation-comparison-v2.test.ts` 已实际验证以下六组：

1. `exact` 原结果不变；未知比较枚举、声明冲突和无效 gold 导入前拒绝。
2. `single_value` 仅列名不同可通过；额外列、角色冲突、错值、错类型、重复缺失、有序错序、NULL/0、截断仍失败。
3. 空结果双侧有角色证据才能比较；缺 gold 角色是 invalid_gold，缺实际结构是 evidence_unavailable，多列是 fail。
4. 多列 aliases 一对一，别名重叠、重复列、值相同但列角色交换都不能通过。
5. 澄清固定同义词可映射；未审词表、错误 hash、未登记词、歧义词、缺必需概念、非允许多问项不可放行。
6. 旧观察和旧 score set 不变；新评分保留父版本及审查理由；所有适用组统一重评，缺组时不可宣称严格可比。

## 本次变更记录

- 核查原 gold、生成脚本、导入器及新旧评分器，确认无导入字段丢失；契约的措辞粒度与用户语义目标存在偏差。
- `datasets.ts` 共用严格导入/重评验证器；`scoring.ts` 复用原类型多重集，仅在 v2 显式绑定角色，并用审核词表确定澄清概念。检查器升为 2.0.0，旧行为不自动改变。
- 新六类回归 6/6 通过；与原评分、完整产物及真实本机多轮集成四文件合跑 42/42 通过。既有真实数据、观察与成绩未改；正式词表审核、既有题目版本迁移和新版真实重评仍未执行。
