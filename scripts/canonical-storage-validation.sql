-- Read-only storage/schema validation. This must not classify questions.
with checks as (
  select 'content.questions_unchanged' check_name,
    abs(23262 - count(*)) failures, format('%s questions', count(*)) detail
  from public.questions
  union all select 'content.source_occurrences_unchanged',
    abs(23118 - count(*)), format('%s source occurrences', count(*))
  from public.qbank_source_occurrences
  union all select 'learner.attempts_unchanged',
    abs(179 - count(*)), format('%s attempts', count(*))
  from public.question_attempts
  union all select 'learner.sessions_unchanged',
    abs(69 - count(*)), format('%s sessions', count(*))
  from public.test_sessions
  union all select 'learner.state_unchanged',
    abs(126 - count(*)), format('%s learner-state rows', count(*))
  from public.user_question_state
  union all select 'classification.still_authorized_batches_only',
    abs(1145 - count(*)), format('%s current primary assignments', count(*))
  from public.canonical_question_taxonomy_assignments
  where is_current and is_primary
  union all select 'classification.exact_authorized_question_versions',
    abs(1150 - count(*)), format('%s canonical question versions', count(*))
  from public.canonical_question_versions
  union all select 'classification.pilot_run_registered_once',
    abs(1 - count(*)), format('%s pilot run records', count(*))
  from public.canonical_classification_runs
  where scope_key = 'canonical-medical-v1-pilot-150'
  union all select 'classification.pilot_paths_linked_to_run',
    count(*) filter (where classification_run_id is null),
    format('%s/%s paths linked', count(*) filter (where classification_run_id is not null), count(*))
  from public.canonical_question_taxonomy_assignments
  union all select 'classification.pilot_concepts_linked_to_run',
    count(*) filter (where classification_run_id is null),
    format('%s/%s concepts linked', count(*) filter (where classification_run_id is not null), count(*))
  from public.canonical_question_concept_assignments
  union all select 'classification.sparse_evidence_matches_batch',
    abs(518 - count(*)), format('%s sparse evidence rows across preserved and current batch generations', count(*))
  from public.canonical_assignment_review_evidence
  union all select 'classification.compact_source_map_once',
    abs(1108 - count(*)), format('%s compact Source-Test mappings', count(*))
  from public.canonical_source_test_topic_assignments
  union all select 'draft.sample_preserved',
    abs(380 - count(*)), format('%s draft sample rows', count(*))
  from public.canonical_taxonomy_draft_sample
  union all select 'draft.evidence_preserved',
    abs(380 - count(*)), format('%s draft evidence rows', count(*))
  from public.canonical_taxonomy_draft_evidence
  union all select 'source_normalization.proposals_preserved',
    abs(1129 - count(*)), format('%s Source-Test proposals', count(*))
  from public.canonical_source_test_topic_proposals
  union all select 'relationships.preserved_and_inactive',
    abs(12 - count(*)), format('%s review-only relationships', count(*))
  from public.canonical_concept_relationships
  union all select 'storage.no_question_content_in_compact_tables', count(*),
    format('%s forbidden content columns', count(*))
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('canonical_classification_runs','canonical_source_test_topic_assignments')
    and column_name in ('question_text','stem_text','options','explanation_html','question_images','explanation_images')
  union all select 'storage.sparse_evidence_is_exception_only', count(*),
    format('%s invalid evidence kinds', count(*))
  from public.canonical_assignment_review_evidence
  where evidence_kind not in ('low_confidence','ambiguous','content_override','human_review')
  union all select 'storage.duplicate_indexes_removed', count(*),
    format('%s known duplicate indexes remain', count(*))
  from pg_class i join pg_namespace n on n.oid = i.relnamespace
  where n.nspname = 'public' and i.relkind = 'i'
    and i.relname in ('questions_platform_source_question_uidx','test_answers_session_idx','idx_user_state_bookmarked','personal_tags_user_name_idx')
  union all select 'security.new_tables_have_rls', abs(3 - count(*)),
    format('%s/3 compact tables have RLS', count(*))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relrowsecurity
    and c.relname in ('canonical_classification_runs','canonical_assignment_review_evidence','canonical_source_test_topic_assignments')
  union all select 'security.new_tables_are_service_only', count(*),
    format('%s anon/authenticated grants remain', count(*))
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('canonical_classification_runs','canonical_assignment_review_evidence','canonical_source_test_topic_assignments')
    and grantee in ('anon','authenticated')
)
select case when failures = 0 then 'PASS' else 'FAIL' end status,
  check_name, detail
from checks
order by status desc, check_name;
