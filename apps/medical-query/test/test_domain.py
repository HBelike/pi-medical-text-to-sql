"""离线领域回归：验证真实 SQLite 结果、条件不丢、源差异和执行边界。"""

from __future__ import annotations

import concurrent.futures
import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, APP_ROOT / "python" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


domain = load_module("medical_domain", "domain.py")
fixtures = load_module("medical_fixtures", "build_fixtures.py")


class DomainTests(unittest.TestCase):
    """各用例只访问临时合成库，不读取密钥、不调用网络或模型。"""

    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory()
        cls.sources = {item["id"]: item for item in fixtures.build(Path(cls.workspace.name))}

    @classmethod
    def tearDownClass(cls):
        cls.workspace.cleanup()

    def request(self, dsl=None, source="hospital-a", **options):
        source_info = self.sources[source]
        payload = {"action": "execute" if dsl is not None else "catalog", "path": source_info["path"], "dictionary_path": source_info["dictionary_path"], **options}
        if dsl is not None:
            payload["dsl"] = dsl
        return domain.handle(payload)

    def assert_rows(self, dsl, rows, source="hospital-a", **options):
        result = self.request(dsl, source, **options)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["rows"], rows)
        return result

    def assert_error(self, dsl, code):
        result = self.request(dsl)
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], code)

    @staticmethod
    def discharge_plan(distinct=False, source="hospital-a"):
        """两源使用同一业务口径，但字段和代码值分别定义，不能偷换源。"""
        a = source == "hospital-a"
        table, time_field = ("encounters", "discharged_at") if a else ("admission_episodes", "leave_time")
        return {
            "from": table,
            "select": [{"field": f"{table}.{'patient_id' if a else 'person_ref'}" if distinct else "*", "aggregate": "count_distinct" if distinct else "count", "as": "value"}],
            "where": [
                {"field": f"{table}.{'status' if a else 'state_code'}", "op": "eq", "value": "D" if a else 3},
                {"field": f"{table}.{time_field}", "op": "gte", "value": "2026-09-01"},
                {"field": f"{table}.{time_field}", "op": "lt", "value": "2026-10-01"},
            ],
        }

    def test_missing_path_does_not_create_database(self):
        path = Path(self.workspace.name) / "missing.sqlite"
        result = domain.handle({"action": "catalog", "path": str(path)})
        self.assertEqual(result["error"]["code"], "SOURCE_NOT_FOUND")
        self.assertFalse(path.exists())

    def test_catalog_contains_complete_columns_foreign_keys_and_semantics(self):
        result = self.request()
        self.assertTrue(result["ok"], result)
        catalog = result["catalog"]
        self.assertEqual(len(catalog["tables"]), 3)
        encounter = next(table for table in catalog["tables"] if table["name"] == "encounters")
        self.assertEqual(len(encounter["columns"]), 7)
        self.assertEqual(encounter["foreign_keys"][0]["columns"][0]["from"], "patient_id")
        self.assertIn("encounters_patient", [relation["id"] for relation in catalog["relations"]])
        self.assertEqual(catalog["semantics"]["version"], "fixture-v1")
        self.assertNotEqual(catalog["schema_fingerprint"], self.request(source="hospital-b")["catalog"]["schema_fingerprint"])

    def test_parameter_binding_does_not_execute_injected_values(self):
        evil = "林甲' OR 1=1; DROP TABLE patients; --"
        result = self.assert_rows({"from": "patients", "select": [{"field": "patients.name"}], "where": [{"field": "patients.name", "op": "eq", "value": evil}]}, [])
        self.assertNotIn(evil, result["sql"])
        self.assertEqual(result["parameters"][0], evil)
        self.assertEqual(len(self.request()["catalog"]["tables"]), 3)

    def test_unknown_fields_conditions_and_raw_sql_are_rejected(self):
        plan = {"from": "patients", "select": [{"field": "patients.name"}]}
        self.assert_error({**plan, "where": [{"field": "patients.status", "op": "eq", "value": "D"}]}, "UNKNOWN_FIELD")
        self.assert_error({**plan, "where": [{"field": "patients.age", "op": "approximately", "value": 65}]}, "UNSUPPORTED_OPERATOR")
        self.assert_error({**plan, "filters": [{"field": "patients.age", "op": "gt", "value": 65}]}, "INVALID_REQUEST")
        result = domain.handle({"action": "execute", "path": self.sources["hospital-a"]["path"], "sql": "SELECT * FROM patients"})
        self.assertFalse(result["ok"])

    def test_same_business_question_two_sources_has_different_results(self):
        self.assert_rows(self.discharge_plan(), [[3]])
        self.assert_rows(self.discharge_plan(source="hospital-b"), [[2]], source="hospital-b")
        self.assert_rows(self.discharge_plan(distinct=True), [[2]])
        self.assert_rows(self.discharge_plan(distinct=True, source="hospital-b"), [[1]], source="hospital-b")

    def test_join_count_distinct_preserves_patient_grain(self):
        plan = {
            "from": "patients", "select": [{"field": "patients.patient_id", "aggregate": "count_distinct", "as": "patients"}],
            "joins": [{"relation": "encounters_patient", "type": "inner"}, {"relation": "diagnoses_encounter", "type": "inner"}],
            "where": [{"field": "diagnoses.code", "op": "eq", "value": "E11"}, {"field": "diagnoses.status", "op": "eq", "value": "confirmed"}],
        }
        self.assert_rows(plan, [[2]])
        plan["select"][0]["aggregate"] = "count"
        self.assert_rows(plan, [[3]])

    def test_unknown_and_unconnected_relations_are_rejected(self):
        base = {"from": "patients", "select": [{"field": "patients.patient_id"}]}
        self.assert_error({**base, "joins": [{"relation": "guessed_patient_join", "type": "inner"}]}, "UNKNOWN_RELATION")
        self.assert_error({**base, "joins": [{"relation": "diagnoses_encounter", "type": "inner"}]}, "INVALID_JOIN")

    def test_grouping_aggregation_and_order(self):
        plan = self.discharge_plan()
        plan["select"] = [{"field": "encounters.department", "as": "department"}, {"field": "encounters.cost", "aggregate": "sum", "as": "total_cost"}]
        plan["group_by"] = ["encounters.department"]
        plan["order_by"] = [{"field": "department", "direction": "asc"}]
        self.assert_rows(plan, [["内科", 300.0], ["外科", 300.0]])
        del plan["group_by"]
        self.assert_error(plan, "INVALID_GROUP")

    def test_all_supported_aggregates(self):
        plan = {"from": "patients", "select": [{"field": "patients.age", "aggregate": name, "as": name} for name in ("count", "sum", "avg", "min", "max", "count_distinct")]}
        self.assert_rows(plan, [[5, 294, 58.8, 30, 80, 5]])
        plan["select"][0]["aggregate"] = "median"
        self.assert_error(plan, "UNSUPPORTED_AGGREGATE")

    def test_truncation_does_not_invent_total(self):
        plan = {"from": "patients", "select": [{"field": "patients.patient_id"}], "order_by": [{"field": "patients.patient_id", "direction": "asc"}]}
        result = self.assert_rows(plan, [["P001"], ["P002"]], max_rows=2)
        self.assertFalse(result["complete"])
        self.assertTrue(result["truncated"])
        self.assertIsNone(result["total"])
        plan["limit"] = 2
        result = self.assert_rows(plan, [["P001"], ["P002"]], max_rows=2)
        self.assertTrue(result["complete"])
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["applied_limit"], 2)

    def test_empty_results_null_and_parameter_types(self):
        result = self.assert_rows({"from": "patients", "select": [{"field": "patients.name"}], "where": [{"field": "patients.age", "op": "gt", "value": 150}]}, [])
        self.assertTrue(result["complete"])
        self.assertEqual(result["total"], 0)
        self.assert_rows({"from": "encounters", "select": [{"field": "encounters.encounter_id"}], "where": [{"field": "encounters.discharged_at", "op": "is_null"}]}, [["E003"]])
        self.assert_error({"from": "patients", "select": [{"field": "patients.name"}], "where": [{"field": "patients.age", "op": "eq", "value": None}]}, "INVALID_VALUE")

    def test_left_join_retains_unmatched_records(self):
        # P005 有就诊但无诊断，LEFT JOIN 不应隐式变为内关联。
        self.assert_rows({
            "from": "encounters", "select": [{"field": "encounters.encounter_id"}, {"field": "diagnoses.code"}],
            "joins": [{"relation": "diagnoses_encounter", "type": "left"}],
            "where": [{"field": "encounters.encounter_id", "op": "eq", "value": "E006"}],
        }, [["E006", None]])

    def test_composite_foreign_key_includes_every_pair(self):
        path = Path(self.workspace.name) / "composite.sqlite"
        connection = sqlite3.connect(path)
        try:
            connection.executescript("CREATE TABLE parents(a TEXT,b TEXT,label TEXT,PRIMARY KEY(a,b)); CREATE TABLE children(id INTEGER PRIMARY KEY,x TEXT,y TEXT,FOREIGN KEY(x,y) REFERENCES parents(a,b)); INSERT INTO parents VALUES ('same','one','right'),('same','two','wrong'); INSERT INTO children VALUES (1,'same','one');")
        finally:
            connection.close()
        result = domain.handle({"action": "execute", "path": str(path), "dsl": {"from": "children", "select": [{"field": "parents.label"}], "joins": [{"relation": "fk:children:0", "type": "inner"}]}})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["rows"], [["right"]])
        self.assertIn('"children"."y" = "parents"."b"', result["sql"])

    def test_suggested_relation_cannot_be_used(self):
        temporary = Path(self.workspace.name) / "suggested.json"
        temporary.write_text(json.dumps({"relations": [{"id": "guess", "left_table": "patients", "right_table": "diagnoses", "pairs": [{"left": "patient_id", "right": "diagnosis_id"}], "origin": "model_inferred", "status": "suggested"}]}))
        result = self.request({"from": "patients", "select": [{"field": "patients.patient_id"}], "joins": [{"relation": "guess", "type": "inner"}]}, dictionary_path=str(temporary))
        self.assertEqual(result["error"]["code"], "UNKNOWN_RELATION")

    def test_database_work_stops_at_statement_deadline(self):
        # 用确定性的大量递归行验证底层执行取消，不把外层返回超时冒充查询停止。
        path = Path(self.workspace.name) / "timeout.sqlite"
        connection = sqlite3.connect(path)
        try:
            connection.execute("CREATE VIEW numbers AS WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100000000) SELECT n FROM seq")
        finally:
            connection.close()
        result = domain.handle({"action": "execute", "path": str(path), "timeout_ms": 1, "dsl": {"from": "numbers", "select": [{"field": "*", "aggregate": "count", "as": "n"}]}})
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "QUERY_TIMEOUT")

    def test_in_like_not_in_and_invalid_group_order(self):
        plan = {"from": "patients", "select": [{"field": "patients.patient_id"}], "where": [
            {"field": "patients.patient_id", "op": "in", "value": ["P001", "P002"]},
            {"field": "patients.name", "op": "like", "value": "林%"},
            {"field": "patients.sex", "op": "not_in", "value": ["M"]},
        ]}
        self.assert_rows(plan, [["P001"]])
        self.assert_error({"from": "patients", "select": [{"field": "patients.sex"}], "group_by": ["patients.sex"], "order_by": [{"field": "patients.age", "direction": "asc"}]}, "INVALID_ORDER")

    def test_independent_connections_remain_correct_at_ten_workers(self):
        def run(index):
            source = "hospital-a" if index % 2 == 0 else "hospital-b"
            return self.request(self.discharge_plan(source=source), source=source)
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            results = list(executor.map(run, range(30)))
        for index, result in enumerate(results):
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["rows"], [[3 if index % 2 == 0 else 2]])

    def test_cli_emits_exactly_one_json_result(self):
        request = {"action": "catalog", "path": self.sources["hospital-a"]["path"]}
        process = subprocess.run([sys.executable, str(APP_ROOT / "python" / "domain.py")], input=json.dumps(request), capture_output=True, text=True, check=True)
        result = json.loads(process.stdout)
        self.assertTrue(result["ok"], process.stdout)
        self.assertEqual(process.stderr, "")
        malformed = subprocess.run([sys.executable, str(APP_ROOT / "python" / "domain.py")], input="bad-json", capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(malformed.stdout)["error"]["code"], "INVALID_JSON")

    def test_generator_refuses_to_overwrite_snapshot(self):
        before = Path(self.sources["hospital-a"]["path"]).read_bytes()
        with self.assertRaises(FileExistsError):
            fixtures.build(Path(self.workspace.name))
        self.assertEqual(Path(self.sources["hospital-a"]["path"]).read_bytes(), before)

    def test_eval_answer_rows_match_independent_sql(self):
        """独立参考 SQL 核对手工 gold；参考语句仅在测试进程可见。"""
        references = {
            "A01": "SELECT COUNT(*) FROM patients WHERE age>=65",
            "B01": "SELECT COUNT(*) FROM persons WHERE age_years>=65",
            "A02": "SELECT COUNT(*) FROM encounters WHERE status='D' AND discharged_at>='2026-09-01' AND discharged_at<'2026-10-01'",
            "B02": "SELECT COUNT(*) FROM admission_episodes WHERE state_code=3 AND leave_time>='2026-09-01' AND leave_time<'2026-10-01'",
            "A03": "SELECT COUNT(DISTINCT patient_id) FROM encounters WHERE status='D' AND discharged_at>='2026-09-01' AND discharged_at<'2026-10-01'",
            "B03": "SELECT COUNT(DISTINCT person_ref) FROM admission_episodes WHERE state_code=3 AND leave_time>='2026-09-01' AND leave_time<'2026-10-01'",
            "A04": "SELECT COUNT(*) FROM patients p WHERE EXISTS(SELECT 1 FROM encounters e JOIN diagnoses d ON d.encounter_id=e.encounter_id WHERE e.patient_id=p.patient_id AND d.code='E11' AND d.status='confirmed')",
            "B04": "SELECT COUNT(*) FROM persons p WHERE EXISTS(SELECT 1 FROM admission_episodes e JOIN episode_diagnoses d ON d.episode_ref=e.episode_key WHERE e.person_ref=p.person_key AND d.disease_code='DM2' AND d.certainty_code=1)",
            "A05": "SELECT name FROM patients WHERE age>150 ORDER BY patient_id",
        }
        cases = json.loads((APP_ROOT / "fixtures" / "cases.json").read_text())
        self.assertEqual(len({case["id"] for case in cases}), len(cases))
        for case in cases:
            if case["expected_action"] != "answer":
                self.assertNotIn("expected_rows", case)
                continue
            connection = sqlite3.connect(Path(self.sources[case["source_id"]]["path"]).as_uri() + "?mode=ro", uri=True)
            try:
                rows = [list(row) for row in connection.execute(references[case["id"]])]
                self.assertEqual(rows, case["expected_rows"], case["id"])
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
