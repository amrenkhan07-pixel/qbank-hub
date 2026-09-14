import unittest
from scripts.safe_v1_filter import filter_rows,key

class SafeV1FilterTests(unittest.TestCase):
 def row(self,**changes):
  base={'question_id':'q','final_label':'myxedema coma','final_confidence':.98,'action':'CONFIRM','original_candidate':'myxedema coma','parsed_correct_answer':'myxedema coma','final_cluster_id':'c','negative':False}
  return {**base,**changes}
 def review(self,ids=()): return {'suspicious_assignments':[{'question_id':x} for x in ids],'ambiguous_clusters':[]}
 def test_clean_confirm_is_safe(self): self.assertEqual(len(filter_rows({'results':[self.row()]},self.review())[0]),1)
 def test_review_member_is_deferred(self): self.assertEqual(len(filter_rows({'results':[self.row()]},self.review(['q']))[1]),1)
 def test_replace_is_deferred(self): self.assertEqual(len(filter_rows({'results':[self.row(action='REPLACE',final_confidence=.96)]},self.review())[1]),1)
 def test_containment_is_weak_not_exact(self): self.assertNotEqual(key('melanoma'),key('malignant melanoma'))

if __name__=='__main__': unittest.main()
