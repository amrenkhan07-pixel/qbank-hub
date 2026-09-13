-- Transactional, service-only commit gate for one exactly 1,000-question
-- canonical classification batch. The payload contains IDs and compact
-- classification metadata only; source content remains in its existing tables.

create or replace function public.qbank_commit_canonical_classification_batch(
  p_taxonomy_version_key text,
  p_scope_key text,
  p_classifier_version text,
  p_configuration_sha256 text,
  p_batch jsonb,
  p_summary jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version_id uuid;
  v_run_id uuid;
  v_row jsonb;
  v_secondary jsonb;
  v_canonical_question_id uuid;
  v_primary_node_id uuid;
  v_primary_concept_id uuid;
  v_evidence_kind text;
  v_questions_before bigint;
  v_options_before bigint;
  v_occurrences_before bigint;
  v_attempts_before bigint;
  v_sessions_before bigint;
  v_state_before bigint;
  v_versions_before bigint;
  v_primary_before bigint;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'Service role required';
  end if;
  if jsonb_typeof(p_batch) <> 'array' or jsonb_array_length(p_batch) <> 1000 then
    raise exception 'Batch must contain exactly 1000 questions';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_batch) item
    where item ?| array['stem','stem_text','question_text','options','explanation','explanation_html','media']
       or coalesce(item->'evidence', '{}'::jsonb) ?| array['stem','stem_text','question_text','options','explanation','explanation_html','media']
  ) then
    raise exception 'Classification payload must not copy source content';
  end if;
  if (select count(distinct (item->>'question_id')::uuid) from jsonb_array_elements(p_batch) item) <> 1000 then
    raise exception 'Batch question IDs must be unique';
  end if;
  if jsonb_typeof(coalesce(p_summary, '{}'::jsonb)) <> 'object'
     or p_summary ?| array['question_ids','questions','stems','options','explanations'] then
    raise exception 'Run summary must contain aggregate metrics only';
  end if;

  select id into v_version_id
  from public.canonical_taxonomy_versions
  where version_key = p_taxonomy_version_key and status = 'draft';
  if v_version_id is null then raise exception 'Draft taxonomy version not found'; end if;

  perform pg_advisory_xact_lock(hashtext('qbank-canonical-classification-v1'));
  if exists (
    select 1
    from jsonb_array_elements(p_batch) item
    left join public.questions q on q.id = (item->>'question_id')::uuid
    left join public.platforms platform on platform.id = q.platform_id
    where q.id is null or not q.is_usable or lower(platform.name) <> 'prepladder'
  ) then raise exception 'Batch contains a missing, unusable, or non-PrepLadder question'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_batch) item
    join public.canonical_question_versions version_link
      on version_link.question_id = (item->>'question_id')::uuid
  ) then raise exception 'Batch overlaps an existing canonical question version'; end if;
  if exists (
    select 1
    from jsonb_array_elements(p_batch) item
    join public.questions q on q.id = (item->>'question_id')::uuid
    join public.subjects subject on subject.id = q.subject_id
    left join public.canonical_taxonomy_nodes node
      on node.id = nullif(item->>'primary_node_id', '')::uuid
     and node.taxonomy_version_id = v_version_id
    where (nullif(item->>'primary_node_id', '') is not null and node.id is null)
       or (node.id is not null and node.metadata->>'subject' is distinct from subject.name)
  ) then raise exception 'Primary canonical path is missing, cross-version, or cross-subject'; end if;
  if exists (
    select 1
    from jsonb_array_elements(p_batch) item
    left join public.canonical_medical_concepts concept
      on concept.id = nullif(item->>'primary_concept_id', '')::uuid
     and concept.taxonomy_version_id = v_version_id
    where nullif(item->>'primary_concept_id', '') is not null and concept.id is null
  ) then raise exception 'Primary canonical concept is missing or cross-version'; end if;

  select count(*) into v_questions_before from public.questions;
  select count(*) into v_options_before from public.question_options;
  select count(*) into v_occurrences_before from public.qbank_source_occurrences;
  select count(*) into v_attempts_before from public.question_attempts;
  select count(*) into v_sessions_before from public.test_sessions;
  select count(*) into v_state_before from public.user_question_state;
  select count(*) into v_versions_before from public.canonical_question_versions;
  select count(*) into v_primary_before from public.canonical_question_taxonomy_assignments where is_current and is_primary;

  insert into public.canonical_classification_runs(
    taxonomy_version_id, scope_key, scope_type, classifier_name, classifier_version,
    assignment_method, status, configuration_sha256, summary, completed_at
  ) values (
    v_version_id, p_scope_key, 'batch', 'qbank-canonical-classifier', p_classifier_version,
    'model', 'completed', p_configuration_sha256, p_summary, now()
  )
  on conflict (taxonomy_version_id, scope_key) do nothing
  returning id into v_run_id;
  if v_run_id is null then raise exception 'Classification scope already exists'; end if;

  -- Publish the accepted normalized Source-Test Topic prior once. Ambiguous
  -- classifier probabilities do not create secondary Topic rows.
  insert into public.canonical_source_test_topic_assignments(
    taxonomy_version_id, source_test_id, topic_node_id, classification_run_id,
    is_primary, is_current, confidence, source_test_prior_method, review_state
  )
  select proposal.taxonomy_version_id, proposal.source_test_id, proposal.proposed_topic_node_id,
    v_run_id, true, true, proposal.confidence, proposal.classification_basis, 0
  from public.canonical_source_test_topic_proposals proposal
  where proposal.taxonomy_version_id = v_version_id
    and proposal.proposed_topic_node_id is not null
  on conflict do nothing;

  for v_row in select value from jsonb_array_elements(p_batch)
  loop
    v_primary_node_id := nullif(v_row->>'primary_node_id', '')::uuid;
    v_primary_concept_id := nullif(v_row->>'primary_concept_id', '')::uuid;
    v_evidence_kind := nullif(v_row->>'evidence_kind', '');

    insert into public.canonical_questions(status, review_notes)
    values ('candidate', null)
    returning id into v_canonical_question_id;

    insert into public.canonical_question_versions(
      canonical_question_id, question_id, version_sequence, version_label,
      content_sha256, link_method
    )
    select v_canonical_question_id, q.id, 1, null,
      coalesce(payload.content_sha256, md5(coalesce(q.question_text, '') || '|' || coalesce(q.correct_answer, ''))),
      'classifier_batch'
    from public.questions q
    left join public.qbank_question_payloads payload on payload.question_id = q.id
    where q.id = (v_row->>'question_id')::uuid;

    if v_primary_node_id is not null then
      insert into public.canonical_question_taxonomy_assignments(
        canonical_question_id, taxonomy_version_id, taxonomy_node_id,
        is_primary, is_current, assignment_method, confidence,
        classification_run_id, source_test_prior_used, ambiguity_state,
        review_state, evidence_retained
      ) values (
        v_canonical_question_id, v_version_id, v_primary_node_id,
        true, true, 'model', (v_row->>'confidence')::numeric,
        v_run_id, coalesce((v_row->>'source_test_prior_used')::boolean, false),
        coalesce((v_row->>'ambiguity_state')::smallint, 0), 0,
        v_evidence_kind is not null
      );
    end if;
    if v_primary_concept_id is not null then
      insert into public.canonical_question_concept_assignments(
        canonical_question_id, taxonomy_version_id, canonical_concept_id,
        is_primary, is_current, assignment_method, confidence,
        provenance, classification_run_id
      ) values (
        v_canonical_question_id, v_version_id, v_primary_concept_id,
        true, true, 'model', (v_row->>'concept_confidence')::numeric,
        '{}'::jsonb, v_run_id
      );
    end if;

    for v_secondary in select value from jsonb_array_elements(coalesce(v_row->'secondaries', '[]'::jsonb))
    loop
      if not coalesce((v_secondary->>'medically_meaningful')::boolean, false) then
        raise exception 'Secondary paths require medically_meaningful=true';
      end if;
      if (v_secondary->>'node_id')::uuid = v_primary_node_id then
        raise exception 'Secondary path duplicates its primary path';
      end if;
      insert into public.canonical_question_taxonomy_assignments(
        canonical_question_id, taxonomy_version_id, taxonomy_node_id,
        is_primary, is_current, assignment_method, confidence,
        classification_run_id, source_test_prior_used, ambiguity_state,
        review_state, evidence_retained
      ) values (
        v_canonical_question_id, v_version_id, (v_secondary->>'node_id')::uuid,
        false, true, 'model', (v_secondary->>'confidence')::numeric,
        v_run_id, false, 2, 0, true
      );
      if nullif(v_secondary->>'concept_id', '') is not null then
        insert into public.canonical_question_concept_assignments(
          canonical_question_id, taxonomy_version_id, canonical_concept_id,
          is_primary, is_current, assignment_method, confidence,
          provenance, classification_run_id
        ) values (
          v_canonical_question_id, v_version_id, (v_secondary->>'concept_id')::uuid,
          false, true, 'model', (v_secondary->>'confidence')::numeric,
          '{}'::jsonb, v_run_id
        );
      end if;
    end loop;

    if v_evidence_kind is not null then
      if v_evidence_kind not in ('low_confidence', 'ambiguous', 'content_override', 'human_review') then
        raise exception 'Invalid sparse evidence kind';
      end if;
      insert into public.canonical_assignment_review_evidence(
        canonical_question_id, taxonomy_version_id, classification_run_id,
        evidence_kind, evidence, review_state, evidence_sha256
      ) values (
        v_canonical_question_id, v_version_id, v_run_id, v_evidence_kind,
        coalesce(v_row->'evidence', '{}'::jsonb), 0,
        md5(coalesce(v_row->'evidence', '{}'::jsonb)::text)
      );
    end if;
  end loop;

  if (select count(*) from public.questions) <> v_questions_before
     or (select count(*) from public.question_options) <> v_options_before
     or (select count(*) from public.qbank_source_occurrences) <> v_occurrences_before
     or (select count(*) from public.question_attempts) <> v_attempts_before
     or (select count(*) from public.test_sessions) <> v_sessions_before
     or (select count(*) from public.user_question_state) <> v_state_before then
    raise exception 'Protected source or learner data changed during classification';
  end if;
  if (select count(*) from public.canonical_question_versions) <> v_versions_before + 1000 then
    raise exception 'Exactly 1000 canonical version links were not created';
  end if;
  if (select count(*) from public.canonical_question_taxonomy_assignments where is_current and is_primary)
      <> v_primary_before + coalesce((p_summary->>'topic_resolved')::integer, 0) then
    raise exception 'Primary assignment count does not match resolved batch summary';
  end if;

  return jsonb_build_object(
    'processed', 1000,
    'run_id', v_run_id,
    'primary_assignments', (select count(*) from public.canonical_question_taxonomy_assignments where classification_run_id = v_run_id and is_primary),
    'secondary_paths', (select count(*) from public.canonical_question_taxonomy_assignments where classification_run_id = v_run_id and not is_primary),
    'concept_assignments', (select count(*) from public.canonical_question_concept_assignments where classification_run_id = v_run_id),
    'sparse_evidence', (select count(*) from public.canonical_assignment_review_evidence where classification_run_id = v_run_id)
  );
end;
$$;

revoke all on function public.qbank_commit_canonical_classification_batch(text,text,text,text,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.qbank_commit_canonical_classification_batch(text,text,text,text,jsonb,jsonb)
  to service_role;

comment on function public.qbank_commit_canonical_classification_batch(text,text,text,text,jsonb,jsonb) is
  'Service-only transactional gate for one exactly 1000-question compact canonical classification batch.';

notify pgrst, 'reload schema';
