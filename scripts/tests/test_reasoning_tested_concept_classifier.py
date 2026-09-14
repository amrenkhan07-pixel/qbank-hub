import tempfile
import unittest
from pathlib import Path

from scripts.reasoning_tested_concept_classifier import OUTPUT_SCHEMA, content_key, request_body


ITEM = {"question_id": "q1", "subject": "Pathology", "source_test": "Skin tumors",
        "stem": "Which factor best predicts melanoma prognosis?", "options": "A | B",
        "correct_answer": "Breslow thickness", "explanation": "Breslow thickness is most important.",
        "negative_question": False}


class ReasoningClassifierTests(unittest.TestCase):
    def test_schema_requires_all_contract_fields(self):
        self.assertEqual(set(OUTPUT_SCHEMA["required"]), set(OUTPUT_SCHEMA["properties"]))

    def test_cache_key_is_stable_and_model_specific(self):
        self.assertEqual(content_key(ITEM, "m1"), content_key(dict(ITEM), "m1"))
        self.assertNotEqual(content_key(ITEM, "m1"), content_key(ITEM, "m2"))

    def test_request_does_not_include_old_taxonomy(self):
        body = request_body(ITEM, "m1")
        self.assertNotIn("canonical", body["input"].lower())
        self.assertTrue(body["text"]["format"]["strict"])


if __name__ == "__main__":
    unittest.main()
