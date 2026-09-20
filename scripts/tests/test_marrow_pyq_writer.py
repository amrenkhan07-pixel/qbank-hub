import hashlib
import json
import sqlite3
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

from scripts.marrow_pyq_writer import (BATCH_ID, apply_local, backup_manifest, load_artifact,
                                      open_local, production_dry_run, rollback_local, table_counts)

ARTIFACT = Path(__file__).resolve().parents[2] / "import-reports/marrow-pyq-stage-v1.json.gz"


def db_digest(conn):
    h = hashlib.sha256()
    for table in ("identities", "identity_links", "source_tests", "payload_objects", "marrow_versions",
                  "source_occurrences", "identity_review", "import_checkpoint", "learner_sentinel"):
        for row in conn.execute("select * from " + table + " order by 1"):
            h.update(repr(row).encode())
    return h.hexdigest()


class MarrowPyqWriterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load_artifact(ARTIFACT)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "isolated.sqlite"
        self.conn = open_local(self.path, self.doc)
        self.addCleanup(self.conn.close)

    def test_artifact_guard(self):
        bad = Path(self.tmp.name) / "bad.gz"
        bad.write_bytes(ARTIFACT.read_bytes() + b"x")
        with self.assertRaisesRegex(ValueError, "checksum"):
            load_artifact(bad)

    def test_full_import_rerun_rollback_reimport(self):
        baseline = backup_manifest(self.conn, self.path, self.doc)
        first = apply_local(self.conn, self.doc)
        self.assertEqual(first["completed_subject_batches"], 19)
        self.assertEqual(first["counts"]["marrow_versions"], 5914)
        self.assertEqual(first["counts"]["source_occurrences"], 5938)
        self.assertEqual(first["counts"]["source_tests"], 342)
        self.assertEqual(first["counts"]["identity_review"], 311)
        self.assertEqual(first["counts"]["learner_sentinel"], 1)
        exams = dict(self.conn.execute("select exam,count(*) from source_occurrences group by exam"))
        self.assertEqual(exams, {"AIIMS": 1470, "INI-CET": 2393, "NEET-PG": 2075})
        self.assertEqual(self.conn.execute("select count(*) from source_occurrences where session is not null").fetchone()[0], 0)
        repeats = self.conn.execute("select count(*) from (select source_question_id from source_occurrences group by source_question_id having count(*)>1)").fetchone()[0]
        self.assertEqual(repeats, 56)
        self.assertEqual(apply_local(self.conn, self.doc)["skipped_subject_batches"], 19)
        self.assertEqual(rollback_local(self.conn, baseline)["counts"], baseline["before_counts"])
        self.assertEqual(apply_local(self.conn, self.doc)["counts"], first["counts"])

    def test_interruption_resume_equals_clean(self):
        backup_manifest(self.conn, self.path, self.doc)
        with self.assertRaises(InterruptedError):
            apply_local(self.conn, self.doc, fail_after_subjects=7)
        self.assertEqual(table_counts(self.conn)["import_checkpoint"], 7)
        resumed = apply_local(self.conn, self.doc)
        self.assertEqual((resumed["completed_subject_batches"], resumed["skipped_subject_batches"]), (12, 7))
        other = open_local(Path(self.tmp.name) / "clean.sqlite", self.doc)
        self.addCleanup(other.close)
        apply_local(other, self.doc)
        self.assertEqual(db_digest(self.conn), db_digest(other))

    def test_rollback_refuses_shared_identity(self):
        baseline = backup_manifest(self.conn, self.path, self.doc)
        apply_local(self.conn, self.doc)
        identity = self.conn.execute("select id from identities where origin_batch=? limit 1", (BATCH_ID,)).fetchone()[0]
        self.conn.execute("insert into identity_links values(?,?,?,null)", ("external-question", identity, "External"))
        before = table_counts(self.conn)
        with self.assertRaisesRegex(ValueError, "shared identity"):
            rollback_local(self.conn, baseline)
        self.assertEqual(table_counts(self.conn), before)

    def test_production_preflight_is_get_only(self):
        calls = []
        def fake_get(url, key, table, query):
            calls.append((table, query))
            if table == "platforms": return ([{"id": "marrow-id", "name": "Marrow"}], 1)
            if table == "qbank_source_tests": return ([], 0)
            if table == "qbank_question_payloads" and "platform_id" in query: return ([], 0)
            if table == "qbank_question_payloads" and "question_id=in." in query:
                ids = query.split("question_id=in.(", 1)[1].split(")", 1)[0].split(",")
                return ([{"question_id": item} for item in ids], len(ids))
            if table == "qbank_question_payloads": return ([], 22844)
            return ([], 1150)
        with patch("scripts.marrow_pyq_writer.api_get", side_effect=fake_get):
            result = production_dry_run(self.doc, "https://example.test", "secret")
        self.assertEqual(result["writes"], 0)
        self.assertFalse(result["production_apply_ready"])
        self.assertEqual(result["expected_new_occurrences"], 5938)
        self.assertEqual(result["matched_prepladder_ids_verified"], 384)
        self.assertEqual(len(calls), 20)


if __name__ == "__main__":
    unittest.main()
