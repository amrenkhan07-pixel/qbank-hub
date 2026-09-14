import unittest
from pathlib import Path

PLAN=Path(__file__).parents[1]/'safe_v1_persistence_plan.sql'

class PersistencePlanTests(unittest.TestCase):
 def test_plan_is_rollback_only(self):
  sql=PLAN.read_text().lower(); self.assertIn('begin;',sql); self.assertIn('rollback;',sql); self.assertNotIn('commit;',sql)
 def test_plan_is_idempotent_and_compact(self):
  sql=PLAN.read_text().lower(); self.assertIn('on conflict (question_id, classifier_version)',sql)
  for field in ('question_id','normalized_concept_ref','classifier_version','confidence','provenance_summary','review_status'): self.assertIn(field,sql)
  for forbidden in ('stem','explanation','options'): self.assertNotIn(forbidden,sql)

if __name__=='__main__': unittest.main()
