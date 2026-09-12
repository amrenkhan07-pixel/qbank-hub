-- Cover the composite run/topic foreign keys in their declared column order.
-- Replace narrower run-only indexes so the compact schema does not retain
-- redundant index structures.

drop index if exists public.canonical_taxonomy_assignment_run_idx;
create index if not exists canonical_taxonomy_assignment_run_version_idx
  on public.canonical_question_taxonomy_assignments
  (classification_run_id, taxonomy_version_id)
  where classification_run_id is not null;

drop index if exists public.canonical_concept_assignment_run_idx;
create index if not exists canonical_concept_assignment_run_version_idx
  on public.canonical_question_concept_assignments
  (classification_run_id, taxonomy_version_id)
  where classification_run_id is not null;

drop index if exists public.canonical_assignment_evidence_run_idx;
create index if not exists canonical_assignment_evidence_run_version_idx
  on public.canonical_assignment_review_evidence
  (classification_run_id, taxonomy_version_id)
  where classification_run_id is not null;

drop index if exists public.canonical_source_test_assignment_run_idx;
create index if not exists canonical_source_test_assignment_run_version_idx
  on public.canonical_source_test_topic_assignments
  (classification_run_id, taxonomy_version_id)
  where classification_run_id is not null;

create index if not exists canonical_source_test_assignment_topic_version_idx
  on public.canonical_source_test_topic_assignments
  (topic_node_id, taxonomy_version_id);
