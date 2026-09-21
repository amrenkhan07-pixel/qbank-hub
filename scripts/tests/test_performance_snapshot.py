import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
APP = (ROOT / "app/app.js").read_text()
MIGRATION = (ROOT / "supabase/migrations/20260922000200_qbank_analytics_snapshot.sql").read_text()


class PerformanceSnapshotTests(unittest.TestCase):
    def test_analytics_landing_uses_one_compact_rpc(self):
        self.assertIn("db.rpc('qbank_analytics_snapshot')", APP)
        fast_branch = APP.split("async function analytics()", 1)[1].split("const allFilters", 1)[0]
        self.assertNotIn("resolvePopulation(", fast_branch)
        self.assertNotIn("loadQuestionsByIds(", fast_branch)

    def test_snapshot_does_not_return_question_content_or_ids(self):
        lowered = MIGRATION.lower()
        self.assertNotIn("question_text", lowered)
        self.assertNotIn("explanation_html", lowered)
        self.assertNotIn("array_agg(q.id", lowered)

    def test_snapshot_is_authenticated_and_security_invoker(self):
        self.assertIn("security invoker", MIGRATION.lower())
        self.assertIn("grant execute on function public.qbank_analytics_snapshot() to authenticated", MIGRATION.lower())
        self.assertIn("revoke all on function public.qbank_analytics_snapshot() from public", MIGRATION.lower())

    def test_learner_mutations_invalidate_snapshot(self):
        self.assertGreaterEqual(APP.count("invalidateLearnerCaches()"), 4)

    def test_review_default_does_not_resolve_full_corpus(self):
        review = APP.split("async function review()", 1)[1].split("const ANALYTICS_STATUSES", 1)[0]
        self.assertIn("hasPopulationFilter ? await matchingQuestionIds", review)
        self.assertIn("question_ids: learningQuestionIds", review)

    def test_selected_test_loading_remains_server_bounded(self):
        self.assertIn("source_tests: [target.dataset.test]", APP)
        self.assertIn("order: normalizedFilters.source_tests?.length ? 'source' : 'sample'", APP)


if __name__ == "__main__":
    unittest.main()
