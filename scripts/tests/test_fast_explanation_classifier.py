import importlib.util
import sys
import unittest
from pathlib import Path


MODULE = Path(__file__).parent.parent / "fast_explanation_classifier.py"
sys.path.insert(0, str(MODULE.parent))
SPEC = importlib.util.spec_from_file_location("fast_explanation_classifier", MODULE)
fast = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fast)


class FastExplanationClassifierTests(unittest.TestCase):
    def test_excerpt_keeps_first_two_teaching_points(self):
        text = "First substantive teaching sentence explains alpha. Second substantive teaching sentence explains beta. Third should be excluded."
        self.assertEqual(fast.teaching_excerpt(text).count("sentence"), 2)

    def test_excerpt_discards_option_discussion(self):
        text = "Option A is incorrect because it is a distractor. The disease is caused by enzyme deficiency. Treatment replaces the missing product."
        excerpt = fast.teaching_excerpt(text)
        self.assertNotIn("Option A", excerpt)
        self.assertIn("enzyme deficiency", excerpt)

    def test_negative_answer_channel_is_empty(self):
        # The implementation-level safety invariant is deliberately explicit.
        source = Path(MODULE).read_text()
        self.assertIn('"answer": set() if negative else tokens(row["correct_answer_text"])', source)

    def test_confident_source_topic_cannot_be_content_overridden(self):
        source = Path(MODULE).read_text()
        self.assertIn('content_override = False', source)
        self.assertNotIn('challenger[0] >= incumbent', source)

    def test_full_run_uses_separate_checkpoint(self):
        self.assertNotEqual(fast.FULL_CHECKPOINT, fast.DEFAULT_CHECKPOINT)


if __name__ == "__main__":
    unittest.main()
