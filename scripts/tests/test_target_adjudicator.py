import unittest

from scripts.target_adjudicator import adjudicate, extract_correct_answer, normalize_label


class TargetAdjudicatorTests(unittest.TestCase):
    def item(self, candidate, answer, stem="Which is correct?"):
        return {"question_id": "q", "subject": "Medicine", "generated_label": candidate,
                "negative": False, "stem": stem,
                "teaching": f"Correct answer: B. {answer} Correct Answer: B) {answer} The explanation follows.",
                "source_test": "Test"}

    def test_confirm(self):
        self.assertEqual(adjudicate(self.item("Breslow thickness", "Breslow thickness"))["action"], "CONFIRM")

    def test_replace_background_disease(self):
        got = adjudicate(self.item("malignant melanoma", "Tumour thickness"))
        self.assertEqual((got["action"], got["final_label"]), ("REPLACE", "tumour thickness"))

    def test_negative_is_blank(self):
        got = adjudicate(self.item("antivenom", "Neostigmine with atropine", "Which is NOT used?"))
        self.assertEqual((got["action"], got["final_label"]), ("BLANK", None))

    def test_generic_fragment_is_not_a_label(self):
        self.assertIsNone(normalize_label("consistent"))

    def test_answer_parser(self):
        self.assertEqual(extract_correct_answer("Correct answer: D. Gamma-phage lysis Correct Answer: D) Gamma-phage lysis"), "gamma-phage lysis")


if __name__ == "__main__":
    unittest.main()
