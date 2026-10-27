"""支撑业务底座离线回归；不连接服务、不调用模型、不使用评测标准答案。"""

from __future__ import annotations

import json
import sqlite3
import sys
import unittest
from collections import Counter, defaultdict
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT / "python"))
from build_l0_fixtures import populate  # noqa: E402
from l0_benchmark_core import populate_core  # noqa: E402
from l0_benchmark_support import create_and_populate  # noqa: E402


def make_core(expanded: bool = False) -> sqlite3.Connection:
    """每例使用内存库；旧夹具若干域为空，专门检验不能靠改写核心来填满支撑表。"""
    connection = sqlite3.connect(":memory:")
    connection.executescript((APP_ROOT / "fixtures/l0/mock_schema.sql").read_text(encoding="utf-8"))
    if expanded:
        populate_core(connection, patients_per_institution=32)
    else:
        populate(connection)
    return connection


def facts(connection: sqlite3.Connection, tables: list[str]) -> dict:
    return {table: [tuple(row) for row in connection.execute(f'SELECT * FROM "{table}" ORDER BY 1,2')]
            for table in tables}


class SupportFixtureTests(unittest.TestCase):
    def setUp(self):
        self.connection = make_core()
        self.addCleanup(self.connection.close)
        self.core_tables = [row[0] for row in self.connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        self.before = facts(self.connection, self.core_tables)
        self.metadata = create_and_populate(self.connection)

    def rows(self, sql: str):
        return self.connection.execute(sql).fetchall()

    def test_exact_physical_tables_nonempty_and_metadata_complete(self):
        """106 张实表、80 个不同业务粒度和每列中文语义共同防止空表/复制表凑数。"""
        self.assertEqual(len(self.metadata), 80)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM sqlite_master WHERE type='table'"), [(106,)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM sqlite_master WHERE type='view'"), [(0,)])
        self.assertEqual(sorted(Counter(item["domain"] for item in self.metadata.values()).values()), [8] * 10)
        metrics = {item["metric_id"] for item in json.loads((APP_ROOT / "fixtures/l0/metrics.json").read_text())["metrics"]}
        linked = set()
        descriptions = set()
        for table, item in self.metadata.items():
            with self.subTest(table=table):
                self.assertGreater(self.rows(f'SELECT COUNT(*) FROM "{table}"')[0][0], 0)
                columns = {row[1] for row in self.rows(f'PRAGMA table_info("{table}")')}
                self.assertEqual(columns, set(item["columns"]))
                self.assertTrue(all(item["columns"].values()))
                self.assertIn(item["role"], ("support", "distractor"))
                self.assertTrue(item["related_metric_ids"])
                self.assertTrue(set(item["related_metric_ids"]) <= metrics)
                self.assertTrue(item["grain"])
                self.assertIn("合成", item["description"])
                linked.update(item["related_metric_ids"])
                descriptions.add(item["description"])
        self.assertEqual(len(descriptions), 80)
        self.assertEqual(linked, metrics)

    def test_core_is_unchanged_including_empty_domains(self):
        self.assertEqual(facts(self.connection, self.core_tables), self.before)
        for table in ("medication_administrations", "financial_entries", "icu_episodes", "emergency_rescue_episodes"):
            self.assertEqual(self.rows(f'SELECT COUNT(*) FROM "{table}"'), [(0,)])
        self.assertEqual(self.rows("SELECT DISTINCT voucher_status FROM financial_vouchers"), [("DRAFT",)])
        self.assertEqual(self.rows("SELECT DISTINCT request_status FROM icu_transfer_requests"), [("REVIEW_PENDING",)])

    def test_real_foreign_keys_and_institution_isolation(self):
        self.assertEqual(self.rows("PRAGMA integrity_check"), [("ok",)])
        self.assertEqual(self.rows("PRAGMA foreign_key_check"), [])
        for table in self.metadata:
            groups = defaultdict(list)
            for row in self.rows(f'PRAGMA foreign_key_list("{table}")'):
                groups[row[0]].append(row)
            self.assertTrue(groups, table)
            for group in groups.values():
                self.assertIn(("institution_id", "institution_id"), [(row[3], row[4]) for row in group])
                if group[0][2] != "institutions":
                    self.assertGreaterEqual(len(group), 2)
        # H999 没有 P002；仅局部编号可匹配的错误跨院引用必须被真正数据库约束拒绝。
        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute("INSERT INTO patient_local_identifiers VALUES ('H999','WRONG','P002','HIS','SYN_WRONG')")
        self.assertEqual(self.rows("SELECT COUNT(*) FROM patient_local_identifiers WHERE identifier_id='WRONG'"), [(0,)])

    def test_clinical_time_order_and_no_postmortem_followup(self):
        checks = [
            "SELECT COUNT(*) FROM medication_orders o JOIN inpatient_stays s USING(institution_id,stay_id) WHERE o.ordered_at<s.admitted_at OR (s.discharged_at IS NOT NULL AND o.ordered_at>s.discharged_at)",
            "SELECT COUNT(*) FROM fall_risk_assessments a JOIN inpatient_stays s USING(institution_id,stay_id) WHERE a.assessed_at<s.admitted_at OR (s.discharged_at IS NOT NULL AND a.assessed_at>s.discharged_at)",
            "SELECT COUNT(*) FROM discharge_orders o JOIN inpatient_stays s USING(institution_id,stay_id) WHERE o.ordered_at<s.admitted_at OR o.ordered_at>s.discharged_at OR o.actual_departed_at IS NOT s.discharged_at",
            "SELECT COUNT(*) FROM laboratory_specimens s JOIN infection_specimen_orders o USING(institution_id,specimen_order_id) JOIN microbiology_results r USING(institution_id,specimen_id) WHERE s.collected_at<o.ordered_at OR s.received_at<s.collected_at OR r.reported_at<s.received_at",
            "SELECT COUNT(*) FROM anesthesia_evaluations a JOIN inpatient_procedures p USING(institution_id,procedure_id) JOIN inpatient_stays s USING(institution_id,stay_id) WHERE a.evaluated_at<s.admitted_at OR a.evaluated_at>p.performed_at",
            "SELECT COUNT(*) FROM outpatient_consultations c JOIN appointment_events a USING(institution_id,visit_id) WHERE a.appointment_kind_code='REGISTRATION' AND a.appointment_status_code='SUCCESS' AND c.started_at<a.called_at",
            "SELECT COUNT(*) FROM discharge_followup_tasks f JOIN inpatient_stays s USING(institution_id,stay_id) WHERE s.discharge_disposition_code='DEATH' AND (f.scheduled_at IS NOT NULL OR f.task_status!='NOT_APPLICABLE_DEATH')",
        ]
        for sql in checks:
            self.assertEqual(self.rows(sql), [(0,)], sql)
        self.assertGreater(self.rows("SELECT COUNT(*) FROM discharge_followup_tasks WHERE task_status='NOT_APPLICABLE_DEATH'")[0][0], 0)

    def test_stock_quantity_unit_and_process_balance(self):
        """医嘱—发药—退库量不越界，库存移动同单位且每一步余额非负。"""
        self.assertEqual(self.rows("""SELECT COUNT(*) FROM pharmacy_dispense_records d
            JOIN medication_order_lines l USING(institution_id,medication_order_line_id)
            JOIN medication_returns r USING(institution_id,dispense_id)
            JOIN drug_batches b USING(institution_id,batch_id)
            JOIN drug_products p ON p.institution_id=b.institution_id AND p.product_id=b.product_id
            WHERE d.quantity>l.ordered_quantity OR r.quantity>d.quantity OR d.quantity_unit!=l.quantity_unit
               OR r.quantity_unit!=d.quantity_unit OR p.dose_unit!=d.quantity_unit
               OR l.product_id!=b.product_id OR r.returned_at<d.dispensed_at
               OR DATE(d.dispensed_at)<b.received_on OR DATE(d.dispensed_at)>b.expires_on"""), [(0,)])
        self.assertEqual(self.rows("""SELECT COUNT(*) FROM (
            SELECT SUM(quantity_delta) OVER (PARTITION BY institution_id,batch_id
            ORDER BY moved_at, CASE movement_kind WHEN 'RECEIPT' THEN 0 WHEN 'DISPENSE' THEN 1 ELSE 2 END,inventory_movement_id) balance
            FROM pharmacy_inventory_movements) WHERE balance<0"""), [(0,)])
        self.assertEqual(self.rows("""SELECT COUNT(*) FROM pharmacy_dispense_records d WHERE
            d.quantity != -COALESCE((SELECT SUM(m.quantity_delta) FROM pharmacy_inventory_movements m
            WHERE m.institution_id=d.institution_id AND m.dispense_id=d.dispense_id AND m.movement_kind='DISPENSE'),0)"""), [(0,)])

    def test_occupancy_departments_and_resource_capacity(self):
        """占床日已有的科室是约束，支撑转科不能在它之前提前切换到出院科室。"""
        self.assertEqual(self.rows("""SELECT COUNT(*) FROM inpatient_census_days c
            JOIN inpatient_stays s USING(institution_id,stay_id)
            WHERE c.department_id IS NOT NULL AND c.department_id IS NOT (
              SELECT t.to_department_id FROM inpatient_transfer_events t
              WHERE t.institution_id=c.institution_id AND t.stay_id=c.stay_id
                AND t.transferred_at<=MAX(s.admitted_at,c.census_date||' 00:00:00')
              ORDER BY t.transferred_at DESC,t.transfer_event_id DESC LIMIT 1)"""), [(0,)])
        self.assertEqual(self.rows("""SELECT COUNT(*) FROM bed_capacity_days c WHERE c.open_beds_count>(
            SELECT COUNT(*) FROM location_beds b JOIN hospital_wards w USING(institution_id,ward_id)
            WHERE w.institution_id=c.institution_id AND w.department_id=c.department_id)"""), [(0,)])
        self.assertEqual(self.rows("""SELECT COUNT(*) FROM (SELECT institution_id,operating_room_id,scheduled_at
            FROM surgery_schedule_versions WHERE version_status='FINAL'
            GROUP BY 1,2,3 HAVING COUNT(*)>1)"""), [(0,)])

    def test_plans_do_not_fabricate_execution_or_scores(self):
        self.assertEqual(self.rows("SELECT COUNT(*) FROM insurance_claims WHERE claim_status!='DRAFT' OR submitted_at IS NOT NULL OR requested_fund_amount_yuan IS NOT NULL"), [(0,)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM quality_committee_meetings WHERE minutes_status='PLANNED' AND held_on IS NOT NULL"), [(0,)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM inpatient_bed_assignments WHERE bed_id IS NOT NULL"), [(0,)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM financial_voucher_lines WHERE line_status='PENDING_INPUT' AND (entry_id IS NOT NULL OR amount_yuan IS NOT NULL)"), [(0,)])
        for item in self.metadata.values():
            self.assertFalse({"metric_value", "gold", "expected_rows", "final_score", "metric_answer"} & set(item["columns"]))

    def test_seed_reproducibility_and_variation(self):
        connection = make_core()
        self.addCleanup(connection.close)
        create_and_populate(connection)
        self.assertEqual(facts(connection, list(self.metadata)), facts(self.connection, list(self.metadata)))
        changed = make_core()
        self.addCleanup(changed.close)
        create_and_populate(changed, seed=27)
        self.assertNotEqual(facts(changed, ["anesthesia_observations", "energy_meter_readings"]), facts(connection, ["anesthesia_observations", "energy_meter_readings"]))

    def test_duplicate_creation_refuses_overwrite(self):
        before = facts(self.connection, list(self.metadata))
        with self.assertRaises(sqlite3.OperationalError):
            create_and_populate(self.connection)
        self.assertEqual(before, facts(self.connection, list(self.metadata)))

    def test_caller_transaction_and_row_factory_are_preserved(self):
        connection = make_core()
        self.addCleanup(connection.close)
        connection.commit()
        connection.row_factory = sqlite3.Row
        connection.execute("BEGIN")
        create_and_populate(connection)
        self.assertIs(connection.row_factory, sqlite3.Row)
        self.assertTrue(connection.in_transaction)
        connection.rollback()
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0], 26)

    def test_three_institution_bulk_core_and_duplicate_local_ids(self):
        """新核心提供三机构和跨年业务，支撑层不能依赖 P001/S001 等固定演示编号。"""
        connection = make_core(expanded=True)
        self.addCleanup(connection.close)
        before = facts(connection, self.core_tables)
        metadata = create_and_populate(connection)
        self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(before, facts(connection, self.core_tables))
        for table in metadata:
            institutions = {row[0] for row in connection.execute(f'SELECT DISTINCT institution_id FROM "{table}"')}
            self.assertEqual(institutions, {"H001", "H002", "H999"}, table)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM medication_orders WHERE medication_order_id='MO_BS202500001'").fetchone()[0], 3)
        self.assertEqual(connection.execute("SELECT COUNT(DISTINCT SUBSTR(ordered_at,1,4)) FROM medication_orders").fetchone()[0], 2)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM discharge_followup_tasks f JOIN inpatient_stays s USING(institution_id,stay_id) WHERE s.discharge_disposition_code='DEATH' AND f.scheduled_at IS NOT NULL").fetchone()[0], 0)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM financial_voucher_lines l JOIN financial_entries e USING(institution_id,entry_id) WHERE l.amount_yuan!=e.amount_yuan OR l.account_code!=e.account_code").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
