# 首期 L0 指标结构包变更记录（2026-10-15）

1. 目标与范围：依据首期 L0 清单（内部文档，公开版不提供访问链接）抽取第二章 47 项（国考 27、上海评审 15、国家专业质控 5）；L0 沿用原文的首期院级管理建议含义，不当作计算复杂度等级。其余 45 项总索引指标及第一章 1.2 无独立编号的补充需求未纳入。
2. 主要文件：`apps/medical-query/fixtures/l0/` 新增 `manifest.json`、`metrics.json`、`logical_requirements.json`、`mock_schema.sql`、`mock_semantics.json`、`binding_gaps.json`。指标按原文编号建立稳定 ID，分子/分母、时间、去重、目录及来源位置分开记录。
3. 模块调用链与设计：指标 ID 引用 26 个实体、216 个字段和 39 条关系；字段 ID 绑定合成 SQLite 的 26 张原始/参考表；`metric_bindings` 汇总字段路径、时间、去重与执行缺口。32 条关系由 SQL 外键声明，7 条额外关系保持候选；同表再手术关系需先核实同患者，不作为执行依据。
4. 来源边界：国考逐项核对[2025 版操作手册](https://hunan.gov.cn/zqt/zcsd/202506/33725038/files/842d19160ebb4b54b381e8fafa875d28.pdf)，上海规则核对[2023 版评审细则](https://www.shanghai.gov.cn/cmsres/15/159dcce1a3514fbfb0c1caa556b49929/f6b5185cbf967e948c412af9aa3771d4.pdf)，专业质控核对各项国家卫健委官方文件（位置见指标 `source_refs`）。未取得飞书原始文件字节，`document_hash` 为 `null`；打印 PDF 的 SHA-256 单独记录。
5. 方案调研：参考[HL7 FHIR Measure](https://hl7.org/fhir/R4/measure.html)对分子、分母及排除人群的分离表达；它是规则建模参考，不是本地 SQLite 的直接执行组件。[OMOP CDM 5.4](https://ohdsi.github.io/CommonDataModel/cdm54.html)能清楚区分患者、就诊和事件，官方仓库有[文档、DDL 与测试](https://github.com/OHDSI/CommonDataModel)，[Apache 2.0](https://github.com/OHDSI/CommonDataModel/blob/main/DESCRIPTION)；其 R、DatabaseConnector、SqlRender 及全院 ETL 接入成本超出首批 mock 范围，故只借鉴粒度设计。
6. 方案调研续：[MetricFlow](https://github.com/dbt-labs/metricflow)具备指标语义模型、文档、测试和持续版本发布，当前版本为 Apache 2.0；但其运行依赖 dbt 项目及 adapter，无法直接接入现有查询引擎，因此本次不引入。研究结论依据官方仓库、[发布记录](https://github.com/dbt-labs/metricflow/releases)及[使用说明](https://docs.getdbt.com/docs/build/about-metricflow)，不以热度作为可靠性依据。
7. 合成约定：表/列、日期时区、单位和代码均标记为测试设计；原文代码值与 SQLite 字符串类型分别标注来源。没有实际医院绑定，不存预计算指标结果；已知目录名称保留为来源标签，未将名称伪装成医院代码。
8. 验证：47 个指标及全部实体、字段、关系、缺口 ID 唯一；引用可解析；空内存 SQLite 执行全量 SQL 成功；表列、复合外键、代码值类型与语义绑定一致；`npm run check` 通过。未生成大量模拟数据，未执行 `npm run build` 或 `npm test`。
9. 待确认与边界：需医院库表/代码/目录版本、统计时间边界、零分母与精度、DRG 全市同组基准、手术与介入跨类去重等证据；上海 M0645 缺折算公式，S012 属人工现场评审。45 项已知公式涉及比率、时间差、窗口/同表多角色、分组派生或外部规则等现有引擎未覆盖能力；具体阻断及确认责任见 `binding_gaps.json`。
10. 2026-10-16 使用说明：新增 [Claude Code 数据包使用说明](l0-claude-code-guide.md)，记录六文件职责、按 ID 展开依赖、条件作用域、逻辑/运行关系 ID、代码类型、现有加载/建库/评测入口及可复制启动指令。核对当前源码、命令与本地链接，JSON 示例及空 SQLite 结构验证通过；本次仅改文档，六份源文件与运行代码未改，未启动服务、生成业务数据或执行模型评测。
