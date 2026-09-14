import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[2]
MIGRATION = ROOT / "supabase/migrations/20260914125113_prepladder_concept_v1_persistence.sql"
SCRIPT = ROOT / "scripts/persist_safe_v1.py"


class SafeV1ProductionPersistenceTests(unittest.TestCase):
    def test_migration_is_additive_and_protects_source_and_learner_tables(self):
        sql = MIGRATION.read_text().lower()
        for table in ("questions", "question_attempts", "test_sessions", "user_question_state", "qbank_source_occurrences"):
            self.assertNotRegex(sql, rf"(?:update|delete from|alter table)\s+public\.{table}\b")
        self.assertNotIn("on delete cascade", sql)

    def test_contract_is_compact_versioned_and_unique(self):
        sql = MIGRATION.read_text().lower()
        self.assertIn("primary key (question_id, classifier_version)", sql)
        self.assertIn("foreign key (normalized_concept_ref, classifier_version)", sql)
        self.assertIn("expected exactly 1355 unique safe_v1 rows", sql)
        for forbidden in ("stem", "options", "explanation", "source_html", "reasoning_text"):
            self.assertNotIn(forbidden, sql)

    def test_tables_and_rpc_are_service_only(self):
        sql = MIGRATION.read_text().lower()
        self.assertEqual(sql.count("enable row level security"), 2)
        self.assertIn("from public, anon, authenticated", sql)
        self.assertIn("grant execute on function public.persist_prepladder_concept_v1(jsonb) to service_role", sql)
        self.assertNotIn("create policy", sql)

    def test_write_is_one_transactional_rpc_and_idempotent(self):
        sql = MIGRATION.read_text().lower()
        self.assertIn("jsonb_to_recordset", sql)
        self.assertIn("on conflict (question_id, classifier_version) do update", sql)
        self.assertIn("existing normalized concept conflicts", sql)
        self.assertIn("payload contains unresolved question ids", sql)

    def test_runner_is_pinned_to_accepted_artifact(self):
        source = SCRIPT.read_text()
        ast.parse(source)
        self.assertIn("f5b760e4834e746693349c20369b72a78b6235098d5308af027fb7c28772f6a2", source)
        self.assertIn('EXPECTED = 1355', source)
        self.assertIn('DEFERRED = 1399', source)
        self.assertIn('parser.add_argument("--apply", action="store_true")', source)


if __name__ == "__main__":
    unittest.main()
