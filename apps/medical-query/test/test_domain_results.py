"""完整结果与预览的离线回归；大结果不依赖模型，也不访问真实患者库。"""

import hashlib
import importlib.util
import json
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("medical_domain_results", APP_ROOT / "python" / "domain.py")
domain = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(domain)


class FullResultTests(unittest.TestCase):
    """手工建立 301 行控制库，独立检查末行、预算和字节完整性。"""

    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.path = Path(self.workspace.name) / "results.sqlite"
        with sqlite3.connect(self.path) as connection:
            connection.execute("CREATE TABLE facts(id INTEGER PRIMARY KEY, label TEXT, amount REAL)")
            connection.executemany("INSERT INTO facts VALUES(?,?,?)", [(number, f"样本{number}", number / 10) for number in range(301)])
        self.plan = {"from": "facts", "select": [{"field": "facts.id"}, {"field": "facts.label"}, {"field": "facts.amount"}], "order_by": [{"field": "facts.id", "direction": "asc"}]}

    def tearDown(self):
        self.workspace.cleanup()

    def query(self, **options):
        return domain.handle({"action": "execute", "path": str(self.path), "dsl": self.plan, **options})

    def test_more_than_200_rows_remain_complete_with_small_preview(self):
        result = self.query()
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["complete"])
        self.assertFalse(result["truncated"])
        self.assertEqual(result["rows"][-1], [300, "样本300", 30.0])
        self.assertEqual(result["row_count"], 301)
        self.assertEqual(result["total"], 301)
        self.assertEqual(result["preview_rows"], result["rows"][:200])
        self.assertEqual(result["preview_row_count"], 200)
        self.assertTrue(result["preview_truncated"])
        self.assertEqual(result["result_content_hash"], domain.result_content_hash(result["columns"], result["rows"], True, False))
        self.assertIsNone(result["truncation_reason"])

    def test_execution_budget_is_separate_from_preview_and_never_invents_total(self):
        result = self.query(max_rows=250, preview_rows=10)
        self.assertFalse(result["complete"])
        self.assertEqual(result["row_count"], 250)
        self.assertEqual(result["preview_row_count"], 10)
        self.assertTrue(result["truncated"])
        self.assertIsNone(result["total"])
        self.assertEqual(result["truncation_reason"], "row_budget")
        self.plan["limit"] = 250
        limited = self.query(max_rows=250)
        self.assertTrue(limited["complete"])
        self.assertEqual(limited["total"], 250)
        self.assertEqual(limited["applied_limit"], 250)

    def test_byte_budget_counts_utf8_and_reports_incomplete(self):
        result = self.query(max_result_bytes=1024)
        self.assertFalse(result["complete"])
        self.assertEqual(result["truncation_reason"], "byte_budget")
        self.assertIsNone(result["total"])
        actual_bytes = len(json.dumps(result["rows"], ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        self.assertEqual(result["result_bytes"], actual_bytes)
        self.assertLessEqual(actual_bytes, 1024)
        next_row = [len(result["rows"]), f"样本{len(result['rows'])}", len(result["rows"]) / 10]
        self.assertGreater(len(json.dumps(result["rows"] + [next_row], ensure_ascii=False, separators=(",", ":")).encode("utf-8")), 1024)

    def test_large_cell_does_not_duplicate_into_preview_or_escape_budget(self):
        with sqlite3.connect(self.path) as connection:
            connection.execute("UPDATE facts SET label=? WHERE id=0", ("字" * 180000,))
        result = self.query()
        self.assertTrue(result["complete"])
        self.assertEqual(result["preview_rows"], [])
        self.assertTrue(result["preview_truncated"])
        self.assertEqual(len(result["rows"]), 301)
        rejected = self.query(max_result_bytes=1024)
        self.assertEqual(rejected["rows"], [])
        self.assertFalse(rejected["complete"])
        self.assertIsNone(rejected["total"])

    def test_hash_detects_changes_after_preview_and_completion_flags(self):
        result = self.query()
        rows = [row[:] for row in result["rows"]]
        rows[-1][2] = 999
        self.assertNotEqual(result["result_content_hash"], domain.result_content_hash(result["columns"], rows, True, False))
        self.assertNotEqual(result["result_content_hash"], domain.result_content_hash(result["columns"], result["rows"], False, True))

    def test_unsafe_integer_is_not_silently_rounded_in_javascript(self):
        with sqlite3.connect(self.path) as connection:
            connection.execute("INSERT INTO facts VALUES(?,?,?)", (2**53 + 1, "超范围", 0))
        result = self.query()
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "UNSUPPORTED_RESULT")

    def test_empty_result_has_full_identity_and_no_fake_truncation(self):
        self.plan["where"] = [{"field": "facts.id", "op": "lt", "value": 0}]
        result = self.query()
        self.assertTrue(result["complete"])
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["preview_row_count"], 0)
        self.assertFalse(result["preview_truncated"])
        self.assertEqual(len(result["result_content_hash"]), hashlib.sha256().digest_size * 2)

    @unittest.skipUnless(shutil.which("node"), "跨语言一致性需要本机 Node")
    def test_hash_matches_javascript_after_json_roundtrip(self):
        # 独立 JS 编码验证 1.0/1、负零、中文和 NULL 的实际协议差异。
        payload = {"columns": ["值", "备注"], "rows": [[1.0, "中文🙂"], [-0.0, None], [1e-7, "a;b:c"]], "complete": True, "truncated": False}
        script = """
import { createHash } from 'node:crypto';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const value = JSON.parse(raw), hash = createHash('sha256').update('medical-query-result/v1\\n');
function cell(v) {
  if (v === null) hash.update('N;');
  else if (typeof v === 'boolean') hash.update(v ? 'B1;' : 'B0;');
  else if (typeof v === 'number') { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(v === 0 ? 0 : v); hash.update('D' + bytes.toString('hex') + ';'); }
  else hash.update('S' + Buffer.byteLength(v, 'utf8') + ':' + v + ';');
}
hash.update('C' + value.columns.length + ';'); value.columns.forEach(cell);
hash.update('R' + value.rows.length + ';'); for (const row of value.rows) { hash.update('['); row.forEach(cell); hash.update(']'); }
hash.update('C' + Number(value.complete) + 'T' + Number(value.truncated) + ';');
process.stdout.write(hash.digest('hex'));
"""
        result = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(payload), text=True, capture_output=True, check=True)
        self.assertEqual(result.stdout, domain.result_content_hash(payload["columns"], payload["rows"], True, False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
