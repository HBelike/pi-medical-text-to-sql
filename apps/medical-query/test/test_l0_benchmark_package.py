"""验证百表数据包的可复现、可导入与答案隔离边界，不调用模型。"""

import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch


APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT / "python"))
import build_l0_benchmark as benchmark


class BenchmarkPackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 小规模仍有完整业务域；测试产物全部写临时目录，避免碰运行中的数据源。
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.package = cls.root / "first"
        cls.input_hashes = {name: benchmark.digest(benchmark.FIXTURES / name) for name in benchmark.KNOWLEDGE_FILES}
        cls.manifest = benchmark.build(cls.package, patients_per_institution=8)

    def read(self, path):
        return json.loads((self.package / path).read_text(encoding="utf-8"))

    def test_source_material_stays_byte_identical_and_all_metrics_keep_blockers(self):
        for name, before in self.input_hashes.items():
            self.assertEqual(before, benchmark.digest(benchmark.FIXTURES / name))
            self.assertEqual(before, benchmark.digest(self.package / "knowledge" / name))
        coverage = self.read("evaluation/metric-coverage.json")
        self.assertEqual(len(coverage), 47)
        for metric in coverage:
            self.assertFalse(metric["formal_calculation_ready"])
            self.assertTrue(metric["all_required_fields_present"])
            self.assertTrue(metric["remaining_missing"])
            self.assertGreaterEqual(len(metric["question_ids"]), 2)
        self.assertTrue(any(not metric["all_required_fields_have_values"] for metric in coverage))

    def test_same_seed_build_reproduces_all_portable_artifacts(self):
        # 同时比较数据库字节与问题、答案、结构等文件，防止只复现表数却改变内容。
        other = benchmark.build(self.root / "same-seed", patients_per_institution=8)
        self.assertEqual(self.manifest["files_sha256"], other["files_sha256"])
        for filename, expected in self.manifest["files_sha256"].items():
            self.assertEqual(benchmark.digest(self.package / filename), expected)

    def test_database_is_nonempty_relational_and_schema_reimports(self):
        with sqlite3.connect(f"file:{self.package / benchmark.DATABASE_NAME}?mode=ro", uri=True) as connection:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchall(), [("ok",)])
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(len(names), 106)
            for table in self.read("table-catalog.json"):
                count = connection.execute(f'SELECT COUNT(*) FROM "{table["table"]}"').fetchone()[0]
                self.assertEqual(count, table["row_count"])
                self.assertGreater(count, 0)
        with sqlite3.connect(":memory:") as empty:
            empty.executescript((self.package / "schema.sql").read_text(encoding="utf-8"))
            restored = {row[0] for row in empty.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(names, restored)

    def test_public_questions_and_dictionary_do_not_contain_gold_roles(self):
        questions = [json.loads(line) for line in (self.package / "questions.jsonl").read_text().splitlines()]
        self.assertEqual(len(questions), 136)
        self.assertTrue(all(set(q) == {"id", "source_id", "question", "as_of"} for q in questions))
        semantics = self.read("semantic.json")
        self.assertEqual(len(semantics["tables"]), 106)
        for table in semantics["tables"].values():
            self.assertNotIn("role", table)
            self.assertNotIn("related_metric_ids", table)
        # 检查所有模型可见的字典键；正式口径字段允许保留，但评测答案不允许混入。
        def check_keys(value):
            if isinstance(value, dict):
                self.assertFalse({"expected_rows", "reference_sql", "negative_controls", "holdout_policy", "manual_expected_rows"} & set(value))
                for item in value.values():
                    check_keys(item)
            elif isinstance(value, list):
                for item in value:
                    check_keys(item)
        check_keys(semantics)
        conventions = self.read("knowledge/mock_conventions.json")
        self.assertNotIn("known_limits", conventions)
        codes = next(rule["field_values"] for rule in conventions["global_rules"] if "field_values" in rule)
        self.assertEqual(codes["drug_ddd_standards.is_antibacterial"], [0, 1])
        self.assertEqual(codes["inpatient_procedures.code_system"], ["SYNTHETIC"])
        self.assertIn("SYN_GRADE4", codes["clinical_code_memberships.catalog_id"])

    def test_source_fragment_has_two_independent_modes_and_existing_files(self):
        sources = self.read("sources.fragment.json")
        self.assertEqual({s["id"] for s in sources}, {"l0_benchmark", "l0_benchmark_facts"})
        for source in sources:
            self.assertTrue(Path(source["path"]).is_file())
            self.assertTrue(Path(source["dictionary_path"]).is_file())
            self.assertEqual("knowledge_path" in source, source["id"] == "l0_benchmark")
        self.assertFalse(self.manifest["registered_in_running_app"])
        self.assertFalse(self.manifest["model_evaluation_run"])

    def test_gold_validation_is_read_only_and_all_errors_detected(self):
        validation = self.read("evaluation/validation.json")
        self.assertEqual(validation["fact_cases"], 40)
        self.assertEqual(validation["official_metrics"], 47)
        self.assertGreaterEqual(validation["negative_controls_killed"], 5)
        self.assertTrue(validation["sql_reference_matches_python"])
        # 若参考答案生成器误写业务数据，应由数据库只读边界拒绝并清理本次目录。
        def invalid_generator(connection, knowledge):
            connection.execute("DELETE FROM patients")
        target = self.root / "failed-readonly"
        with patch.object(benchmark, "build_questions", side_effect=invalid_generator):
            with self.assertRaises(sqlite3.OperationalError):
                benchmark.build(target, patients_per_institution=8)
        self.assertFalse(target.exists())

    def test_existing_output_is_preserved_and_invalid_scale_has_no_side_effect(self):
        sentinel = self.package / "owner-note.txt"
        sentinel.write_text("existing user content")
        before = benchmark.digest(self.package / benchmark.DATABASE_NAME)
        with self.assertRaises(FileExistsError):
            benchmark.build(self.package)
        self.assertEqual(sentinel.read_text(), "existing user content")
        self.assertEqual(benchmark.digest(self.package / benchmark.DATABASE_NAME), before)
        target = self.root / "invalid-scale"
        with self.assertRaises(ValueError):
            benchmark.build(target, patients_per_institution=0)
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
