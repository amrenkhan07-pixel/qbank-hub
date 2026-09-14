import unittest
from scripts.concept_review_server import REPORT,PAGE
class ConceptReviewTests(unittest.TestCase):
 def test_report_and_page_exist(self): self.assertTrue(REPORT.exists()); self.assertTrue(PAGE.exists())
 def test_page_has_required_actions(self):
  text=PAGE.read_text()
  for label in ('Link existing','Accept candidate','Rename','Defer','No Concept needed'): self.assertIn(label,text)
if __name__=='__main__': unittest.main()
