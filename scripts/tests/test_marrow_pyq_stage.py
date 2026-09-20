import json
import tempfile
import unittest
from pathlib import Path

from scripts.marrow_pyq_stage import OP_INVALID, OP_MATCH, OP_PRESENT, OP_REPEAT, OP_REVIEW, materialize_payload_objects, stage, write_artifact
from scripts.prepladder_import import canonical_payload, deterministic_uuid, stable_json
from scripts.marrow_pyq_stage import sha


def question(qid="M1", explanation="Marrow explanation", answer="A. One"):
    return {"id": qid, "text": "What is X?", "raw_text": "<p>What is X?</p>",
            "options": [{"label": "A", "text": "One", "correct": answer.startswith("A")},
                        {"label": "B", "text": "Two", "correct": answer.startswith("B")}],
            "correct_answer": answer, "explanation": f"<p>{explanation}</p>",
            "question_images": ["https://example.org/q.png"],
            "explanation_images": ["https://example.org/e.png"],
            "video": None, "audio": None}


class MarrowPyqStageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.cache = root / "cache"
        self.cache.mkdir()
        prep = canonical_payload(question("P1", "Prep explanation"))
        (self.cache / "prep.json").write_text(json.dumps({"subject": "Anatomy", "questions": [prep]}))
        self.prep_id = deterministic_uuid("question", f"PrepLadder|Anatomy|{sha(prep)}")
        self.canonical = {"project_id": "test", "read_only": True,
                          "canonical_versions": [{"question_id": self.prep_id, "canonical_question_id": "identity-1"}]}
        self.state = {"project_id": "test", "read_only": True, "payloads": 1,
                      "canonical_versions": 1, "marrow_occurrences": 0, "marrow_payloads": 0,
                      "marrow_occurrence_keys": [], "marrow_content_keys": []}
        tests = [
            {"id": "a", "title": "Anatomy Aiims 2019 (May & Nov)", "path": ["Anatomy"],
             "questions": [question(), {"id": "BROKEN", "options": []}]},
            {"id": "b", "title": "Anatomy Neet 2024", "path": ["Anatomy"], "questions": [question()]},
            {"id": "c", "title": "Anatomy Inicet 2025", "path": ["Anatomy"],
             "questions": [question("M2", "Different Marrow explanation"), question("M3", "Stem-only candidate", "B. Two")]},
        ]
        tree = {"folders": [{"name": "Anatomy", "tests": [
            {"id": t["id"], "title": t["title"], "num_questions": len(t["questions"])} for t in tests]}]}
        self.source = root / "source.html"
        self.source.write_text("// const TESTS_LIST = documentation\nconst FOLDER_TREE = " + json.dumps(tree)
                               + ";\nconst TESTS_LIST = " + json.dumps(tests) + ";")

    def test_versions_occurrences_media_quarantine_and_review(self):
        result = stage(self.source, self.cache, self.canonical, self.state)
        self.assertEqual(result["summary"]["staged_occurrences"], 5)
        self.assertEqual(result["summary"]["new_marrow_content_versions"], 3)
        operations = [x["operation"] for x in result["occurrences"]]
        self.assertEqual(operations, [OP_MATCH, OP_INVALID, OP_REPEAT, OP_MATCH, OP_REVIEW])
        self.assertEqual(result["occurrences"][0]["question_id"], result["occurrences"][2]["question_id"])
        self.assertNotEqual(result["occurrences"][0]["question_id"], result["occurrences"][3]["question_id"])
        self.assertEqual(result["occurrences"][0]["exam_family"], "AIIMS")
        self.assertIsNone(result["occurrences"][0]["session"])
        self.assertEqual(result["occurrences"][2]["exam_family"], "NEET-PG")
        self.assertEqual(result["occurrences"][3]["exam_family"], "INI-CET")
        self.assertEqual(result["occurrences"][2]["question_order_within_test"], 1)
        self.assertEqual(result["summary"]["review_reasons"], {"stem_only_match": 1})
        version = result["content_versions"][0]
        self.assertEqual(version["proposed_canonical_question_id"], "identity-1")
        self.assertEqual(len(version["payload"]["media"]), 2)
        self.assertIn("Marrow explanation", version["payload"]["explanation_html"])

    def test_exact_rerun_and_artifact_determinism(self):
        first = stage(self.source, self.cache, self.canonical, self.state)
        materialize_payload_objects(first, Path(self.tmp.name) / "objects")
        self.assertEqual(first["summary"]["payload_objects"], 3)
        self.assertEqual(sum(x["question_count"] for x in first["payload_objects"]), 3)
        self.assertTrue(all((Path(self.tmp.name) / "objects" / x["object_path"]).is_file()
                            for x in first["payload_objects"]))
        output1, output2 = Path(self.tmp.name) / "a.json.gz", Path(self.tmp.name) / "b.json.gz"
        second = stage(self.source, self.cache, self.canonical, self.state)
        materialize_payload_objects(second, Path(self.tmp.name) / "objects2")
        self.assertEqual(write_artifact(first, output1), write_artifact(second, output2))
        self.state["marrow_occurrence_keys"] = [x["occurrence_key"] for x in first["occurrences"] if "occurrence_key" in x]
        self.state["marrow_occurrences"] = len(self.state["marrow_occurrence_keys"])
        self.state["marrow_content_keys"] = [[x["subject"], x["content_sha256"]] for x in first["content_versions"]]
        self.state["marrow_payloads"] = len(self.state["marrow_content_keys"])
        rerun = stage(self.source, self.cache, self.canonical, self.state)
        self.assertEqual(rerun["summary"]["operation_counts"], {OP_PRESENT: 4, OP_INVALID: 1})
        self.assertEqual(rerun["summary"]["new_marrow_content_versions"], 0)


if __name__ == "__main__":
    unittest.main()
