"""关系别名回归：授权来自真实 SQLite 外键，不能由字典自称 synthetic_sql_fk 绕过。"""

from __future__ import annotations

import copy
import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, APP_ROOT / "python" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


domain = load_module("domain_relation_aliases", "domain.py")
fixtures = load_module("fixtures_relation_aliases", "build_l0_fixtures.py")


class RelationAliasTests(unittest.TestCase):
    """同一业务 ID 分布在两个机构，用真实联查结果识别机构列遗漏与错误映射。"""

    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.path = Path(self.workspace.name) / "relations.sqlite"
        self.dictionary = Path(self.workspace.name) / "relations.json"
        with sqlite3.connect(self.path) as connection:
            connection.executescript("""
                PRAGMA foreign_keys = ON;
                CREATE TABLE parents(institution_id TEXT, patient_id TEXT, label TEXT,
                    PRIMARY KEY(institution_id, patient_id));
                CREATE TABLE children(id INTEGER PRIMARY KEY, institution_id TEXT, patient_id TEXT,
                    other_institution_id TEXT, FOREIGN KEY(institution_id, patient_id) REFERENCES parents);
                INSERT INTO parents VALUES ('H001','P001','right'),('H999','P001','cross-tenant');
                INSERT INTO children VALUES (1,'H001','P001','H999');
            """)
        self.alias = {
            "id": "rel.children.parents", "left_table": "children", "right_table": "parents",
            "pairs": [{"left": "institution_id", "right": "institution_id"},
                      {"left": "patient_id", "right": "patient_id"}],
            "origin": "synthetic_sql_fk", "status": "active",
        }

    def request(self, relations, relation_id=None):
        self.dictionary.write_text(json.dumps({"relations": relations}), encoding="utf-8")
        request = {"action": "catalog" if relation_id is None else "execute", "path": str(self.path),
                   "dictionary_path": str(self.dictionary)}
        if relation_id is not None:
            request["dsl"] = {"from": "children", "select": [{"field": "parents.label"}],
                              "joins": [{"relation": relation_id, "type": "inner"}]}
        return domain.handle(request)

    def test_complete_unordered_alias_maps_to_physical_fk_and_preserves_tenant(self):
        alias = copy.deepcopy(self.alias)
        alias["pairs"].reverse()
        catalog = self.request([alias])["catalog"]
        relations = {relation["id"]: relation for relation in catalog["relations"]}
        self.assertIn("fk:children:0", relations)
        resolved = relations[alias["id"]]
        self.assertEqual(resolved["physical_relation_id"], "fk:children:0")
        self.assertEqual(resolved["origin"], "database_metadata")
        self.assertEqual(resolved["declared_origin"], "synthetic_sql_fk")
        result = self.request([alias], alias["id"])
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["rows"], [["right"]])
        self.assertIn('"children"."institution_id" = "parents"."institution_id"', result["sql"])
        self.assertEqual(self.request([alias], "fk:children:0")["rows"], result["rows"])

    def test_incomplete_duplicate_wrong_table_and_wrong_tenant_pairs_are_rejected(self):
        mutations = [
            {"pairs": self.alias["pairs"][1:]},
            {"pairs": self.alias["pairs"] + [self.alias["pairs"][0]]},
            {"pairs": [{"left": "other_institution_id", "right": "institution_id"}, self.alias["pairs"][1]]},
            {"pairs": [{"left": "institution_id", "right": "patient_id"},
                       {"left": "patient_id", "right": "institution_id"}]},
            {"right_table": "children"},
            {"pairs": [{"left": [], "right": "institution_id"}]},
            {"left_table": "parents", "right_table": "children"},
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                result = self.request([{**self.alias, **mutation}])
                self.assertFalse(result["ok"], result)
                self.assertEqual(result["error"]["code"], "INVALID_DICTIONARY")

    def test_candidate_inactive_and_model_inferred_relations_never_promote(self):
        for mutation in ({"status": "candidate"}, {"status": "inactive"}, {"origin": "model_inferred"}):
            with self.subTest(mutation=mutation):
                candidate = {**self.alias, **mutation}
                self.assertEqual(len(self.request([candidate])["catalog"]["relations"]), 1)
                self.assertEqual(self.request([candidate], candidate["id"])["error"]["code"], "UNKNOWN_RELATION")
                self.assertEqual(self.request([candidate], "fk:children:0")["rows"], [["right"]])

    def test_alias_ids_cannot_replace_physical_or_other_aliases(self):
        for relations in ([{**self.alias, "id": "fk:children:0"}], [self.alias, copy.deepcopy(self.alias)]):
            with self.subTest(relations=relations):
                self.assertEqual(self.request(relations)["error"]["code"], "INVALID_DICTIONARY")

    def test_existing_human_confirmation_remains_a_distinct_authority(self):
        # 人工审核关系仍走原有审批路径；这条兼容检查不把普通模型猜测升级为已审核关系。
        approved = {**self.alias, "origin": "human_confirmed"}
        self.assertEqual(self.request([approved], approved["id"])["rows"], [["right"]])
        self.assertNotIn("physical_relation_id", self.request([approved])["catalog"]["relations"][-1])


class L0RelationAliasExecutionTests(unittest.TestCase):
    """直接调用生产 Python JSON 入口，验证真实 L0 关系 ID，而不是手写目录替身。"""

    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory()
        cls.source = fixtures.build(Path(cls.workspace.name))

    @classmethod
    def tearDownClass(cls):
        cls.workspace.cleanup()

    def execute(self, dsl):
        request = {"action": "execute", "path": self.source["path"],
                   "dictionary_path": self.source["dictionary_path"], "dsl": dsl}
        process = subprocess.run([sys.executable, str(APP_ROOT / "python/domain.py")],
                                 input=json.dumps(request), capture_output=True, text=True, check=True)
        self.assertEqual(process.stderr, "")
        result = json.loads(process.stdout)
        self.assertTrue(result["ok"], result)
        return result

    def test_l0f004_procedure_stay_alias_executes_full_composite_join(self):
        result = self.execute({
            "from": "inpatient_procedures", "select": [{"field": "*", "aggregate": "count", "as": "procedure_count"}],
            "joins": [{"relation": "rel.inpatient_procedures__inpatient_stays__institution_id_stay_id", "type": "inner"}],
            "where": [{"field": "inpatient_stays.institution_id", "op": "eq", "value": "H001"},
                      {"field": "inpatient_stays.discharged_at", "op": "gte", "value": "2026-09-01"},
                      {"field": "inpatient_stays.discharged_at", "op": "lt", "value": "2026-10-01"},
                      {"field": "inpatient_stays.home_bed_flag", "op": "eq", "value": 0}],
        })
        self.assertEqual(result["rows"], [[3]])
        self.assertIn('"inpatient_procedures"."institution_id" = "inpatient_stays"."institution_id"', result["sql"])

    def test_l0f019_appointment_visit_department_aliases_execute_without_tenant_fanout(self):
        result = self.execute({
            "from": "appointment_events",
            "select": [{"field": "departments.department_id"}, {"field": "departments.department_name"},
                       {"field": "*", "aggregate": "count", "as": "appointment_count"}],
            "joins": [{"relation": "rel.appointment_events__outpatient_visits__institution_id_visit_id", "type": "inner"},
                      {"relation": "rel.outpatient_visits__departments__institution_id_department_id", "type": "inner"}],
            "where": [{"field": "appointment_events.institution_id", "op": "eq", "value": "H001"},
                      {"field": "appointment_events.appointment_status_code", "op": "eq", "value": "SUCCESS"},
                      {"field": "outpatient_visits.registered_at", "op": "gte", "value": "2026-09-01"},
                      {"field": "outpatient_visits.registered_at", "op": "lt", "value": "2026-10-01"}],
            "group_by": ["departments.department_id", "departments.department_name"],
        })
        self.assertEqual(result["rows"], [["D_MED", "合成内科", 6]])
        self.assertIn('"appointment_events"."institution_id" = "outpatient_visits"."institution_id"', result["sql"])
        self.assertIn('"outpatient_visits"."institution_id" = "departments"."institution_id"', result["sql"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
