import base64
import gzip
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from scripts.prepladder_import import (
    build_plan,
    canonical_payload,
    correct_keys,
    deterministic_uuid,
    extract_folder_tree,
    credential_kind,
    import_preflight,
    iter_source_tests,
    sha256_bytes,
)


def question(source_id, stem="Stem", correct=("B",), **extra):
    row = {
        "id": source_id,
        "text": stem,
        "raw_text": f"<p>{stem}</p>",
        "options": [
            {"label": key, "text": value, "correct": key in correct}
            for key, value in zip("ABCD", ("One", "Two", "Three", "Four"))
        ],
        "correct_answer": f"{correct[0]}. Answer",
        "question_images": [],
        "explanation_images": [],
        "explanation": "<p>Why</p>",
        "bot": "@fixture",
        "video": "",
        "audio": None,
    }
    row.update(extra)
    return row


def fixture_html(path: Path):
    tests = [
        {
            "id": "001_intro", "title": "001 Intro", "num_questions": 2,
            "total_marks": 8, "duration": 12, "time_per_question": 60,
            "questions": [question("same", "Same payload"), question("multi", "Multiple", ("A", "C"))],
            "build_id": "fixture", "path": ["Anaesthesia"],
        },
        {
            "id": "002_previous_year_questions", "title": "002 Previous Year Questions", "num_questions": 2,
            "total_marks": 8, "duration": 12, "time_per_question": 60,
            "questions": [question("same", "Same payload"), question("same", "Changed payload")],
            "build_id": "fixture", "path": ["Anaesthesia"],
        },
        {
            "id": "001_other", "title": "001 Other", "num_questions": 1,
            "total_marks": 4, "duration": 11, "time_per_question": 60,
            "questions": [question("other")], "build_id": "fixture", "path": ["Anatomy"],
        },
    ]
    tree = {
        "name": "PREP q banks", "path": [], "tests": [],
        "folders": [
            {"name": "Anaesthesia", "path": ["Anaesthesia"], "tests": [{key: test[key] for key in ("id", "title", "num_questions", "total_marks", "duration", "time_per_question", "path")} for test in tests[:2]], "folders": []},
            {"name": "Anatomy", "path": ["Anatomy"], "tests": [{key: tests[2][key] for key in ("id", "title", "num_questions", "total_marks", "duration", "time_per_question", "path")}], "folders": []},
        ],
    }
    path.write_text(
        "<script>const FOLDER_TREE = " + json.dumps(tree) + ";\n"
        "// const TESTS_LIST = [...] }\n"
        "const TESTS_LIST = " + json.dumps(tests) + ";</script>", encoding="utf-8"
    )


class PrepLadderImporterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.source = Path(self.directory.name) / "PREP_q_banks.html"
        fixture_html(self.source)

    def tearDown(self):
        self.directory.cleanup()

    def test_streaming_adapter_preserves_source_structure(self):
        tree = extract_folder_tree(self.source)
        tests = list(iter_source_tests(self.source))
        self.assertEqual([folder["name"] for folder in tree["folders"]], ["Anaesthesia", "Anatomy"])
        self.assertEqual([test["id"] for test in tests], ["001_intro", "002_previous_year_questions", "001_other"])

    def test_multi_correct_is_per_option(self):
        payload = canonical_payload(question("multi", correct=("A", "C")))
        self.assertEqual(correct_keys(question("multi", correct=("A", "C"))), ["A", "C"])
        self.assertEqual([row["key"] for row in payload["options"] if row["is_correct"]], ["A", "C"])

    def test_plan_deduplicates_payload_but_preserves_occurrences_and_versions(self):
        plan = build_plan(self.source)
        counts = plan.report["counts"]
        self.assertTrue(plan.report["valid"])
        self.assertEqual(counts["source_tests"], 2)
        self.assertEqual(counts["question_occurrences"], 4)
        self.assertEqual(counts["unique_source_ids"], 2)
        self.assertEqual(counts["unique_content_versions"], 3)
        self.assertEqual(counts["duplicate_source_id_groups"], 1)
        self.assertEqual(counts["differing_content_duplicate_groups"], 1)
        self.assertEqual(counts["exact_payload_duplicates_saved"], 1)
        self.assertEqual(counts["multi_correct_occurrences"], 1)
        self.assertEqual(len(plan.manifest["occurrences"]), 4)
        self.assertEqual(len(plan.manifest["versions"]), 3)

    def test_payload_objects_are_deterministic_and_retrievable(self):
        left = build_plan(self.source)
        right = build_plan(self.source)
        self.assertEqual(left.manifest, right.manifest)
        self.assertEqual(left.object_bytes, right.object_bytes)
        for row in left.objects:
            content = left.object_bytes[row["object_path"]]
            self.assertEqual(sha256_bytes(content), row["sha256"])
            parsed = json.loads(gzip.decompress(content))
            self.assertEqual(parsed["schema_version"], 1)

    def test_occurrence_and_version_ids_are_stable(self):
        self.assertEqual(deterministic_uuid("question", "identity"), deterministic_uuid("question", "identity"))
        self.assertNotEqual(deterministic_uuid("question", "identity"), deterministic_uuid("occurrence", "identity"))

    def test_structural_corruption_blocks_import(self):
        tests = list(iter_source_tests(self.source))
        tests[0]["questions"][0]["options"] = []
        tree = extract_folder_tree(self.source)
        self.source.write_text(
            "<script>const FOLDER_TREE = " + json.dumps(tree) + ";\n// const TESTS_LIST = [...] }\nconst TESTS_LIST = " + json.dumps(tests) + ";</script>", encoding="utf-8"
        )
        plan = build_plan(self.source)
        self.assertFalse(plan.report["valid"])
        self.assertTrue(any("invalid option count" in error for error in plan.report["structural_errors"]))

    def test_media_references_are_preserved_without_binary_download(self):
        row = question("media", question_images=["https://example.test/q.png"], explanation_images=["https://example.test/e.png"], audio={"url": "https://example.test/a.mp3"})
        payload = canonical_payload(row)
        self.assertEqual([item["placement"] for item in payload["media"]], ["question", "explanation"])
        self.assertEqual(payload["audio"], {"url": "https://example.test/a.mp3"})

    def test_preflight_rejects_browser_key_before_network_or_parse(self):
        with patch("scripts.prepladder_import.api_request") as request:
            with self.assertRaisesRegex(ValueError, "not a Supabase service-role/secret key"):
                import_preflight(self.source, "https://flulljensjugfcxmeczu.supabase.co", "sb_publishable_browser")
        request.assert_not_called()

    def test_preflight_checks_permissions_migrations_and_bucket(self):
        header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256"}).encode()).decode().rstrip("=")
        payload = base64.urlsafe_b64encode(json.dumps({"role": "service_role"}).encode()).decode().rstrip("=")
        key = f"{header}.{payload}.signature"
        with patch("scripts.prepladder_import.api_request", return_value=(b"[]", {})) as request:
            result = import_preflight(self.source, "https://flulljensjugfcxmeczu.supabase.co", key)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(credential_kind(key), "service_role")
        self.assertEqual(request.call_count, 6)


if __name__ == "__main__":
    unittest.main()
