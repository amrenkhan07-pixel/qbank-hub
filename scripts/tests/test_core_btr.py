import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.core_btr_stage import collection_type, corrected_section
from scripts.core_btr_writer import BATCH_ID, load_artifact, manifests, preflight


ARTIFACT = Path("import-reports/core-btr-stage-v1.json.gz")


class CoreBtrTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load_artifact(ARTIFACT)

    def test_cvs_is_promoted(self):
        self.assertEqual(corrected_section(["Neurology", "Cardiovascular_System"]),
                         ("Cardiovascular_System", ["Cardiovascular System"]))

    def test_collection_types(self):
        self.assertEqual(collection_type("PYQs"), "CORE_BTR_PYQ")
        self.assertEqual(collection_type("ZVRecommended Qs"), "ZV_RECOMMENDED")
        self.assertEqual(collection_type("All Qbank Qs Excluding Pyqs"), "ALL_QBANK_EXCLUDING_PYQ")
        self.assertEqual(collection_type("Arrhythmias ECG"), "TOPIC_TEST")

    def test_content_and_occurrence_counts(self):
        self.assertEqual(len(self.doc["content_versions"]), 14066)
        self.assertEqual(len(self.doc["occurrences"]), 19137)
        self.assertEqual(self.doc["summary"]["duplicate_content_extra_occurrences"], 5071)

    def test_hit_list_is_explainable(self):
        hit = [x for x in self.doc["content_versions"] if x["is_hit_list"]]
        self.assertEqual(len(hit), 688)
        self.assertTrue(all(x["is_core_btr_pyq"] and x["is_zv_recommended"] for x in hit))

    def test_shared_question_identity_across_memberships(self):
        repeated = next(x for x in self.doc["content_versions"] if x["membership_count"] == 3)
        occurrences = [x for x in self.doc["occurrences"] if x["question_id"] == repeated["question_id"]]
        self.assertEqual(len(occurrences), 3)
        self.assertEqual(len({x["question_id"] for x in occurrences}), 1)
        self.assertGreater(len({x["source_test_uuid"] for x in occurrences}), 1)

    def test_subject_batched_manifests(self):
        rows = manifests(self.doc)
        self.assertEqual(len(rows), 19)
        self.assertEqual(sum(x["source_test_count"] for x in rows.values()), 284)
        self.assertEqual(sum(x["content_version_count"] for x in rows.values()), 14066)
        self.assertEqual(sum(x["occurrence_count"] for x in rows.values()), 19137)
        self.assertEqual(sum(x["payload_object_count"] for x in rows.values()), 67)

    def test_production_preflight_is_read_only(self):
        subject_names = sorted({x["analytics_subject"] for x in self.doc["source_tests"]})
        counts = {"questions": 29176, "qbank_source_tests": 1471,
                  "qbank_source_occurrences": 29056, "question_attempts": 220,
                  "user_question_state": 166, "bookmarks": 37, "test_sessions": 74}
        def fake_get(url, key, table, query):
            if table == "platforms": return ([], 0)
            if table == "subjects": return ([{"id": str(i), "name": name} for i, name in enumerate(subject_names)], len(subject_names))
            return ([], counts.get(table, 0))
        def fake_all(url, key, table, query):
            if table == "subjects": return [{"id": str(i), "name": name} for i, name in enumerate(subject_names)]
            return []
        with patch("scripts.core_btr_writer.api_get", side_effect=fake_get), \
             patch("scripts.core_btr_writer.api_all", side_effect=fake_all):
            result = preflight(self.doc, "https://flulljensjugfcxmeczu.supabase.co", "secret")
        self.assertEqual(result["writes"], 0)
        self.assertEqual(result["batch_id"], BATCH_ID)
        self.assertEqual(result["projected_deltas"]["questions"], 14066)


if __name__ == "__main__":
    unittest.main()
