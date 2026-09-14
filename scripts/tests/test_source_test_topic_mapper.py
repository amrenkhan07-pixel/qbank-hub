import unittest
from scripts.source_test_topic_mapper import spread

class SourceTestMapperTests(unittest.TestCase):
    def test_spread_is_bounded_and_deterministic(self):
        rows=[{'question_position':i,'question_id':str(i)} for i in range(100)]
        self.assertEqual(spread(rows),spread(rows))
        self.assertEqual(len(spread(rows)),9)
        self.assertEqual(spread(rows)[0]['question_position'],0)
        self.assertEqual(spread(rows)[-1]['question_position'],99)

    def test_small_test_keeps_every_question(self):
        rows=[{'question_position':i,'question_id':str(i)} for i in range(3)]
        self.assertEqual(spread(rows),rows)

if __name__=='__main__': unittest.main()
