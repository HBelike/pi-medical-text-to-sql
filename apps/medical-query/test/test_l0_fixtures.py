"""L0 原始合成事实离线回归；只验证基础事实，不把样例当完整指标答案。"""

from __future__ import annotations

import concurrent.futures
import hashlib
import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch


APP_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = APP_ROOT / "fixtures" / "l0"
GENERATOR = APP_ROOT / "python" / "build_l0_fixtures.py"
spec = importlib.util.spec_from_file_location("l0_fixtures", GENERATOR)
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


class L0FixtureTests(unittest.TestCase):
    """所有生成均在临时目录，不访问 .local 实际数据源、网络或密钥。"""

    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory()
        cls.original_hashes = {
            name: hashlib.sha256((FIXTURES / name).read_bytes()).hexdigest()
            for name in ("mock_schema.sql", "mock_semantics.json", "metrics.json", "manifest.json", "logical_requirements.json", "binding_gaps.json")
        }
        cls.source = fixtures.build(Path(cls.workspace.name))
        cls.semantics = json.loads((FIXTURES / "mock_semantics.json").read_text(encoding="utf-8"))
        cls.conventions = json.loads((FIXTURES / "mock_conventions.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.workspace.cleanup()

    def setUp(self):
        self.connection = sqlite3.connect(self.source["path"])
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.addCleanup(self.connection.close)

    def rows(self, sql, parameters=()):
        return self.connection.execute(sql, parameters).fetchall()

    def test_schema_integrity_and_knowledge_references(self):
        tables = {row[0] for row in self.rows("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(tables, set(self.semantics["tables"]))
        self.assertEqual(len(tables), 26)
        columns = {table: {row[1] for row in self.rows(f'PRAGMA table_info("{table}")')} for table in tables}
        self.assertEqual(sum(map(len, columns.values())), 216)
        self.assertEqual(self.rows("PRAGMA integrity_check"), [("ok",)])
        self.assertEqual(self.rows("PRAGMA foreign_key_check"), [])
        for binding in self.semantics["field_bindings"]:
            table, column = binding["physical_field"].split(".")
            self.assertIn(column, columns[table])
        # 已声明外键须与 DDL 一致；候选关系只核对字段，不将候选升级为数据库约束。
        for relation in self.semantics["relations"]:
            for pair in relation["pairs"]:
                self.assertIn(pair["left"], columns[relation["left_table"]])
                self.assertIn(pair["right"], columns[relation["right_table"]])
            if relation["origin"] != "synthetic_sql_fk":
                self.assertEqual(relation["status"], "candidate")
                continue
            foreign_keys = {}
            for row in self.rows(f'PRAGMA foreign_key_list("{relation["left_table"]}")'):
                foreign_keys.setdefault((row[0], row[2]), set()).add((row[3], row[4]))
            expected = {(pair["left"], pair["right"]) for pair in relation["pairs"]}
            self.assertTrue(any(parent == relation["right_table"] and pairs == expected for (_, parent), pairs in foreign_keys.items()), relation["id"])
        metrics = json.loads((FIXTURES / "metrics.json").read_text(encoding="utf-8"))["metrics"]
        self.assertEqual(len(metrics), 47)
        bound_fields = {item["logical_field_id"] for item in self.semantics["field_bindings"]}
        for metric in metrics:
            self.assertTrue(set(metric["required_field_ids"]) <= bound_fields, metric["metric_id"])

    def test_code_values_and_storage_types(self):
        allowed = {}
        for item in self.semantics["code_mappings"]:
            allowed.setdefault(item["physical_field"], []).append(item["value"])
        for rule in self.conventions["global_rules"]:
            for field, values in rule.get("field_values", {}).items():
                allowed.setdefault(field, []).extend(values)
        # 原来源字典未列该枚举，独立合成约定承接 DDL 的整数0/1约束，不改原文件。
        self.assertEqual(allowed["drug_ddd_standards.is_antibacterial"], [0, 1])
        self.assertTrue(all(type(value) is int for value in allowed["drug_ddd_standards.is_antibacterial"]))
        # 枚举和自造目录代码均须有明确来源；字符“3/4”不可变成整数。
        for table in self.semantics["tables"]:
            for column in self.rows(f'PRAGMA table_info("{table}")'):
                name = column[1]
                field = f"{table}.{name}"
                if field not in allowed and not (name.endswith("_code") or name in ("code", "code_system", "code_edition", "catalog_version", "standard_version")):
                    continue
                values = self.rows(f'SELECT DISTINCT "{name}", typeof("{name}") FROM "{table}" WHERE "{name}" IS NOT NULL')
                for value, storage_type in values:
                    self.assertIn(value, allowed.get(field, []), field)
                    self.assertIn((value, type(value)), [(item, type(item)) for item in allowed[field]], field)
                    self.assertEqual(storage_type, "integer" if type(value) is int else "text", field)
        for table in self.semantics["tables"]:
            for name, in self.rows(f'SELECT name FROM pragma_table_info("{table}")'):
                if name.endswith("_at"):
                    for value, in self.rows(f'SELECT "{name}" FROM "{table}" WHERE "{name}" IS NOT NULL'):
                        datetime.strptime(value, "%Y-%m-%d %H:%M:%S")

    def test_outpatient_and_discharge_basic_counts_with_boundaries(self):
        # 这是显式条件下的基础量，不补定 GK01 的退号处理，不计算其比值。
        self.assertEqual(self.rows("""SELECT COUNT(*), COUNT(DISTINCT patient_id) FROM outpatient_visits
            WHERE institution_id='H001' AND care_setting_code='OUTPATIENT' AND visit_status_code='COMPLETED'
            AND registered_at >= '2026-09-01 00:00:00' AND registered_at < '2026-10-01 00:00:00'"""), [(7, 5)])
        self.assertEqual(self.rows("""SELECT COUNT(*) FROM inpatient_stays WHERE institution_id='H001'
            AND discharged_at >= '2026-09-01 00:00:00' AND discharged_at < '2026-10-01 00:00:00'
            AND home_bed_flag=0"""), [(7,)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM inpatient_stays WHERE institution_id='H001' AND discharged_at IS NULL"), [(2,)])
        self.assertEqual(self.rows("SELECT visit_id FROM outpatient_visits WHERE institution_id='H001' AND registered_at='2026-10-01 00:00:00'"), [("V008",)])

    def test_appointment_pairs_keep_ambiguity_and_missing_values(self):
        pairs = self.rows("""SELECT appointment_id,checked_in_at,called_at FROM appointment_events
            WHERE institution_id='H001' AND appointment_id IN ('A001','A002','A003','A008') ORDER BY appointment_id""")
        durations = {key: (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds() / 60 for key, start, end in pairs}
        self.assertEqual(durations, {"A001": 15, "A002": 30, "A003": 20, "A008": 0})
        self.assertEqual(self.rows("SELECT COUNT(*) FROM appointment_events WHERE institution_id='H001' AND visit_id='V001' AND appointment_status_code='SUCCESS'"), [(2,)])
        self.assertEqual(self.rows("SELECT appointment_id FROM appointment_events WHERE institution_id='H001' AND appointment_status_code='SUCCESS' AND (checked_in_at IS NULL OR called_at IS NULL) ORDER BY appointment_id"), [("A004",), ("A007",)])

    def test_composite_keys_prevent_cross_institution_fanout(self):
        correct = self.rows("""SELECT COUNT(*) FROM appointment_events a JOIN outpatient_visits v
            ON a.institution_id=v.institution_id AND a.visit_id=v.visit_id WHERE a.institution_id='H001'""")[0][0]
        incomplete = self.rows("""SELECT COUNT(*) FROM appointment_events a JOIN outpatient_visits v
            ON a.visit_id=v.visit_id WHERE a.institution_id='H001'""")[0][0]
        self.assertEqual((correct, incomplete), (9, 11))
        for table, key in (("patients", "patient_id"), ("outpatient_visits", "visit_id"), ("inpatient_stays", "stay_id")):
            self.assertGreater(self.rows(f"SELECT COUNT(*)-COUNT(DISTINCT {key}) FROM {table}")[0][0], 0)
        # 事件指向另一住院的真实手术也应被复合外键拒绝。
        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute("INSERT INTO clinical_events(institution_id,event_id,stay_id,procedure_id,event_type_code) VALUES ('H001','BAD','S003','R001','SURGICAL_COMPLICATION')")

    def test_bed_days_are_separate_partial_facts(self):
        self.assertEqual(self.rows("""SELECT COUNT(*) FROM inpatient_census_days WHERE institution_id='H001'
            AND census_date >= '2026-09-01' AND census_date < '2026-09-03'"""), [(5,)])
        self.assertEqual(self.rows("""SELECT SUM(open_beds_count) FROM bed_capacity_days WHERE institution_id='H001'
            AND capacity_date >= '2026-09-01' AND capacity_date < '2026-09-03'"""), [(28,)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM bed_capacity_days WHERE institution_id='H001' AND capacity_date='2026-09-03'"), [(0,)])
        self.assertEqual({row[0] for row in self.rows("SELECT DISTINCT bed_kind_code FROM inpatient_census_days")}, {"REGULAR", "HOME", "TEMPORARY", "ROOMING_IN_NEWBORN"})

    def test_balance_leaves_and_surgery_grain(self):
        self.assertEqual(self.rows("""SELECT balance_class_code,SUM(balance_yuan) FROM balance_snapshots
            WHERE institution_id='H001' AND snapshot_date='2026-09-30' GROUP BY balance_class_code ORDER BY balance_class_code"""), [
            ("CURRENT_ASSET", 300), ("CURRENT_LIABILITY", 200), ("NONCURRENT_ASSET", 700), ("NONCURRENT_LIABILITY", 100),
        ])
        self.assertEqual(self.rows("SELECT COUNT(*),COUNT(DISTINCT stay_id) FROM inpatient_procedures WHERE institution_id='H001'"), [(4, 3)])
        self.assertEqual(self.rows("""SELECT p.procedure_id FROM inpatient_procedures p JOIN inpatient_stays s
            ON p.institution_id=s.institution_id AND p.stay_id=s.stay_id WHERE p.institution_id='H001'
            AND s.discharged_at >= '2026-09-01' AND s.discharged_at < '2026-10-01' ORDER BY p.procedure_id"""), [("R001",), ("R002",), ("R003",)])
        self.assertEqual(self.rows("""SELECT COUNT(*) FROM inpatient_procedures p LEFT JOIN inpatient_procedures prior
            ON p.institution_id=prior.institution_id AND p.stay_id=prior.stay_id AND p.prior_procedure_id=prior.procedure_id
            WHERE p.prior_procedure_id IS NOT NULL AND prior.procedure_id IS NULL"""), [(0,)])
        self.assertEqual(self.rows("""SELECT COUNT(*) FROM inpatient_procedures p LEFT JOIN clinical_code_memberships c
            ON p.code_system=c.code_system AND p.code_edition=c.code_edition AND p.procedure_code=c.code
            WHERE c.code IS NULL"""), [(0,)])

    def test_external_and_manual_evidence_has_no_fabricated_score(self):
        self.assertEqual(self.rows("SELECT document_reference FROM management_evidence WHERE evidence_id='ME_EXTERNAL_PENDING'"), [(None,)])
        self.assertEqual(self.rows("SELECT department_id,document_reference FROM management_evidence WHERE evidence_id='ME004'"), [("D_SURG", None)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM emr_assessment_items"), [(3,)])
        self.assertEqual(self.rows("SELECT data_quality_index FROM emr_assessment_items WHERE item_code='SYN_ITEM_C'"), [(None,)])
        self.assertEqual(self.conventions["provenance"], "synthetic_test_design")
        metric_ids = {metric["metric_id"] for metric in json.loads((FIXTURES / "metrics.json").read_text(encoding="utf-8"))["metrics"]}
        for group in ("global_rules", "metric_rules", "scenario_notes"):
            for rule in self.conventions[group]:
                self.assertEqual(rule["provenance"], "synthetic_test_design")
                self.assertTrue(rule["description"])
                self.assertTrue(set(rule.get("metric_ids", [])) <= metric_ids)

    def test_source_fragment_and_original_files_unchanged(self):
        self.assertEqual(self.source, {"id": "l0_mock", "name": "L0 合成医院", "path": str(Path(self.workspace.name).resolve() / "l0-mock.sqlite"), "dictionary_path": str(FIXTURES / "mock_semantics.json"), "knowledge_path": str(FIXTURES)})
        self.assertFalse((Path(self.workspace.name) / "sources.json").exists())
        for name, digest in self.original_hashes.items():
            self.assertEqual(hashlib.sha256((FIXTURES / name).read_bytes()).hexdigest(), digest, name)

    def test_refuses_existing_file_and_dangling_symlink(self):
        original = Path(self.source["path"]).read_bytes()
        with self.assertRaises(FileExistsError):
            fixtures.build(Path(self.workspace.name))
        self.assertEqual(Path(self.source["path"]).read_bytes(), original)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "l0-mock.sqlite"
            path.symlink_to(Path(directory) / "missing.sqlite")
            with self.assertRaises(FileExistsError):
                fixtures.build(Path(directory))
            self.assertTrue(path.is_symlink())

    def test_failed_build_cleans_partial_database(self):
        with tempfile.TemporaryDirectory() as directory:
            def fail_after_write(connection):
                # 故意在写入后失败，覆盖回滚与临时文件清理路径。
                connection.execute("INSERT INTO institutions VALUES ('BAD','失败样例','GENERAL')")
                raise RuntimeError("synthetic failure")
            with patch.object(fixtures, "populate", fail_after_write):
                with self.assertRaisesRegex(RuntimeError, "synthetic failure"):
                    fixtures.build(Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_concurrent_publish_has_one_winner(self):
        with tempfile.TemporaryDirectory() as directory:
            def attempt():
                try:
                    return fixtures.build(Path(directory))["id"]
                except FileExistsError:
                    return "exists"
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(attempt) for _ in range(2)]
                results = [future.result() for future in futures]
            self.assertCountEqual(results, ["l0_mock", "exists"])
            self.assertEqual([path.name for path in Path(directory).iterdir()], ["l0-mock.sqlite"])

    def test_cli_returns_fragment_without_overwriting_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = Path(directory) / "sources.json"
            registry.write_text('[{"id":"existing-a"}]', encoding="utf-8")
            completed = subprocess.run([sys.executable, str(GENERATOR), "--output-dir", directory], capture_output=True, text=True, check=True)
            fragment = json.loads(completed.stdout)
            self.assertEqual(fragment["sources"][0]["id"], "l0_mock")
            self.assertEqual(fragment["provenance"], "synthetic_test_design")
            self.assertEqual(registry.read_text(encoding="utf-8"), '[{"id":"existing-a"}]')
            repeated = subprocess.run([sys.executable, str(GENERATOR), "--output-dir", directory], capture_output=True, text=True)
            self.assertEqual(repeated.returncode, 1)
            self.assertIn("已存在", repeated.stderr)


if __name__ == "__main__":
    unittest.main()
