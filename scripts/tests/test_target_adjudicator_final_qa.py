import unittest
from scripts.target_adjudicator_final_qa import INCORRECT

class FinalQATests(unittest.TestCase):
 def test_adjudicated_failure_count(self): self.assertEqual(len(INCORRECT),9)

if __name__=='__main__': unittest.main()
