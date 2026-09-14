import unittest
from scripts.target_adjudicator_full import sample_final

class TargetFullTests(unittest.TestCase):
    def test_sample_final_uses_only_supplied_final_rows(self):
        row={"question_id":"q","subject":"Medicine","action":"CONFIRM","source_test":"Test",
             "is_pyq":False,"final_label":"x"}
        self.assertEqual(sample_final([row],[],1)[0]["question_id"],"q")

if __name__=="__main__": unittest.main()
