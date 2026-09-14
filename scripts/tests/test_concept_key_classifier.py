import unittest
from scripts.concept_key_classifier import extract_candidate,norm_phrase
class ConceptKeyTests(unittest.TestCase):
 def test_explicit_diagnosis_candidate(self): self.assertEqual(extract_candidate('The diagnosis is myxedema coma. It is severe hypothyroidism.','What is the diagnosis?'),'myxedema coma')
 def test_negative_does_not_use_answer_shortcut(self): self.assertIsNone(extract_candidate('Dantrolene Correct Answer','Which diagnosis is NOT correct?',True))
 def test_phrase_is_compact(self): self.assertEqual(norm_phrase('Vaso-occlusive crisis in SCD because of sickling'),'vaso occlusive crisis in scd')
if __name__=='__main__': unittest.main()
