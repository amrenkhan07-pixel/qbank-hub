-- Cover the direct foreign-key lookups introduced by the bounded
-- Source-Test normalization and question-assignment pilot.

create index if not exists canonical_source_test_proposals_source_test_fk_idx
  on public.canonical_source_test_topic_proposals (source_test_id);

create index if not exists canonical_concept_assignment_taxonomy_version_fk_idx
  on public.canonical_question_concept_assignments (taxonomy_version_id);
