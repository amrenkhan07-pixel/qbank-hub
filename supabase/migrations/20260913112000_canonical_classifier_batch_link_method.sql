-- Add the compact classifier-batch provenance value used by the transactional
-- 1,000-question commit gate. Existing link methods and rows are unchanged.

alter table public.canonical_question_versions
  drop constraint if exists canonical_question_versions_link_method_check;
alter table public.canonical_question_versions
  add constraint canonical_question_versions_link_method_check
  check (link_method in ('manual','exact_hash','source_declared','reviewed_match','classifier_batch'));
