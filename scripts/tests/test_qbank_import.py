import json
import tempfile
import unittest
from pathlib import Path

from scripts.qbank_import import (
    DEFAULT_PROFILE,
    aggregate_report,
    classify_questions,
    content_fingerprint,
    normalized_text,
    parse_html,
    source_identity,
    seeded_filter_validation,
    write_report,
)


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "scripts" / "fixtures" / "qbank-import-sample.html"


class QBankImporterTests(unittest.TestCase):
    def setUp(self):
        self.metadata = {"platform": "Cerebellum", "subject": "Anesthesia", "system": "", "topic": "", "subtopic": "", "source_collection": "Fixture", "source_reference": ""}
        self.parsed = parse_html(FIXTURE, self.metadata, DEFAULT_PROFILE)
        self.snapshot = {
            "platforms": [{"id": "p1", "name": "Cerebellum", "code": "CEREB"}],
            "subjects": [{"id": "s1", "name": "Anesthesia"}],
            "questions": [], "question_options": [],
            "baseline": {"questions": 418, "options": 1672, "attempts": 131, "bookmarks": 16, "marked_for_review": 9, "sessions": 28},
        }
        exact = self.parsed[1]
        possible = self.parsed[2]
        conflict = self.parsed[4]
        exact_identity, exact_source_fp = source_identity(exact)
        del exact_identity
        self.snapshot["questions"] = [
            {"id": "existing-1", "platform_id": "p1", "subject_id": "s1", "source_question_id": exact["source_id"], "source_reference": None, "source_collection": "Fixture", "question_text": exact["stem_html"], "correct_answer": exact["correct_answer"], "source_fingerprint": exact_source_fp, "content_fingerprint": content_fingerprint(exact)},
            {"id": "existing-2", "platform_id": "p1", "subject_id": "s1", "source_question_id": "original-monitor-id", "source_reference": None, "source_collection": "Fixture", "question_text": possible["stem_html"], "correct_answer": possible["correct_answer"], "content_fingerprint": content_fingerprint(possible)},
            {"id": "existing-3", "platform_id": "p1", "subject_id": "s1", "source_question_id": conflict["source_id"], "source_reference": None, "source_collection": "Fixture", "question_text": "Original conflicting stem", "correct_answer": "B", "content_fingerprint": "different-content"},
        ]
        for question_id, source in (("existing-1", exact), ("existing-2", possible), ("existing-3", conflict)):
            self.snapshot["question_options"].extend({"id": f"{question_id}-{option['key']}", "question_id": question_id, "option_key": option["key"], "option_text": option["text"]} for option in source["options"])

    def test_parser_extracts_content_and_taxonomy(self):
        self.assertEqual(len(self.parsed), 6)
        first = self.parsed[0]
        self.assertEqual(first["correct_answer"], "B")
        self.assertEqual(len(first["options"]), 4)
        self.assertEqual(first["taxonomy"]["topic"], "Airway")
        self.assertEqual(first["taxonomy"]["subtopic"], "Intubation")
        self.assertIn("capnography", normalized_text(first["explanation_html"]))

    def test_classifies_all_safety_categories(self):
        rows = classify_questions(self.parsed, self.snapshot)
        self.assertEqual([row["classification"] for row in rows], [
            "NEW", "EXACT EXISTING MATCH", "POSSIBLE DUPLICATE", "INVALID", "CONFLICT", "NEW"
        ])

    def test_rerun_is_idempotent(self):
        rows = classify_questions(self.parsed, self.snapshot)
        inserted = [row for row in rows if row["classification"] == "NEW"]
        rerun_snapshot = json.loads(json.dumps(self.snapshot))
        for index, row in enumerate(inserted):
            question_id = f"new-{index}"
            rerun_snapshot["questions"].append({
                "id": question_id, "platform_id": "p1", "subject_id": "s1", "source_question_id": row.get("source_id"),
                "source_reference": row.get("source_reference"), "source_collection": row.get("source_collection"),
                "question_text": row["stem_html"], "correct_answer": row["correct_answer"],
                "source_fingerprint": row["source_fingerprint"], "content_fingerprint": row["content_fingerprint"],
            })
            rerun_snapshot["question_options"].extend({"id": f"{question_id}-{option['key']}", "question_id": question_id, "option_key": option["key"], "option_text": option["text"]} for option in row["options"])
        rerun = classify_questions(self.parsed, rerun_snapshot)
        self.assertFalse(any(row["classification"] == "NEW" for row in rerun))

    def test_fallback_identity_is_deterministic(self):
        fallback = self.parsed[-1]
        identity_a, fingerprint_a = source_identity(fallback)
        identity_b, fingerprint_b = source_identity(json.loads(json.dumps(fallback)))
        self.assertTrue(identity_a.startswith("content-fallback|"))
        self.assertEqual((identity_a, fingerprint_a), (identity_b, fingerprint_b))

    def test_dry_run_report_is_machine_readable_and_non_mutating(self):
        classified = classify_questions(self.parsed, self.snapshot)
        report = aggregate_report(FIXTURE, "fixture-hash", classified, self.snapshot, "dry-run", 20260828)
        self.assertFalse(report["database_modified"])
        self.assertEqual(report["question_count_before"], 418)
        self.assertEqual(report["question_count_after_projected"], 420)
        self.assertEqual(report["option_count_after_projected"], 1680)
        with tempfile.TemporaryDirectory() as directory:
            path = write_report(report, Path(directory))
            self.assertEqual(json.loads(path.read_text())["source_sha256"], "fixture-hash")

    def test_invalid_subtopic_without_topic_is_quarantined(self):
        row = json.loads(json.dumps(self.parsed[0]))
        row["taxonomy"]["topic"] = ""
        classified = classify_questions([row], self.snapshot)[0]
        self.assertEqual(classified["classification"], "INVALID")
        self.assertIn("without a topic", classified["reason"])

    def test_duplicate_option_records_are_quarantined(self):
        row = json.loads(json.dumps(self.parsed[0]))
        row["options"].append(json.loads(json.dumps(row["options"][0])))
        classified = classify_questions([row], self.snapshot)[0]
        self.assertEqual(classified["classification"], "INVALID")
        self.assertIn("duplicate option keys", classified["reason"])

    def test_large_batch_fingerprints_are_unique_and_deterministic(self):
        fingerprints = set()
        base = self.parsed[0]
        for index in range(10000):
            row = json.loads(json.dumps(base))
            row["source_id"] = f"scale-{index}"
            identity, fingerprint = source_identity(row)
            self.assertTrue(identity.endswith(f"scale-{index}"))
            fingerprints.add(fingerprint)
        self.assertEqual(len(fingerprints), 10000)

    def test_seeded_filter_sampling_is_reproducible(self):
        snapshot = json.loads(json.dumps(self.snapshot))
        snapshot["question_topics"] = []
        snapshot["question_subtopics"] = []
        snapshot["user_question_state"] = [{"user_id": "u1", "question_id": "existing-1", "bookmarked": True, "marked_for_review": False, "wrong": False, "last_is_correct": True, "recall_due_at": None}]
        snapshot["question_attempts"] = [{"id": "a1", "user_id": "u1", "question_id": "existing-1"}]
        first = seeded_filter_validation(snapshot, 20260828, 128)
        second = seeded_filter_validation(snapshot, 20260828, 128)
        self.assertEqual(first, second)
        self.assertEqual(first["status"], "PASS")


if __name__ == "__main__":
    unittest.main()
