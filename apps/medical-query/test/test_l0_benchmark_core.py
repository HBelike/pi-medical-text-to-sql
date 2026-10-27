"""L0 批量原始事实的离线一致性回归；不把合成约定认定为正式指标口径。"""

from __future__ import annotations

import sqlite3
import sys
import unittest
from datetime import datetime
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
# 只导入本地纯 Python 生成器；测试数据库全在内存，不访问实际数据源或模型。
sys.path.insert(0, str(APP_ROOT / "python"))
from l0_benchmark_core import AS_OF, populate_core


class L0BenchmarkCoreTests(unittest.TestCase):
    """128 人覆盖死亡、取消及曾经在第 124 人发生的家庭床位/ICU 冲突。"""

    @classmethod
    def setUpClass(cls):
        cls.connection = sqlite3.connect(":memory:")
        cls.addClassCleanup(cls.connection.close)
        cls.connection.execute("PRAGMA foreign_keys=ON")
        cls.connection.executescript((APP_ROOT / "fixtures/l0/mock_schema.sql").read_text(encoding="utf-8"))
        cls.summary = populate_core(cls.connection, seed=20261016, patients_per_institution=128)
        cls.connection.commit()
        cls.connection.execute("PRAGMA query_only=ON")
        tables = cls.connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        cls.data = {}
        for (table,) in tables:
            cursor = cls.connection.execute(f'SELECT * FROM "{table}"')
            names = [column[0] for column in cursor.description]
            cls.data[table] = [dict(zip(names, row)) for row in cursor.fetchall()]
        cls.stays = {(r["institution_id"], r["stay_id"]): r for r in cls.data["inpatient_stays"]}
        cls.visits = {(r["institution_id"], r["visit_id"]): r for r in cls.data["outpatient_visits"]}

    def test_schema_integrity_and_nonempty_core_domains(self):
        self.assertEqual(len(self.data), 26)
        self.assertEqual(sum(len(self.connection.execute(f'PRAGMA table_info("{table}")').fetchall()) for table in self.data), 216)
        self.assertEqual(self.connection.execute("PRAGMA integrity_check").fetchall(), [("ok",)])
        self.assertEqual(self.connection.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(self.summary["provenance"], "synthetic_test_design")
        for table, rows in self.data.items():
            self.assertTrue(rows, f"核心事件域不能因生成分支未命中而空置：{table}")

    def test_patient_birth_and_death_bound_longitudinal_encounters(self):
        # 纵向主索引不能继承旧局部样例里“死亡后再入院”的矛盾。
        patients = {(r["institution_id"], r["patient_id"]): r for r in self.data["patients"]}
        deaths = {}
        for stay in self.stays.values():
            if stay["discharge_disposition_code"] == "DEATH":
                key = stay["institution_id"], stay["patient_id"]
                deaths[key] = min(deaths.get(key, stay["discharged_at"]), stay["discharged_at"])
        self.assertTrue(deaths)
        for row in [*self.visits.values(), *self.stays.values()]:
            key = row["institution_id"], row["patient_id"]
            started = row.get("registered_at") or row["admitted_at"]
            birthday = patients[key]["date_of_birth"]
            if birthday is not None:
                self.assertLessEqual(birthday, started[:10], key)
            if key in deaths:
                self.assertLessEqual(started, deaths[key], key)

    def test_bulk_repeat_stays_keep_institution_keys_and_do_not_overlap(self):
        # 同一局部编号在多机构重复是刻意的负对照；关联必须保留机构维度。
        groups = {}
        for row in self.stays.values():
            if row["patient_id"].startswith("BP"):
                groups.setdefault((row["institution_id"], row["patient_id"]), []).append(row)
        self.assertEqual(len(groups), 3 * 128)
        for key, stays in groups.items():
            self.assertEqual(len(stays), 2, key)
            first, second = sorted(stays, key=lambda r: r["admitted_at"])
            self.assertLess(first["discharged_at"], second["admitted_at"], key)
        self.assertEqual({inst for inst, patient in groups if patient == "BP00124"}, {"H001", "H002", "H999"})

    def test_stay_events_and_repeat_procedures_have_valid_time_order(self):
        # 用父住院的实际区间验证事实，而非重复生成器的日期计算公式。
        for table, field in (("inpatient_procedures", "performed_at"), ("clinical_events", "occurred_at"),
                             ("medication_administrations", "consumed_at")):
            for row in self.data[table]:
                stay = self.stays[row["institution_id"], row["stay_id"]]
                stamp = row[field]
                self.assertIsNotNone(stamp, table)
                datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S")
                self.assertLessEqual(stay["admitted_at"], stamp, table)
                if stay["discharged_at"]:
                    self.assertLessEqual(stamp, stay["discharged_at"], table)
        procedures = {(r["institution_id"], r["procedure_id"]): r for r in self.data["inpatient_procedures"]}
        repeated = [r for r in procedures.values() if r["prior_procedure_id"]]
        self.assertTrue(repeated)
        for row in repeated:
            prior = procedures[row["institution_id"], row["prior_procedure_id"]]
            self.assertEqual(row["stay_id"], prior["stay_id"])
            self.assertLess(prior["performed_at"], row["performed_at"])

    def test_icu_risk_and_emergency_episodes_stay_within_parent_events(self):
        episodes = {(r["institution_id"], r["icu_episode_id"]): r for r in self.data["icu_episodes"]}
        for row in episodes.values():
            stay = self.stays[row["institution_id"], row["stay_id"]]
            self.assertLessEqual(stay["admitted_at"], row["icu_entered_at"])
            self.assertLess(row["icu_entered_at"], row["icu_left_at"])
            self.assertLessEqual(row["icu_left_at"], stay["discharged_at"])
        for row in self.data["icu_risk_assessments"]:
            episode = episodes[row["institution_id"], row["icu_episode_id"]]
            self.assertLessEqual(episode["icu_entered_at"], row["assessed_at"])
            self.assertLessEqual(row["assessed_at"], episode["icu_left_at"])
        for row in self.data["emergency_rescue_episodes"]:
            visit = self.visits[row["institution_id"], row["visit_id"]]
            self.assertEqual(visit["care_setting_code"], "EMERGENCY")
            self.assertEqual(visit["visit_status_code"], "COMPLETED")
            self.assertLessEqual(visit["registered_at"], row["entered_at"])
            self.assertLess(row["entered_at"], row["left_at"])

    def test_appointment_missing_values_and_complete_pair_order(self):
        # 缺失记录不得补成零等待；完整配对允许真实零分钟。
        incomplete = complete = 0
        for row in self.data["appointment_events"]:
            if row["checked_in_at"] is None or row["called_at"] is None:
                incomplete += 1
            else:
                complete += 1
                self.assertLessEqual(row["checked_in_at"], row["called_at"])
        self.assertGreater(incomplete, 0)
        self.assertGreater(complete, 0)

    def test_census_records_require_actual_ward_arrival_and_occupied_time(self):
        as_of = datetime.fromisoformat(AS_OF).replace(tzinfo=None)
        for row in self.data["inpatient_census_days"]:
            stay = self.stays[row["institution_id"], row["stay_id"]]
            self.assertIsNotNone(stay["ward_arrived_at"])
            arrived = datetime.fromisoformat(stay["ward_arrived_at"])
            ended = datetime.fromisoformat(stay["discharged_at"]) if stay["discharged_at"] else as_of
            if row["count_basis_code"] == "MIDNIGHT":
                midnight = datetime.fromisoformat(row["census_date"])
                self.assertLess(arrived, midnight)
                self.assertLess(midnight, ended)
            else:
                self.assertEqual(row["count_basis_code"], "SAME_DAY_EXIT")
                self.assertEqual(arrived.date(), ended.date())
                self.assertEqual(row["census_date"], str(arrived.date()))

    def test_death_discharge_has_no_take_home_medication(self):
        # 同时确认死亡与存活带药样本存在，防止删空整类记录让断言虚假通过。
        self.assertTrue(any(r["discharge_disposition_code"] == "DEATH" for r in self.stays.values()))
        take_home = [r for r in self.data["medication_administrations"] if r["take_home_at_discharge_flag"] == 1]
        self.assertTrue(take_home)
        for row in take_home:
            stay = self.stays[row["institution_id"], row["stay_id"]]
            self.assertNotEqual(stay["discharge_disposition_code"], "DEATH")
            self.assertEqual(row["consumed_at"], stay["discharged_at"])

    def test_procedure_grade_matches_effective_synthetic_catalog(self):
        # 同代码、体系、版次和有效年份必须给出一致分级，不能字段三级而目录四级。
        catalog = [r for r in self.data["clinical_code_memberships"] if r["catalog_id"] == "SYN_GRADE4"]
        seen_grades = set()
        for row in self.data["inpatient_procedures"]:
            effective = [c for c in catalog if c["code_system"] == row["code_system"]
                         and c["code_edition"] == row["code_edition"] and c["code"] == row["procedure_code"]
                         and c["valid_from"] <= row["performed_at"][:10] <= c["valid_to"]]
            self.assertLessEqual(len(effective), 1)
            self.assertEqual(bool(effective), row["surgery_grade_code"] == "4", row["procedure_id"])
            seen_grades.add(row["surgery_grade_code"])
        self.assertTrue({"3", "4"} <= seen_grades)

    def test_cancelled_visits_have_no_recognized_revenue(self):
        cancelled = {key for key, row in self.visits.items() if row["visit_status_code"] == "CANCELLED"}
        self.assertTrue(cancelled)
        revenue = [r for r in self.data["financial_entries"] if r["account_kind_code"] == "REVENUE" and r["visit_id"]]
        self.assertTrue(revenue)
        for row in revenue:
            self.assertNotIn((row["institution_id"], row["visit_id"]), cancelled)

    def test_home_beds_exclude_ward_arrival_surgery_icu_and_inpatient_events(self):
        homes = {key: row for key, row in self.stays.items() if row["home_bed_flag"] == 1}
        self.assertTrue(homes, "家庭病床排除样例须保留")
        for row in homes.values():
            self.assertIsNone(row["ward_arrived_at"])
        for table in ("inpatient_procedures", "icu_episodes", "clinical_events", "inpatient_census_days"):
            for row in self.data[table]:
                self.assertNotIn((row["institution_id"], row["stay_id"]), homes, table)

    def test_ddd_version_unit_keys_and_wrong_year_change_numeric_result(self):
        standards = {(r["drug_code_system"], r["drug_code_edition"], r["drug_code"], r["ddd_version"]): r
                     for r in self.data["drug_ddd_standards"]}
        for row in self.data["medication_administrations"]:
            key = row["drug_code_system"], row["drug_code_edition"], row["drug_code"], row["ddd_standard_version"]
            self.assertIn(key, standards)
            self.assertGreater(standards[key]["ddd_quantity"], 0)
            self.assertEqual(row["ddd_standard_version"], f"SYN_DDD_{row['consumed_at'][:4]}")
        # 错版必须改变测试答案；只比较单位完全匹配的样本，避免用单位错误掩盖版本错误。
        query = """SELECT SUM(m.quantity/d.ddd_quantity) FROM medication_administrations m
            JOIN drug_ddd_standards d ON d.drug_code_system=m.drug_code_system
            AND d.drug_code_edition=m.drug_code_edition AND d.drug_code=m.drug_code
            AND d.ddd_version=? WHERE m.institution_id='H001' AND m.drug_code='SYN_DRUG_A'
            AND m.consumed_at>='2026-01-01' AND m.consumed_at<'2027-01-01'
            AND m.quantity_unit=d.ddd_unit AND m.take_home_at_discharge_flag=0"""
        old = self.connection.execute(query, ("SYN_DDD_2025",)).fetchone()[0]
        current = self.connection.execute(query, ("SYN_DDD_2026",)).fetchone()[0]
        self.assertGreater(current, 0)
        self.assertNotEqual(old, current)

    def test_drg_reference_keys_and_year_specific_values(self):
        references = {(r["reference_year"], r["grouper_version"], r["drg_code"]): r for r in self.data["drg_group_reference"]}
        for row in self.data["drg_case_assignments"]:
            key = row["reference_year"], row["grouper_version"], row["drg_code"]
            self.assertIn(key, references)
            stay = self.stays[row["institution_id"], row["stay_id"]]
            self.assertLessEqual(stay["discharged_at"], row["assigned_at"])
            self.assertEqual(row["reference_year"], int(stay["discharged_at"][:4]))
        for row in references.values():
            if row["reference_year"] == 2026:
                previous = references[2025, "SYN_DRG_2025", row["drg_code"]]
                self.assertNotEqual(row["relative_weight"], previous["relative_weight"])
                self.assertNotEqual(row["reference_cost_yuan"], previous["reference_cost_yuan"])


if __name__ == "__main__":
    unittest.main()
