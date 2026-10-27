# 评测历史负载与资源实测

- 日期：2026-10-19T10:17:53.931Z。环境：darwin arm64 / Node v24.16.0 / Apple M1 Pro，10逻辑核、16 GiB内存。
- 使用真实 EvaluationStore SQLite/WAL、每槽独立4,096字节正文文件与301行完整产物；全部在临时目录，结束删除，未访问生产数据或外部模型。每槽实际执行内容落盘、元数据引用及槽位/事件事务。
- 分页/计数各连续50次，元数据搜索10次；下表为本机单次运行观测，无固定时延阈值，不作为SLA或跨机器性能结论。磁盘数值为SQLite与正文文件逻辑字节总量，不包含文件系统元数据或压缩差异。RSS为每100槽采样峰值，不是操作系统绝对峰值；两规模在同一Node进程顺序测量。

| 槽数 | 新增总耗时 ms | 末页中位/P95 ms | 进度中位/P95 ms | 缺索引重开 ms | REINDEX ms | 文件逻辑体积 MiB | 采样RSS MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 5965.122 | 0.161 / 0.233 | 0.123 / 0.15 | 3.152 | 3.294 | 5.102 | 169.563 |
| 10000 | 62826.029 | 0.58 / 0.725 | 0.725 / 0.803 | 19.693 | 36.732 | 50.524 | 160.156 |

- 查询期间正文文件读取次数均为0。计数使用 slots_state 覆盖索引，评分计数使用 slots_scored 表达式索引，游标页使用实验/序号索引；搜索只读槽位元数据，仍需扫描匹配范围，不宣称全文搜索为O(1)。
- A21验证：删除4个派生索引后重新打开、执行 REINDEX，计数、末页、301行正文内容寻址读取保持一致，PRAGMA integrity_check=ok。此项不表示可以重建已删除正文或缺失流增量。
- 4个真实客户端进程经单owner向本机SSE发出48次请求；5/10额度下逐项观测如下。客户端数不会复制模型池；公平结论限于此竞争样本，不代表远端服务保障。

```json
[
  {
    "clients": 4,
    "requests": 48,
    "configured_capacity": 5,
    "observed_provider_peak": 5,
    "runtime_peak": 5,
    "llm_peak": 5,
    "elapsed_ms": 534.327,
    "first_start_index_by_client": {
      "online-a": 3,
      "eval-a": 2,
      "eval-b": 0,
      "online-b": 1
    },
    "completion_count": 48
  },
  {
    "clients": 4,
    "requests": 48,
    "configured_capacity": 10,
    "observed_provider_peak": 10,
    "runtime_peak": 10,
    "llm_peak": 10,
    "elapsed_ms": 413.021,
    "first_start_index_by_client": {
      "online-a": 1,
      "eval-a": 13,
      "eval-b": 2,
      "online-b": 0
    },
    "completion_count": 48
  }
]
```

- 已有运行链路回归59项通过；最后两项过滤字段边界加入后pipeline12项通过。它们覆盖跨进程owner、强杀后未知保留、人工处置、取消、5/10并发、追问累计预算、429、完整结果及L0依赖；没有真实收费模型质量结论。
- 复现：在仓库根设置 PI_SCALE_WRITE_REPORT=1，运行 `node --import ./scripts/issues/register.mjs --conditions=source --test apps/medical-query/test/evaluation-scale.test.ts`。普通回归不写报告。
- 范围：当前测试测评测历史账本/读取端及模型出口竞争，不覆盖长时间在线业务、操作系统断电或全部Durable历史文档的容量；原始测量附于下方，保留用于核验。

```json
{
  "environment": {
    "node": "v24.16.0",
    "platform": "darwin",
    "architecture": "arm64",
    "os_release": "24.6.0",
    "cpu": "Apple M1 Pro",
    "cpu_count": 10,
    "memory_bytes": 17179869184,
    "recorded_at": "2026-10-19T10:17:53.931Z"
  },
  "measurements": [
    {
      "slots": 1000,
      "observation_artifacts": 1000,
      "observation_bytes_each": 4096,
      "full_result_rows": 301,
      "artifact_bytes": 4100681,
      "disk_bytes": 5349961,
      "insert_ms": 5965.122,
      "insert_per_second": 167.641,
      "first_page": {
        "median_ms": 0.127,
        "p95_ms": 0.133,
        "maximum_ms": 0.176
      },
      "last_page": {
        "median_ms": 0.161,
        "p95_ms": 0.233,
        "maximum_ms": 2.249
      },
      "filtered_page": {
        "median_ms": 0.113,
        "p95_ms": 0.155,
        "maximum_ms": 0.2
      },
      "metadata_search": {
        "median_ms": 2.443,
        "p95_ms": 2.745,
        "maximum_ms": 2.745
      },
      "progress_counts": {
        "median_ms": 0.123,
        "p95_ms": 0.15,
        "maximum_ms": 0.329
      },
      "event_page": {
        "median_ms": 0.086,
        "p95_ms": 0.106,
        "maximum_ms": 0.285
      },
      "reopen_with_missing_indexes_ms": 3.152,
      "reindex_ms": 3.294,
      "checkpoint_ms": 0.561,
      "rss_before_bytes": 177618944,
      "rss_after_bytes": 151994368,
      "rss_sampled_peak_bytes": 177799168,
      "body_reads_during_queries": 0,
      "index_plans": {
        "page": [
          {
            "id": 7,
            "parent": 0,
            "notused": 51,
            "detail": "SEARCH slots USING INDEX sqlite_autoindex_slots_2 (experiment_id=? AND ordinal>?)"
          }
        ],
        "counts": [
          {
            "id": 6,
            "parent": 0,
            "notused": 55,
            "detail": "SEARCH slots USING COVERING INDEX slots_state (experiment_id=?)"
          }
        ],
        "scored": [
          {
            "id": 4,
            "parent": 0,
            "notused": 54,
            "detail": "SEARCH slots USING COVERING INDEX slots_scored (experiment_id=? AND <expr>=?)"
          }
        ]
      },
      "integrity": "ok"
    },
    {
      "slots": 10000,
      "observation_artifacts": 10000,
      "observation_bytes_each": 4096,
      "full_result_rows": 301,
      "artifact_bytes": 40964681,
      "disk_bytes": 52978249,
      "insert_ms": 62826.029,
      "insert_per_second": 159.17,
      "first_page": {
        "median_ms": 0.298,
        "p95_ms": 0.586,
        "maximum_ms": 0.68
      },
      "last_page": {
        "median_ms": 0.58,
        "p95_ms": 0.725,
        "maximum_ms": 6.146
      },
      "filtered_page": {
        "median_ms": 0.127,
        "p95_ms": 0.2,
        "maximum_ms": 1.502
      },
      "metadata_search": {
        "median_ms": 16.101,
        "p95_ms": 31.713,
        "maximum_ms": 31.713
      },
      "progress_counts": {
        "median_ms": 0.725,
        "p95_ms": 0.803,
        "maximum_ms": 3.586
      },
      "event_page": {
        "median_ms": 0.084,
        "p95_ms": 0.148,
        "maximum_ms": 2.302
      },
      "reopen_with_missing_indexes_ms": 19.693,
      "reindex_ms": 36.732,
      "checkpoint_ms": 6.651,
      "rss_before_bytes": 153927680,
      "rss_after_bytes": 148324352,
      "rss_sampled_peak_bytes": 167936000,
      "body_reads_during_queries": 0,
      "index_plans": {
        "page": [
          {
            "id": 7,
            "parent": 0,
            "notused": 51,
            "detail": "SEARCH slots USING INDEX sqlite_autoindex_slots_2 (experiment_id=? AND ordinal>?)"
          }
        ],
        "counts": [
          {
            "id": 6,
            "parent": 0,
            "notused": 55,
            "detail": "SEARCH slots USING COVERING INDEX slots_state (experiment_id=?)"
          }
        ],
        "scored": [
          {
            "id": 4,
            "parent": 0,
            "notused": 54,
            "detail": "SEARCH slots USING COVERING INDEX slots_scored (experiment_id=? AND <expr>=?)"
          }
        ]
      },
      "integrity": "ok"
    }
  ]
}
```
