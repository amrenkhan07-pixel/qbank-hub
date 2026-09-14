import unittest

from scripts.two_stage_full_corpus import compact_record, qa_sample


class FullCorpusRunnerTests(unittest.TestCase):
    def test_compact_record_has_only_production_fields(self):
        row = {"question_id": "q", "cluster_id": "c", "confidence": .92,
               "review_reasons": ["x"]}
        self.assertEqual(set(compact_record(row)), {"content_id", "concept_ref", "classifier",
                                                   "confidence", "provenance", "review_state"})

    def test_qa_sampler_uses_nonblank_only(self):
        rows = [{"question_id": "q1", "subject": "Medicine", "generated_label": "X",
                 "negative": False, "source_test": "Test", "is_pyq": False},
                {"question_id": "q2", "subject": "Medicine", "generated_label": None,
                 "negative": False, "source_test": "Test", "is_pyq": False}]
        sample = qa_sample(rows, [], 1)
        self.assertEqual([x["question_id"] for x in sample], ["q1"])


if __name__ == "__main__":
    unittest.main()
