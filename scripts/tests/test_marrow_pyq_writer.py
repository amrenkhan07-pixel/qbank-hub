import hashlib
import json
import sqlite3
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

from scripts.marrow_pyq_writer import (BATCH_ID, apply_local, apply_production, backup_manifest,
                                      independent_pyq_plan, load_artifact, open_local, production_dry_run,
                                      production_payloads, rollback_local, rollback_production, table_counts)

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

    def test_independent_pyq_production_mapping(self):
        plan = independent_pyq_plan(self.doc)
        self.assertEqual(plan["mode"], "independent_marrow_pyq_no_prep_or_canonical_merge")
        self.assertEqual(plan["subjects"], 19)
        self.assertEqual(plan["review_occurrences_kept_separate"], 314)
        self.assertEqual(plan["review_versions_kept_separate"], 311)
        self.assertEqual(plan["table_deltas"]["questions"], 5914)
        self.assertEqual(plan["table_deltas"]["qbank_source_occurrences"], 5938)
        self.assertEqual(plan["table_deltas"]["canonical_question_versions"], 0)

    def test_production_manifests_and_payloads(self):
        manifests, objects = production_payloads(self.doc)
        self.assertEqual(len(manifests), 19)
        self.assertEqual(len(objects), 342)
        self.assertEqual(sum(row["source_test_count"] for row in manifests.values()), 342)
        self.assertEqual(sum(row["content_version_count"] for row in manifests.values()), 5914)
        self.assertEqual(sum(row["occurrence_count"] for row in manifests.values()), 5938)
        self.assertEqual(sum(len(manifest["versions"]) for manifest in manifests.values()), 5914)
        reviews = [version for manifest in manifests.values() for version in manifest["versions"] if version["review_reason"]]
        self.assertEqual(len(reviews), 311)
        self.assertTrue(all(manifest["batch_id"] == BATCH_ID for manifest in manifests.values()))

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
            if table == "qbank_question_payloads": return ([], 22844)
            return ([], 1150)
        def fake_rpc(url, key, name, payload):
            self.assertEqual(name, "qbank_commit_marrow_pyq_import")
            self.assertTrue(payload["p_dry_run"])
            return {"status": "dry_run"}
        with patch("scripts.marrow_pyq_writer.api_get", side_effect=fake_get), patch("scripts.marrow_pyq_writer.rpc", side_effect=fake_rpc) as rpc_mock:
            result = production_dry_run(self.doc, "https://flulljensjugfcxmeczu.supabase.co", "secret")
        self.assertEqual(result["writes"], 0)
        self.assertTrue(result["production_apply_ready"])
        self.assertEqual(result["expected_new_occurrences"], 5938)
        self.assertEqual(result["rpc_subject_batches_validated"], 19)
        self.assertEqual(rpc_mock.call_count, 19)
        self.assertEqual(len(calls), 13)

    def test_production_project_guard_precedes_network(self):
        with patch("scripts.marrow_pyq_writer.api_get") as get:
            with self.assertRaisesRegex(ValueError, "wrong production"):
                production_dry_run(self.doc, "https://different.supabase.co", "secret")
            get.assert_not_called()

    def test_production_apply_and_rollback_require_exact_batch(self):
        with patch("scripts.marrow_pyq_writer.production_dry_run") as dry:
            with self.assertRaisesRegex(ValueError, "exact production batch"):
                apply_production(self.doc, "https://flulljensjugfcxmeczu.supabase.co", "secret", "wrong", Path(self.tmp.name))
            dry.assert_not_called()
        with patch("scripts.marrow_pyq_writer.rpc") as rpc_mock:
            with self.assertRaisesRegex(ValueError, "exact production batch"):
                rollback_production("https://flulljensjugfcxmeczu.supabase.co", "secret", "wrong")
            rpc_mock.assert_not_called()
        with patch("scripts.marrow_pyq_writer.rpc") as rpc_mock:
            with self.assertRaisesRegex(ValueError, "wrong production"):
                rollback_production("https://different.supabase.co", "secret", BATCH_ID)
            rpc_mock.assert_not_called()

    def test_migration_owns_rows_and_preserves_learner_data(self):
        root = ARTIFACT.parents[1]
        sql = (root / "supabase/migrations/20260921000100_marrow_pyq_independent_import.sql").read_text()
        self.assertIn("qbank_import_batch_records", sql)
        self.assertIn("qbank_rollback_marrow_pyq_batch", sql)
        self.assertNotIn("insert into public.question_attempts", sql.lower())
        self.assertNotIn("insert into public.user_question_state", sql.lower())
        app = (root / "app/app.js").read_text()
        self.assertIn("qbank_pyq_catalog", app)
        self.assertIn("source_tests: [target.dataset.test]", app)


if __name__ == "__main__":
    unittest.main()
