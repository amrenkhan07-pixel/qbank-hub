import unittest

from scripts.marrow_pyq_audit import exam_metadata, match_key, smoke, subject_name


class MarrowPyqAuditTests(unittest.TestCase):
    def test_exam_history_and_combined_session(self):
        self.assertEqual(exam_metadata("Medicine Aiims 2019 (May & Nov)")["exam"], "AIIMS")
        self.assertIsNone(exam_metadata("Medicine Aiims 2019 (May & Nov)")["session"])
        self.assertEqual(exam_metadata("Medicine Aiims 2020 (May And Nov Ini Cet)")["exam"], "AIIMS")
        self.assertEqual(exam_metadata("Medicine Neet 2024")["exam"], "NEET-PG")
        self.assertEqual(exam_metadata("Ent Inicet 2022")["exam"], "INI-CET")
        self.assertEqual(exam_metadata("Medicine Ini Cet 2025")["year"], 2025)

    def test_subject_alias_only(self):
        self.assertEqual(subject_name("Obstetrics and Gynecology"), "Obstetrics & Gynecology")
        self.assertEqual(subject_name("Obstetrics & Gynecology"), "Obstetrics & Gynecology")
        self.assertEqual(subject_name("Anesthesia"), "Anaesthesia")

    def test_match_keeps_answer_and_explanation_boundaries(self):
        base = {"question_html": "What is X?", "options": [{"key": "A", "html": "One"}, {"key": "B", "html": "Two"}],
                "correct_keys": ["A"], "explanation_html": "First"}
        revised = {**base, "explanation_html": "Second"}
        self.assertEqual(match_key(base), match_key(revised))
        self.assertNotEqual(match_key(base, True), match_key(revised, True))
        wrong = {**base, "correct_keys": ["B"]}
        self.assertNotEqual(match_key(base), match_key(wrong))


if __name__ == "__main__":
    unittest.main()
