"""问题与私有 gold 的定向离线回归；只使用临时内存合成库，不访问模型。"""

from copy import deepcopy
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch


APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / "python"))

from l0_benchmark_core import populate_core
from l0_benchmark_questions import AS_OF, METRIC_FAMILIES, PUBLIC_KEYS, build_questions, rows_equal, validate_gold


KNOWLEDGE = APP / "fixtures" / "l0"


class BenchmarkQuestionsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 八名批量患者已覆盖所有域；保留九月固定控制样本，缩小测试成本。
        cls.template = sqlite3.connect(":memory:")
        cls.template.executescript((KNOWLEDGE / "mock_schema.sql").read_text(encoding="utf-8"))
        populate_core(cls.template, patients_per_institution=8)
        cls.template.commit()

    @classmethod
    def tearDownClass(cls):
        cls.template.close()

    def setUp(self):
        self.connection = sqlite3.connect(":memory:")
        self.template.backup(self.connection)
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.addCleanup(self.connection.close)
        self.questions, self.gold = build_questions(self.connection, KNOWLEDGE)
        self.cases = {case["id"]: case for case in self.gold}

    def rows(self, number):
        return self.cases[f"L0F-{number:03d}"]["expected_rows"]

    def test_all_reference_queries_match_independent_python(self):
        report = validate_gold(self.connection, self.questions, self.gold)
        self.assertEqual(report["question_count"], 136)
        self.assertEqual(report["official_metrics"], 47)
        self.assertEqual(report["formal_cases"], 94)
        self.assertEqual(report["fact_cases"], 40)
        self.assertGreaterEqual(report["multi_table_fact_cases"], 6)
        self.assertGreaterEqual(report["negative_controls_killed"], 5)
        self.assertTrue(report["sql_reference_matches_python"])

    def test_product_questions_have_no_gold_and_are_standalone(self):
        for question in self.questions:
            self.assertEqual(set(question), PUBLIC_KEYS)
            self.assertEqual(question["as_of"], AS_OF)
            for dependent_phrase in ("同上", "上一条", "沿用"):
                self.assertNotIn(dependent_phrase, question["question"])
        self.assertEqual(self.cases["L0B-CLARIFY"]["expected_action"], "clarify")
        self.assertEqual(self.cases["L0B-NO-MATCH"]["expected_match_status"], "no_match")

    def test_formal_metrics_stay_blocked_with_concrete_provenance(self):
        formal = [case for case in self.gold if case["category"].startswith("official_metric_")]
        self.assertEqual(len(formal), 94)
        for case in formal:
            self.assertEqual(case["expected_action"], "blocked")
            self.assertEqual(case["source_id"], "l0_benchmark")
            self.assertNotIn("expected_rows", case)
            self.assertNotIn("reference_sql", case)
            self.assertTrue(case["required_blockers"])
            self.assertTrue(case["source_refs"])
            self.assertEqual(case["required_gap_ids"], [item["gap_id"] for item in case["required_blockers"]])
            self.assertTrue(all(item["description"] for item in case["required_blockers"]))
        statuses = {case["expected_execution_statuses"][0]["status"] for case in formal}
        self.assertIn("blocked_rule_source", statuses)
        self.assertEqual({case["required_metric_ids"][0] for case in formal}, set(METRIC_FAMILIES))

    def test_manual_anchors_and_normal_empty_result(self):
        # 固定手算锚点独立于批量规模，不能被自动生成答案悄悄覆盖。
        for number, expected in {
            1: [{"visit_count": 7}], 2: [{"patient_count": 5}], 3: [{"stay_count": 7}],
            4: [{"procedure_count": 3}], 5: [{"operative_stay_count": 2}],
            6: [{"numerator": 2, "denominator": 7, "percent": 28.571429}],
            7: [{"asset_yuan": 1000}], 8: [{"liability_yuan": 300}],
            9: [{"liability_yuan": 300, "asset_yuan": 1000, "percent": 30}], 14: [],
        }.items():
            with self.subTest(case=number):
                self.assertTrue(rows_equal(self.rows(number), expected))
        self.assertNotEqual(self.rows(21)[0]["recorded_bed_days"], 5)

    def test_hand_calculated_bulk_units_growth_and_reference_mean(self):
        # scale=8：每人非带药2.5g；四人A药匹配同单位，八人B药匹配，合成DDD合计12。
        self.assertEqual(self.rows(29), [{"quantity_g": 20.0}])
        self.assertEqual(self.rows(30), [{"synthetic_ddd": 12.0}])
        # 八个月电+气系数加权：(0.15+0.002*m)求和=1.272；水没有系数，不纳入。
        self.assertEqual(self.rows(31), [{"coal_tons": 1.272}])
        self.assertTrue(rows_equal(self.rows(25), [{"year": "2025", "revenue_yuan": 9684}, {"year": "2026", "revenue_yuan": 10644}]))
        self.assertEqual(self.rows(26), [{"previous_yuan": 9684.0, "current_yuan": 10644.0, "growth_percent": 9.913259}])
        self.assertEqual(self.rows(34), [{"case_count": 16, "mean_reference_days": 4.125}])
        self.assertEqual(self.rows(36), [{"sample_count": 5, "median_minutes": 19.0}])

    def test_generation_uses_raw_facts_without_executing_reference_sql(self):
        # 生成答案时禁用参考查询，确保 Python oracle 不是 SQL 结果回填。
        with patch("l0_benchmark_questions._query_rows", side_effect=AssertionError("不得用于生成答案")):
            questions, gold = build_questions(self.connection, KNOWLEDGE)
        self.assertEqual(questions, self.questions)
        self.assertEqual(gold, self.gold)

    def test_query_only_connection_and_sqlite_row_factory(self):
        before = self.connection.total_changes
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA query_only=ON")
        questions, gold = build_questions(self.connection, KNOWLEDGE)
        validate_gold(self.connection, questions, gold)
        self.assertEqual(self.connection.total_changes, before)
        self.assertEqual(gold, self.gold)

    def test_family_split_and_metric_rewrites_never_cross(self):
        splits = {}
        for case in self.gold:
            family = case["family_id"]
            splits.setdefault(family, set()).add(case["split"])
            self.assertIn("不声称", case["holdout_policy"])
        self.assertTrue(all(len(values) == 1 for values in splits.values()))
        self.assertEqual(splits["drg_reference"], {"holdout"})
        self.assertEqual(splits["financial_growth"], {"holdout"})
        for metric in METRIC_FAMILIES:
            cases = [case for case in self.gold if case.get("required_metric_ids") == [metric]]
            self.assertEqual(len(cases), 2)
            self.assertEqual(cases[0]["split"], cases[1]["split"])

    def test_damaged_gold_and_public_leak_are_rejected(self):
        damaged = deepcopy(self.gold)
        next(case for case in damaged if case["id"] == "L0F-001")["expected_rows"] = [{"visit_count": 5}]
        with self.assertRaisesRegex(ValueError, "Python 与参考 SQL 不一致"):
            validate_gold(self.connection, self.questions, damaged)
        leaked = deepcopy(self.questions)
        leaked[0]["expected_action"] = "blocked"
        with self.assertRaisesRegex(ValueError, "泄露 gold"):
            validate_gold(self.connection, leaked, self.gold)
        damaged = deepcopy(self.gold)
        damaged[0]["split"] = "holdout"
        with self.assertRaisesRegex(ValueError, "family 分组漂移"):
            validate_gold(self.connection, self.questions, damaged)

    def test_equivalent_mutation_is_not_counted_as_killed(self):
        # 若误把原查询列为负例，评分器必须拒绝报告“成功识别”。
        damaged = deepcopy(self.gold)
        case = next(case for case in damaged if case["id"] == "L0F-001")
        case["negative_controls"] = [{"id": "unchanged", "sql": case["reference_sql"]}]
        with self.assertRaisesRegex(ValueError, "负对照未被识别"):
            validate_gold(self.connection, self.questions, damaged)

    def test_mutations_distinguish_wrong_counts_scope_date_and_version(self):
        report = validate_gold(self.connection, self.questions, self.gold)
        count = sum(len(case.get("negative_controls", [])) for case in self.gold)
        self.assertEqual(report["negative_controls_killed"], count)
        self.assertGreaterEqual(count, 5)
        self.assertIn("wrong_ddd_version", {item["id"] for item in self.cases["L0F-030"]["negative_controls"]})
        self.assertIn("drop_patient_institution_key", {item["id"] for item in self.cases["L0F-016"]["negative_controls"]})

    def test_second_scale_and_seed_keep_control_anchors(self):
        # 新规模/随机种子重新造数，再独立计算与核验，避免只有一个数据状态偶然相等。
        with sqlite3.connect(":memory:") as other:
            other.executescript((KNOWLEDGE / "mock_schema.sql").read_text(encoding="utf-8"))
            populate_core(other, seed=20261019, patients_per_institution=12)
            questions, gold = build_questions(other, KNOWLEDGE)
            report = validate_gold(other, questions, gold)
            self.assertEqual(report["manual_anchors_checked"], 9)
            self.assertEqual(report["negative_controls_killed"], 5)

    def test_empty_denominators_and_missing_times_remain_null(self):
        # 只在独立内存副本清空选择条件，校验正常空集和零分母，不改变正式指标规则。
        self.connection.execute("DELETE FROM emergency_rescue_episodes")
        self.connection.execute("DELETE FROM financial_entries WHERE accounting_date>='2025-01-01' AND accounting_date<'2025-09-01'")
        self.connection.execute("UPDATE appointment_events SET called_at=NULL WHERE institution_id='H001'")
        questions, gold = build_questions(self.connection, KNOWLEDGE)
        cases = {case["id"]: case for case in gold}
        self.assertEqual(cases["L0F-010"]["expected_rows"], [])
        self.assertEqual(cases["L0F-011"]["expected_rows"], [{"sample_count": 0, "mean_minutes": None}])
        self.assertIsNone(cases["L0F-026"]["expected_rows"][0]["growth_percent"])
        self.assertEqual(cases["L0F-036"]["expected_rows"], [{"sample_count": 0, "median_minutes": None}])
        validate_gold(self.connection, questions, gold)

    def test_median_even_odd_and_duplicate_episodes(self):
        self.connection.execute("DELETE FROM emergency_rescue_episodes")
        for index, minute in enumerate((10, 20, 30, 40)):
            self.connection.execute(
                "INSERT INTO emergency_rescue_episodes(institution_id,rescue_episode_id,visit_id,entered_at,left_at,departure_status_code) VALUES (?,?,?,?,?,?)",
                ("H001", f"T{index}", "BV2026000010", "2026-02-03 09:00:00", f"2026-02-03 09:{minute:02d}:00", "ALIVE"),
            )
        questions, gold = build_questions(self.connection, KNOWLEDGE)
        self.assertEqual(next(case for case in gold if case["id"] == "L0F-036")["expected_rows"], [{"sample_count": 4, "median_minutes": 25.0}])
        validate_gold(self.connection, questions, gold)
        self.connection.execute("DELETE FROM emergency_rescue_episodes WHERE rescue_episode_id='T3'")
        questions, gold = build_questions(self.connection, KNOWLEDGE)
        self.assertEqual(next(case for case in gold if case["id"] == "L0F-036")["expected_rows"], [{"sample_count": 3, "median_minutes": 20.0}])
        validate_gold(self.connection, questions, gold)

    def test_rows_equal_preserves_types_duplicates_and_column_roles(self):
        self.assertTrue(rows_equal([{"a": 1}, {"a": None}], [{"a": None}, {"a": 1.0}]))
        for left, right in (
            ([{"a": None}], [{"a": 0}]), ([{"a": "1"}], [{"a": 1}]),
            ([{"a": True}], [{"a": 1}]), ([{"a": 1}], [{"b": 1}]),
            ([{"a": 1}, {"a": 1}], [{"a": 1}, {"a": 2}]),
            ([{"a": float("nan")}], [{"a": float("nan")}]),
            ([{"a": float("inf")}], [{"a": float("inf")}]),
        ):
            with self.subTest(left=left, right=right):
                self.assertFalse(rows_equal(left, right))


if __name__ == "__main__":
    unittest.main()
