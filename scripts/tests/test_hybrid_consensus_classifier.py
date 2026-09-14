import unittest
from scripts.hybrid_consensus_classifier import REGRESSION_IDS,UNSAFE,normalized
class HybridConsensusTests(unittest.TestCase):
 def test_known_unsafe_are_not_trusted(self):
  for name in ('cisatracurium','platelet disorders','vulvar and vaginal cancer'): self.assertIn(name,UNSAFE)
 def test_boundary_normalization(self): self.assertEqual(normalized('Myxedema-coma'),' myxedema coma ')
 def test_all_regression_cases_have_fixed_questions(self): self.assertEqual(len(REGRESSION_IDS),12)
if __name__=='__main__': unittest.main()
