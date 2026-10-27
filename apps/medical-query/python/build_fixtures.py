"""离线生成两个异构 SQLite 合成源；题目与答案留在独立评测文件中。"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = APP_ROOT / "fixtures"

A_SCHEMA = """
CREATE TABLE patients(patient_id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, sex TEXT NOT NULL);
CREATE TABLE encounters(encounter_id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(patient_id), department TEXT NOT NULL, admitted_at TEXT NOT NULL, discharged_at TEXT, status TEXT NOT NULL, cost REAL NOT NULL);
CREATE TABLE diagnoses(diagnosis_id TEXT PRIMARY KEY, encounter_id TEXT NOT NULL REFERENCES encounters(encounter_id), code TEXT NOT NULL, status TEXT NOT NULL);
"""
B_SCHEMA = """
CREATE TABLE persons(person_key INTEGER PRIMARY KEY, display_name TEXT NOT NULL, age_years INTEGER NOT NULL, gender_code INTEGER NOT NULL);
CREATE TABLE admission_episodes(episode_key INTEGER PRIMARY KEY, person_ref INTEGER NOT NULL REFERENCES persons(person_key), unit_name TEXT NOT NULL, entered_at TEXT NOT NULL, leave_time TEXT, state_code INTEGER NOT NULL, charge_amount REAL NOT NULL);
CREATE TABLE episode_diagnoses(item_key INTEGER PRIMARY KEY, episode_ref INTEGER NOT NULL REFERENCES admission_episodes(episode_key), disease_code TEXT NOT NULL, certainty_code INTEGER NOT NULL);
"""


def build(output_dir: Path) -> list[dict]:
    """拒绝覆盖已有数据库或注册表，避免生成过程破坏正在引用的固定快照。"""
    output_dir = output_dir.resolve()
    targets = [output_dir / "sources.json"]
    targets += [output_dir / f"{name}{suffix}" for name in ("hospital-a", "hospital-b") for suffix in (".sqlite", ".semantic.json")]
    if any(path.exists() for path in targets):
        raise FileExistsError("目标快照已存在；请指定新的 --output-dir，不覆盖既有数据")
    output_dir.mkdir(parents=True, exist_ok=True)
    sources = []
    for source_id, name, schema in (("hospital-a", "模拟医院 A", A_SCHEMA), ("hospital-b", "模拟医院 B", B_SCHEMA)):
        path = output_dir / f"{source_id}.sqlite"
        dictionary_path = output_dir / f"{source_id}.semantic.json"
        connection = sqlite3.connect(path)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.executescript(schema)
            if source_id == "hospital-a":
                connection.executemany("INSERT INTO patients VALUES (?,?,?,?)", [
                    ("P001", "林甲", 67, "F"), ("P002", "陈乙", 45, "M"),
                    ("P003", "周丙", 72, "F"), ("P004", "王丁", 30, "M"), ("P005", "赵戊", 80, "M"),
                ])
                # 重复住院、取消事件和月外记录使错误粒度/状态/时间条件得到不同结果。
                connection.executemany("INSERT INTO encounters VALUES (?,?,?,?,?,?,?)", [
                    ("E001", "P001", "内科", "2026-08-28 10:00:00", "2026-09-02 12:00:00", "D", 100),
                    ("E002", "P001", "内科", "2026-09-08 09:00:00", "2026-09-10 12:00:00", "D", 200),
                    ("E003", "P002", "内科", "2026-10-01 09:00:00", None, "A", 400),
                    ("E004", "P003", "外科", "2026-09-15 09:00:00", "2026-09-20 12:00:00", "D", 300),
                    ("E005", "P004", "内科", "2026-09-23 09:00:00", "2026-09-25 12:00:00", "C", 999),
                    ("E006", "P005", "内科", "2026-08-20 09:00:00", "2026-08-31 23:59:59", "D", 500),
                ])
                connection.executemany("INSERT INTO diagnoses VALUES (?,?,?,?)", [
                    ("D001", "E001", "E11", "confirmed"), ("D002", "E001", "I10", "confirmed"),
                    ("D003", "E002", "E11", "confirmed"), ("D004", "E004", "E11", "confirmed"),
                    ("D005", "E003", "E11", "suspected"),
                ])
            else:
                connection.executemany("INSERT INTO persons VALUES (?,?,?,?)", [
                    (11, "许一", 68, 2), (12, "吴二", 45, 1), (13, "郑三", 60, 2),
                    (14, "冯四", 30, 1), (15, "褚五", 81, 1),
                ])
                connection.executemany("INSERT INTO admission_episodes VALUES (?,?,?,?,?,?,?)", [
                    (101, 11, "内科", "2026-08-29 10:00:00", "2026-09-03 12:00:00", 3, 150),
                    (102, 11, "内科", "2026-09-09 09:00:00", "2026-09-12 12:00:00", 3, 250),
                    (103, 12, "内科", "2026-09-17 09:00:00", None, 1, 400),
                    (104, 13, "外科", "2026-09-15 09:00:00", "2026-10-02 12:00:00", 3, 350),
                    (105, 14, "内科", "2026-09-23 09:00:00", "2026-09-25 12:00:00", 9, 999),
                    (106, 15, "内科", "2026-08-20 09:00:00", "2026-08-31 23:59:59", 3, 550),
                ])
                connection.executemany("INSERT INTO episode_diagnoses VALUES (?,?,?,?)", [
                    (201, 101, "DM2", 1), (202, 101, "HTN", 1), (203, 102, "DM2", 1),
                    (204, 104, "HTN", 1), (205, 103, "DM2", 0),
                ])
            connection.commit()
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or connection.execute("PRAGMA foreign_key_check").fetchall():
                raise RuntimeError(f"{source_id} 完整性校验失败")
        finally:
            connection.close()
        shutil.copyfile(FIXTURES / f"{source_id}.semantic.json", dictionary_path)
        sources.append({"id": source_id, "name": name, "path": str(path), "dictionary_path": str(dictionary_path)})
    (output_dir / "sources.json").write_text(json.dumps(sources, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return sources


def main() -> None:
    parser = argparse.ArgumentParser(description="创建只读问数使用的固定合成快照，不覆盖已有文件")
    parser.add_argument("--output-dir", type=Path, default=APP_ROOT / ".local")
    args = parser.parse_args()
    sources = build(args.output_dir)
    print(json.dumps({"sources": sources, "note": "仅创建固定合成数据；未运行真实模型评测"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
