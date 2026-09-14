-- VALIDATION-ONLY persistence design for SAFE_V1. DO NOT EXECUTE in this task.
-- A future authorized migration must create the table through `supabase migration new`.
begin;

create temporary table safe_v1_assignment_contract (
  question_id uuid not null,
  normalized_concept_ref text not null,
  classifier_version text not null,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  provenance_summary text not null,
  review_status text not null check (review_status = 'safe_v1'),
  primary key (question_id, classifier_version)
) on commit drop;

-- Future write shape: batched atomic UPSERT, resumable by the composite key.
insert into safe_v1_assignment_contract (
  question_id, normalized_concept_ref, classifier_version, confidence,
  provenance_summary, review_status
) values
  ('00000000-0000-0000-0000-000000000001', 'example-concept-ref',
   'safe-v1-filter-2026-09-14', 0.980, 'confirmed_exact_answer_agreement', 'safe_v1')
on conflict (question_id, classifier_version) do update set
  normalized_concept_ref=excluded.normalized_concept_ref,
  confidence=excluded.confidence,
  provenance_summary=excluded.provenance_summary,
  review_status=excluded.review_status;

do $$ begin
  if (select count(*) from safe_v1_assignment_contract) <> 1 then
    raise exception 'SAFE_V1 idempotency contract failed';
  end if;
end $$;

rollback;
