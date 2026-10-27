"""独立检查手写 Linking gold 的引用与边界，不生成答案、不调用模型。"""

import json
import sqlite3
import unittest
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = APP_ROOT / "fixtures"
L0 = FIXTURES / "l0"


def relation_key(relation):
    # FK 的编号和方向不构成业务语义，完整列对才是复合关系的校验依据。
    return tuple(sorted(
        tuple(sorted((f"{relation['left_table']}.{pair['left']}",
                      f"{relation['right_table']}.{pair['right']}")))
        for pair in relation["pairs"]
    ))


class LinkingGoldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gold_path = FIXTURES / "l0-linking-cases.json"
        cls.suite = json.loads(cls.gold_path.read_text())
        cls.cases = cls.suite["cases"]
        cls.metrics = {item["metric_id"]: item for item in json.loads((L0 / "metrics.json").read_text())["metrics"]}
        cls.semantics = json.loads((L0 / "mock_semantics.json").read_text())
        cls.metric_bindings = {item["metric_id"]: item for item in cls.semantics["metric_bindings"]}
        cls.candidates = {item["id"]: item for item in cls.semantics["relations"] if item["status"] == "candidate"}
        # 在内存中只解释原始 DDL，防止校验创建/污染运行库，也不依赖模型生成结果。
        cls.db = sqlite3.connect(":memory:")
        cls.db.executescript((L0 / "mock_schema.sql").read_text())
        cls.tables = {row[0] for row in cls.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        cls.fields = set()
        cls.relations = set()
        for table in cls.tables:
            cls.fields.update(f"{table}.{row[1]}" for row in cls.db.execute(f'PRAGMA table_info("{table}")'))
            grouped = {}
            for row in cls.db.execute(f'PRAGMA foreign_key_list("{table}")'):
                relation = grouped.setdefault(row[0], {"left_table": table, "right_table": row[2], "pairs": []})
                relation["pairs"].append({"left": row[3], "right": row[4]})
            cls.relations.update(relation_key(item) for item in grouped.values())

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_gold_is_separate_and_covers_requested_families(self):
        self.assertNotEqual(self.gold_path.parent, L0)
        self.assertEqual(self.suite["scope"], "schema_linking_only_not_metric_value_evaluation")
        self.assertEqual(self.suite["source_id"], "l0_mock")
        self.assertEqual(len(self.cases), 14)
        self.assertEqual(len({case["id"] for case in self.cases}), 14)
        self.assertEqual({metric for case in self.cases for metric in case["expected"]["metric_ids"]}, {
            "met.gk-01", "met.gk-23", "met.sh-ps-m0003", "met.gk-36", "met.gk-04",
            "met.sh-ps-m0645", "met.sh-ps-s012", "met.gk-17",
        })

    def test_fields_and_business_times_are_qualified_and_declared(self):
        for case in self.cases:
            with self.subTest(case=case["id"]):
                expected = case["expected"]
                tables = expected["tables"] + case.get("allowed_extra_tables", [])
                fields = expected["fields"] + case.get("allowed_extra_fields", [])
                times = expected["time_fields"] + case.get("allowed_extra_time_fields", [])
                self.assertLessEqual(set(tables), self.tables)
                self.assertLessEqual(set(fields), self.fields)
                self.assertLessEqual(set(times), set(fields))
                self.assertTrue(all(field.count(".") == 1 and field.split(".")[0] in tables for field in fields))
                for key in ("metric_ids", "tables", "fields", "time_fields", "candidate_relations"):
                    self.assertEqual(len(expected[key]), len(set(expected[key])))
                source_times = {field.removeprefix("fld.") for metric in expected["metric_ids"]
                                for field in self.metrics[metric]["time_rule"]["business_time_field_ids"]}
                self.assertEqual(set(expected["time_fields"]), source_times)

    def test_actual_relations_use_complete_foreign_key_pairs(self):
        for case in self.cases:
            expected = case["expected"]
            for relation in expected["relations"] + case.get("allowed_extra_relations", []):
                with self.subTest(case=case["id"], relation=relation):
                    # 仅删 institution_id 的错误 JOIN 不应被接受为已存在关系。
                    self.assertIn(relation_key(relation), self.relations)
                    columns = {f"{relation[side + '_table']}.{pair[side]}"
                               for pair in relation["pairs"] for side in ("left", "right")}
                    self.assertLessEqual(columns, set(expected["fields"]) | set(case.get("allowed_extra_fields", [])))
                    self.assertIn({"left": "institution_id", "right": "institution_id"}, relation["pairs"])
                    incomplete = {**relation, "pairs": [pair for pair in relation["pairs"] if pair["left"] != "institution_id"]}
                    self.assertNotIn(relation_key(incomplete), self.relations)

    def test_candidate_relations_stay_separate_and_keep_version_columns(self):
        for case in self.cases:
            expected = case["expected"]
            for candidate_id in expected["candidate_relations"]:
                with self.subTest(case=case["id"], candidate=candidate_id):
                    candidate = self.candidates[candidate_id]
                    self.assertNotIn(relation_key(candidate), self.relations)
                    columns = {f"{candidate[side + '_table']}.{pair[side]}"
                               for pair in candidate["pairs"] for side in ("left", "right")}
                    self.assertLessEqual(columns, set(expected["fields"]))
        ddd = self.candidates["rel.medication_administrations__drug_ddd_standards__candidate"]
        self.assertEqual(len(ddd["pairs"]), 4)

    def test_code_values_keep_types_and_do_not_invent_unbound_parameters(self):
        codes = {(item["physical_field"], json.dumps(item["value"])) for item in self.semantics["code_mappings"]}
        # 新增合成枚举必须由单独约定显式登记，不能从模型回答或数据库碰巧出现的值反推。
        conventions = json.loads((L0 / "mock_conventions.json").read_text())
        for rule in conventions["global_rules"]:
            if rule["id"] == "extra_code_values":
                codes.update((field, json.dumps(value)) for field, values in rule["field_values"].items() for value in values)
        for case in self.cases:
            for condition in case["expected"]["code_filters"] + case.get("allowed_extra_code_filters", []):
                with self.subTest(case=case["id"], condition=condition):
                    self.assertIn(condition["field"], case["expected"]["fields"])
                    if condition["op"] in ("is_null", "is_not_null"):
                        self.assertIsNone(condition["value"])
                    else:
                        values = condition["value"] if condition["op"] in ("in", "not_in") else [condition["value"]]
                        self.assertTrue(values)
                        for value in values:
                            self.assertIn((condition["field"], json.dumps(value)), codes)
            if "met.gk-36" in case["expected"]["metric_ids"]:
                self.assertEqual(case["expected"]["code_filters"], [])

    def test_blocked_is_not_used_as_a_substitute_for_linking(self):
        empty = []
        for case in self.cases:
            expected = case["expected"]
            actual_statuses = {item["metric_id"]: item["status"] for item in expected["execution_statuses"]}
            self.assertEqual(actual_statuses, {metric: self.metric_bindings[metric]["execution_status"] for metric in expected["metric_ids"]})
            self.assertTrue(case["notes"].strip())
            if not expected["metric_ids"]:
                empty.append(case)
                self.assertTrue(all(value == [] for value in expected.values()))
            else:
                self.assertTrue(expected["tables"])
                self.assertTrue(expected["fields"])
        self.assertEqual(len(empty), 1)


if __name__ == "__main__":
    unittest.main()
