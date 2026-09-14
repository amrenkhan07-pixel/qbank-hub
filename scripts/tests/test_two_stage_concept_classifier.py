import unittest

from scripts.two_stage_concept_classifier import clean_label, first_stage, label_key, second_stage


class TwoStageConceptClassifierTests(unittest.TestCase):
    def row(self, explanation, stem="What is the diagnosis?", polarity="standard"):
        return {"question_id": "q1", "subject": "Medicine", "source_title": "Test",
                "polarity": polarity, "stem_text": stem,
                "positive_explanation_text": explanation, "correct_answer_text": ""}

    def test_explicit_entity_is_generated(self):
        got = first_stage(self.row("The diagnosis is myxedema coma. It is severe hypothyroidism."))
        self.assertEqual(got["generated_label"], "myxedema coma")

    def test_negative_question_is_blank(self):
        got = first_stage(self.row("The diagnosis is myxedema coma.", "Which is NOT correct?", "negative"))
        self.assertIsNone(got["generated_label"])

    def test_fragments_are_rejected(self):
        self.assertIsNone(clean_label("this diagnosis"))
        self.assertIsNone(clean_label("confirmed by identifying broad"))
        self.assertIsNone(clean_label("more consistent"))

    def test_leading_scaffold_is_removed(self):
        self.assertEqual(clean_label("classic example of delirium tremens"), "delirium tremens")
        self.assertEqual(clean_label("pure red cell alasia"), "pure red cell aplasia")

    def test_equivalence_is_subject_bounded(self):
        self.assertEqual(label_key("Chiari type-1 malformation"), "chiari type 1 malformation")
        rows = [first_stage(self.row("The diagnosis is Chiari type 1 malformation."))]
        rows[0]["question_id"] = "q1"
        clusters, review = second_stage(rows)
        self.assertEqual(len(clusters), 1)
        self.assertEqual(review, [])


if __name__ == "__main__":
    unittest.main()
