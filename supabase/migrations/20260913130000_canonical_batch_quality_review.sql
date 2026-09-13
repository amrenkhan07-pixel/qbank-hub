-- Intent-aware reclassification and isolated review workflow for the exact
-- existing 1,000-question PrepLadder cohort. Additive/versioned only.

alter table public.canonical_question_taxonomy_assignments
  add column if not exists intent_state smallint not null default 0,
  add column if not exists evidence_flags smallint not null default 0,
  add column if not exists source_test_id uuid references public.qbank_source_tests(id) on delete restrict;

alter table public.canonical_question_taxonomy_assignments
  drop constraint if exists canonical_taxonomy_assignment_intent_state_check,
  add constraint canonical_taxonomy_assignment_intent_state_check check (intent_state in (0,1)),
  drop constraint if exists canonical_taxonomy_assignment_evidence_flags_check,
  add constraint canonical_taxonomy_assignment_evidence_flags_check check (evidence_flags between 0 and 63);

create index if not exists canonical_taxonomy_assignment_source_test_idx
  on public.canonical_question_taxonomy_assignments(source_test_id)
  where source_test_id is not null;

alter table public.canonical_question_versions
  add column if not exists review_search tsvector;
create index if not exists canonical_question_versions_review_search_idx
  on public.canonical_question_versions using gin(review_search)
  where review_search is not null;

alter table public.canonical_taxonomy_draft_reviews
  add column if not exists review_scope text not null default 'draft-sample',
  add column if not exists corrected_concept_id uuid,
  add column if not exists secondary_concept_id uuid;
alter table public.canonical_taxonomy_draft_reviews
  drop constraint if exists canonical_taxonomy_draft_reviews_corrected_concept_fk,
  add constraint canonical_taxonomy_draft_reviews_corrected_concept_fk
    foreign key(corrected_concept_id,taxonomy_version_id)
    references public.canonical_medical_concepts(id,taxonomy_version_id) on delete restrict,
  drop constraint if exists canonical_taxonomy_draft_reviews_secondary_concept_fk,
  add constraint canonical_taxonomy_draft_reviews_secondary_concept_fk
    foreign key(secondary_concept_id,taxonomy_version_id)
    references public.canonical_medical_concepts(id,taxonomy_version_id) on delete restrict;
create index if not exists canonical_taxonomy_draft_reviews_corrected_concept_idx
  on public.canonical_taxonomy_draft_reviews(corrected_concept_id,taxonomy_version_id)
  where corrected_concept_id is not null;
create index if not exists canonical_taxonomy_draft_reviews_secondary_concept_idx
  on public.canonical_taxonomy_draft_reviews(secondary_concept_id,taxonomy_version_id)
  where secondary_concept_id is not null;

create or replace function public.qbank_validate_taxonomy_draft_review()
returns trigger language plpgsql security invoker set search_path=''
as $$
declare
  subject_type text; system_parent uuid; topic_parent uuid; subtopic_parent uuid;
  secondary_version uuid; corrected_concept_node uuid; secondary_concept_version uuid;
begin
  if new.decision='accepted' and new.proposed_node_id is null then raise exception 'Accepted reviews require a proposed canonical node'; end if;
  if new.decision='needs_correction' then
    select node_type into subject_type from public.canonical_taxonomy_nodes where id=new.corrected_subject_id and taxonomy_version_id=new.taxonomy_version_id;
    if subject_type is distinct from 'subject' then raise exception 'Corrected subject is invalid'; end if;
    if new.corrected_system_id is not null then
      select parent_id into system_parent from public.canonical_taxonomy_nodes where id=new.corrected_system_id and taxonomy_version_id=new.taxonomy_version_id and node_type='system';
      if system_parent is distinct from new.corrected_subject_id then raise exception 'Corrected system is outside the selected subject'; end if;
    end if;
    select parent_id into topic_parent from public.canonical_taxonomy_nodes where id=new.corrected_topic_id and taxonomy_version_id=new.taxonomy_version_id and node_type='topic';
    if topic_parent is null or topic_parent is distinct from coalesce(new.corrected_system_id,new.corrected_subject_id) then raise exception 'Corrected topic is outside the selected subject/system'; end if;
    if new.corrected_subtopic_id is not null then
      select parent_id into subtopic_parent from public.canonical_taxonomy_nodes where id=new.corrected_subtopic_id and taxonomy_version_id=new.taxonomy_version_id and node_type='subtopic';
      if subtopic_parent is distinct from new.corrected_topic_id then raise exception 'Corrected subtopic is outside the selected topic'; end if;
    end if;
    if new.corrected_concept_id is not null then
      select taxonomy_node_id into corrected_concept_node from public.canonical_medical_concepts
      where id=new.corrected_concept_id and taxonomy_version_id=new.taxonomy_version_id;
      if corrected_concept_node is null or corrected_concept_node is distinct from coalesce(new.corrected_subtopic_id,new.corrected_topic_id) then
        raise exception 'Corrected concept is outside the corrected canonical path';
      end if;
    end if;
  elsif new.corrected_concept_id is not null then
    raise exception 'Corrected concept requires needs_correction';
  end if;
  if new.secondary_node_id is not null then
    select taxonomy_version_id into secondary_version from public.canonical_taxonomy_nodes where id=new.secondary_node_id;
    if secondary_version is distinct from new.taxonomy_version_id then raise exception 'Secondary path is outside this taxonomy version'; end if;
  end if;
  if new.secondary_concept_id is not null then
    select taxonomy_version_id into secondary_concept_version from public.canonical_medical_concepts where id=new.secondary_concept_id;
    if secondary_concept_version is distinct from new.taxonomy_version_id then raise exception 'Secondary concept is outside this taxonomy version'; end if;
  end if;
  new.updated_at=now(); new.reviewed_at=now(); return new;
end;
$$;
revoke all on function public.qbank_validate_taxonomy_draft_review() from public,anon,authenticated;

create or replace function public.qbank_reclassify_canonical_batch_v2(
  p_taxonomy_version_key text,
  p_source_scope_key text,
  p_new_scope_key text,
  p_classifier_version text,
  p_configuration_sha256 text,
  p_batch jsonb,
  p_summary jsonb
) returns jsonb
language plpgsql security invoker set search_path=''
as $$
declare
  v_version_id uuid; v_source_run_id uuid; v_run_id uuid; v_row jsonb; v_secondary jsonb;
  v_canonical_question_id uuid; v_primary_node_id uuid; v_primary_concept_id uuid; v_evidence_kind text;
  v_questions_before bigint; v_options_before bigint; v_occurrences_before bigint;
  v_attempts_before bigint; v_sessions_before bigint; v_state_before bigint;
begin
  if current_user not in ('service_role','postgres') then raise exception 'Service role required'; end if;
  if jsonb_typeof(p_batch)<>'array' or jsonb_array_length(p_batch)<>1000 then raise exception 'Batch must contain exactly 1000 questions'; end if;
  if (select count(distinct (item->>'question_id')::uuid) from jsonb_array_elements(p_batch) item)<>1000 then raise exception 'Batch question IDs must be unique'; end if;
  if exists(select 1 from jsonb_array_elements(p_batch) item where item ?| array['stem','stem_text','question_text','options','explanation','explanation_html','media']) then
    raise exception 'Persistent classification payload must not copy source content';
  end if;
  if jsonb_typeof(coalesce(p_summary,'{}'))<>'object' or p_summary ?| array['question_ids','questions','stems','options','explanations'] then
    raise exception 'Run summary must contain aggregate metrics only';
  end if;
  select id into v_version_id from public.canonical_taxonomy_versions where version_key=p_taxonomy_version_key and status='draft';
  select id into v_source_run_id from public.canonical_classification_runs where taxonomy_version_id=v_version_id and scope_key=p_source_scope_key and status='completed';
  if v_version_id is null or v_source_run_id is null then raise exception 'Draft taxonomy or source cohort run is missing'; end if;
  perform pg_advisory_xact_lock(hashtext('qbank-canonical-classification-v1'));
  if (select count(*) from public.canonical_question_versions where link_method='classifier_batch')<>1000 then raise exception 'Committed classifier cohort is no longer exactly 1000'; end if;
  if exists(
    (select question_id from public.canonical_question_versions where link_method='classifier_batch'
     except select (item->>'question_id')::uuid from jsonb_array_elements(p_batch) item)
    union all
    (select (item->>'question_id')::uuid from jsonb_array_elements(p_batch) item
     except select question_id from public.canonical_question_versions where link_method='classifier_batch')
  ) then raise exception 'Reclassification IDs differ from the committed 1000-question cohort'; end if;
  if exists(
    select 1 from jsonb_array_elements(p_batch) item
    join public.questions q on q.id=(item->>'question_id')::uuid
    join public.subjects s on s.id=q.subject_id
    left join public.canonical_taxonomy_nodes n on n.id=nullif(item->>'primary_node_id','')::uuid and n.taxonomy_version_id=v_version_id
    where not q.is_usable or (n.id is not null and n.metadata->>'subject' is distinct from s.name)
  ) then raise exception 'Reclassification includes unusable or cross-subject paths'; end if;

  select count(*) into v_questions_before from public.questions;
  select count(*) into v_options_before from public.question_options;
  select count(*) into v_occurrences_before from public.qbank_source_occurrences;
  select count(*) into v_attempts_before from public.question_attempts;
  select count(*) into v_sessions_before from public.test_sessions;
  select count(*) into v_state_before from public.user_question_state;

  insert into public.canonical_classification_runs(
    taxonomy_version_id,scope_key,scope_type,classifier_name,classifier_version,
    assignment_method,status,configuration_sha256,summary,completed_at
  ) values (
    v_version_id,p_new_scope_key,'batch','qbank-canonical-classifier',p_classifier_version,
    'model','completed',p_configuration_sha256,p_summary,now()
  ) returning id into v_run_id;

  for v_row in select value from jsonb_array_elements(p_batch)
  loop
    select canonical_question_id into v_canonical_question_id
    from public.canonical_question_versions
    where question_id=(v_row->>'question_id')::uuid and link_method='classifier_batch';
    if v_canonical_question_id is null then raise exception 'Canonical cohort identity missing'; end if;
    v_primary_node_id:=nullif(v_row->>'primary_node_id','')::uuid;
    v_primary_concept_id:=nullif(v_row->>'primary_concept_id','')::uuid;
    v_evidence_kind:=nullif(v_row->>'evidence_kind','');

    update public.canonical_question_versions
    set review_search=to_tsvector('simple',coalesce(v_row->>'review_search_text',''))
    where canonical_question_id=v_canonical_question_id and question_id=(v_row->>'question_id')::uuid;
    update public.canonical_question_taxonomy_assignments set is_current=false
    where canonical_question_id=v_canonical_question_id and taxonomy_version_id=v_version_id and is_current;
    update public.canonical_question_concept_assignments set is_current=false
    where canonical_question_id=v_canonical_question_id and taxonomy_version_id=v_version_id and is_current;

    if v_primary_node_id is not null then
      insert into public.canonical_question_taxonomy_assignments(
        canonical_question_id,taxonomy_version_id,taxonomy_node_id,is_primary,is_current,
        assignment_method,confidence,classification_run_id,source_test_prior_used,
        ambiguity_state,review_state,evidence_retained,intent_state,evidence_flags,source_test_id
      ) values (
        v_canonical_question_id,v_version_id,v_primary_node_id,true,true,'model',
        (v_row->>'confidence')::numeric,v_run_id,coalesce((v_row->>'source_test_prior_used')::boolean,false),
        coalesce((v_row->>'ambiguity_state')::smallint,0),0,v_evidence_kind is not null,
        coalesce((v_row->>'intent_state')::smallint,0),coalesce((v_row->>'evidence_flags')::smallint,0),
        nullif(v_row->>'source_test_id','')::uuid
      );
    end if;
    if v_primary_concept_id is not null then
      insert into public.canonical_question_concept_assignments(
        canonical_question_id,taxonomy_version_id,canonical_concept_id,is_primary,is_current,
        assignment_method,confidence,provenance,classification_run_id
      ) values (
        v_canonical_question_id,v_version_id,v_primary_concept_id,true,true,'model',
        (v_row->>'concept_confidence')::numeric,'{}',v_run_id
      );
    end if;
    for v_secondary in select value from jsonb_array_elements(coalesce(v_row->'secondaries','[]'))
    loop
      if not coalesce((v_secondary->>'medically_meaningful')::boolean,false) then raise exception 'Secondary paths require medical review'; end if;
      if (v_secondary->>'node_id')::uuid=v_primary_node_id then raise exception 'Secondary path duplicates primary'; end if;
      insert into public.canonical_question_taxonomy_assignments(
        canonical_question_id,taxonomy_version_id,taxonomy_node_id,is_primary,is_current,
        assignment_method,confidence,classification_run_id,source_test_prior_used,
        ambiguity_state,review_state,evidence_retained,intent_state,evidence_flags,source_test_id
      ) values (
        v_canonical_question_id,v_version_id,(v_secondary->>'node_id')::uuid,false,true,'model',
        (v_secondary->>'confidence')::numeric,v_run_id,false,2,0,true,
        coalesce((v_row->>'intent_state')::smallint,0),coalesce((v_row->>'evidence_flags')::smallint,0),
        nullif(v_row->>'source_test_id','')::uuid
      );
      if nullif(v_secondary->>'concept_id','') is not null then
        insert into public.canonical_question_concept_assignments(
          canonical_question_id,taxonomy_version_id,canonical_concept_id,is_primary,is_current,
          assignment_method,confidence,provenance,classification_run_id
        ) values (
          v_canonical_question_id,v_version_id,(v_secondary->>'concept_id')::uuid,false,true,'model',
          (v_secondary->>'confidence')::numeric,'{}',v_run_id
        );
      end if;
    end loop;
    if v_evidence_kind is not null then
      insert into public.canonical_assignment_review_evidence(
        canonical_question_id,taxonomy_version_id,classification_run_id,evidence_kind,
        evidence,review_state,evidence_sha256
      ) values (
        v_canonical_question_id,v_version_id,v_run_id,v_evidence_kind,
        coalesce(v_row->'evidence','{}'),0,md5(coalesce(v_row->'evidence','{}')::text)
      );
    end if;
  end loop;

  if (select count(*) from public.questions)<>v_questions_before
     or (select count(*) from public.question_options)<>v_options_before
     or (select count(*) from public.qbank_source_occurrences)<>v_occurrences_before
     or (select count(*) from public.question_attempts)<>v_attempts_before
     or (select count(*) from public.test_sessions)<>v_sessions_before
     or (select count(*) from public.user_question_state)<>v_state_before then
    raise exception 'Protected source or learner data changed';
  end if;
  if (select count(*) from public.canonical_question_taxonomy_assignments where classification_run_id=v_run_id and is_primary)
      <>coalesce((p_summary->>'topic_resolved')::integer,0) then raise exception 'Primary assignment total mismatch'; end if;
  return jsonb_build_object(
    'processed',1000,'run_id',v_run_id,
    'primary_assignments',(select count(*) from public.canonical_question_taxonomy_assignments where classification_run_id=v_run_id and is_primary),
    'secondary_paths',(select count(*) from public.canonical_question_taxonomy_assignments where classification_run_id=v_run_id and not is_primary),
    'concept_assignments',(select count(*) from public.canonical_question_concept_assignments where classification_run_id=v_run_id),
    'sparse_evidence',(select count(*) from public.canonical_assignment_review_evidence where classification_run_id=v_run_id)
  );
end;
$$;
revoke all on function public.qbank_reclassify_canonical_batch_v2(text,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.qbank_reclassify_canonical_batch_v2(text,text,text,text,text,jsonb,jsonb) to service_role;

create or replace function public.qbank_canonical_batch_review_overview(
  p_version_key text default 'canonical-medical-v1'
) returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare result jsonb; version_uuid uuid;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  select id into version_uuid from public.canonical_taxonomy_versions where version_key=p_version_key and status='draft';
  select jsonb_build_object(
    'version',jsonb_build_object('id',v.id,'key',v.version_key,'name',v.name,'status',v.status),
    'counts',coalesce((select jsonb_object_agg(node_type,cnt) from (select node_type,count(*) cnt from public.canonical_taxonomy_nodes where taxonomy_version_id=v.id group by node_type) grouped),'{}'),
    'sample_total',1000,
    'reviewed',(select count(*) from public.canonical_taxonomy_draft_reviews r where r.taxonomy_version_id=v.id and r.reviewer_id=(select auth.uid()) and r.review_scope='batch-1000-v2'),
    'metrics',jsonb_build_object(
      'high',(select count(*) from public.canonical_question_taxonomy_assignments a join public.canonical_question_versions cv on cv.canonical_question_id=a.canonical_question_id where cv.link_method='classifier_batch' and a.taxonomy_version_id=v.id and a.is_current and a.is_primary and a.confidence>=.8),
      'ambiguous',(select count(*) from public.canonical_question_taxonomy_assignments a join public.canonical_question_versions cv on cv.canonical_question_id=a.canonical_question_id where cv.link_method='classifier_batch' and a.taxonomy_version_id=v.id and a.is_current and a.is_primary and a.ambiguity_state>0),
      'unclassifiable',(select count(*) from public.canonical_question_versions cv where cv.link_method='classifier_batch' and not exists(select 1 from public.canonical_question_taxonomy_assignments a where a.canonical_question_id=cv.canonical_question_id and a.taxonomy_version_id=v.id and a.is_current and a.is_primary)),
      'negative',(select count(*) from public.canonical_question_taxonomy_assignments a join public.canonical_question_versions cv on cv.canonical_question_id=a.canonical_question_id where cv.link_method='classifier_batch' and a.taxonomy_version_id=v.id and a.is_current and a.is_primary and a.intent_state=1)
    ),
    'subjects',(select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'name',n.name) order by n.sort_order,n.name),'[]') from public.canonical_taxonomy_nodes n where n.taxonomy_version_id=v.id and n.node_type='subject')
  ) into result from public.canonical_taxonomy_versions v where v.id=version_uuid;
  return result;
end;
$$;

create or replace function public.qbank_canonical_batch_review_page(
  p_version_key text default 'canonical-medical-v1',p_page integer default 1,p_page_size integer default 25,
  p_subject text default null,p_confidence text default null,p_review_state text default null,p_search text default null,
  p_unresolved boolean default null,p_negative boolean default null,p_content_override boolean default null,p_pyq boolean default null
) returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare result jsonb; version_uuid uuid; page_size integer:=least(greatest(p_page_size,25),50);
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  select id into version_uuid from public.canonical_taxonomy_versions where version_key=p_version_key and status='draft';
  with cohort as (
    select cv.question_id,cv.canonical_question_id,
      'Q-'||upper(substr(replace(cv.question_id::text,'-',''),1,8)) friendly_id,
      platform.name platform,subject.name existing_subject,st.id source_test_id,st.title source_test,
      coalesce(occ.is_pyq,st.is_pyq,false) is_pyq,occ.question_position,
      a.taxonomy_node_id proposed_node_id,n.metadata->>'system' proposed_system,
      coalesce(n.metadata->>'topic',case when n.node_type='topic' then n.name end) proposed_topic,
      n.metadata->>'subtopic' proposed_subtopic,n.metadata->>'path' proposed_path,
      c.id proposed_concept_id,c.canonical_name proposed_concept,
      prior_node.name source_evidence_topic,
      case when c.id is not null then n.metadata->>'path'||' → '||c.canonical_name else n.metadata->>'path' end proposed_concept_path,
      coalesce(a.confidence,0) classifier_confidence,coalesce(ca.confidence,0) concept_confidence,
      coalesce(a.intent_state,0)=1 negative_question,coalesce(a.evidence_flags,0) evidence_flags,
      coalesce(a.source_test_prior_used,false) source_topic_supported,
      (coalesce(a.evidence_flags,0)&32)<>0 content_override,
      case when a.taxonomy_node_id is null then 'unclassifiable' when (coalesce(a.evidence_flags,0)&32)<>0 then 'content_override' when a.source_test_prior_used then 'source_test_supported' else 'content_only' end classification_basis,
      case when n.node_type='subtopic' and c.id is not null then 'concept' when n.node_type='subtopic' then 'subtopic' when n.node_type='topic' then 'topic' else 'unclassifiable' end classification_level,
      coalesce(a.ambiguity_state,0)>0 ambiguity,
      false cross_subject_ambiguity,
      case when a.taxonomy_node_id is null then 'No medically defensible canonical path.'
        when (coalesce(a.evidence_flags,0)&32)<>0 then 'Question intent and positive explanation overrode the Source-Test Topic.'
        when n.node_type='subtopic' then 'Topic supported by Source Test; Subtopic inferred from question intent and positive evidence.'
        else 'Source Test supports the Topic; evidence did not justify a narrower Subtopic.' end reason,
      jsonb_build_object('subject_prior',true,'source_topic',coalesce(a.source_test_prior_used,false),
        'stem',(coalesce(a.evidence_flags,0)&2)<>0,'correct_answer',(coalesce(a.evidence_flags,0)&4)<>0,
        'explanation_positive',(coalesce(a.evidence_flags,0)&8)<>0,'options_for_negative',(coalesce(a.evidence_flags,0)&16)<>0) evidence_usage,
      r.decision review_decision,r.corrected_subject_id,r.corrected_system_id,r.corrected_topic_id,r.corrected_subtopic_id,
      r.corrected_concept_id,r.secondary_node_id,r.secondary_concept_id,r.reviewer_note,r.reviewed_at,
      coalesce(corrected_concept.metadata->>'canonical_path',corrected_sub.metadata->>'path',corrected_topic.metadata->>'path') corrected_path,
      coalesce(secondary_concept.metadata->>'canonical_path',secondary_node.metadata->>'path') secondary_path,
      secondary_concept.canonical_name secondary_concept,
      cv.review_search
    from public.canonical_question_versions cv
    join public.questions q on q.id=cv.question_id
    join public.platforms platform on platform.id=q.platform_id
    join public.subjects subject on subject.id=q.subject_id
    left join public.canonical_question_taxonomy_assignments a on a.canonical_question_id=cv.canonical_question_id and a.taxonomy_version_id=version_uuid and a.is_current and a.is_primary
    left join public.canonical_taxonomy_nodes n on n.id=a.taxonomy_node_id and n.taxonomy_version_id=version_uuid
    left join public.canonical_question_concept_assignments ca on ca.canonical_question_id=cv.canonical_question_id and ca.taxonomy_version_id=version_uuid and ca.is_current and ca.is_primary
    left join public.canonical_medical_concepts c on c.id=ca.canonical_concept_id and c.taxonomy_version_id=version_uuid
    left join lateral(select o.* from public.qbank_source_occurrences o where o.question_id=cv.question_id and o.is_current and (a.source_test_id is null or o.source_test_id=a.source_test_id) order by o.question_position limit 1) occ on true
    left join public.qbank_source_tests st on st.id=coalesce(a.source_test_id,occ.source_test_id)
    left join public.canonical_source_test_topic_assignments prior_assignment on prior_assignment.source_test_id=st.id and prior_assignment.taxonomy_version_id=version_uuid and prior_assignment.is_current and prior_assignment.is_primary
    left join public.canonical_taxonomy_nodes prior_node on prior_node.id=prior_assignment.topic_node_id and prior_node.taxonomy_version_id=version_uuid
    left join public.canonical_taxonomy_draft_reviews r on r.taxonomy_version_id=version_uuid and r.question_id=cv.question_id and r.reviewer_id=(select auth.uid()) and r.review_scope='batch-1000-v2'
    left join public.canonical_taxonomy_nodes corrected_sub on corrected_sub.id=r.corrected_subtopic_id
    left join public.canonical_taxonomy_nodes corrected_topic on corrected_topic.id=r.corrected_topic_id
    left join public.canonical_medical_concepts corrected_concept on corrected_concept.id=r.corrected_concept_id
    left join public.canonical_taxonomy_nodes secondary_node on secondary_node.id=r.secondary_node_id
    left join public.canonical_medical_concepts secondary_concept on secondary_concept.id=r.secondary_concept_id
    where cv.link_method='classifier_batch'
  ), filtered as (
    select * from cohort b where
      (nullif(p_subject,'') is null or b.existing_subject=p_subject)
      and (nullif(p_confidence,'') is null or case when b.classifier_confidence>=.8 then 'high' when b.classifier_confidence>=.65 then 'medium' else 'low' end=p_confidence)
      and (nullif(p_review_state,'') is null or (p_review_state='unreviewed' and b.review_decision is null) or b.review_decision=p_review_state)
      and (p_unresolved is null or (b.proposed_node_id is null)=p_unresolved)
      and (p_negative is null or b.negative_question=p_negative)
      and (p_content_override is null or b.content_override=p_content_override)
      and (p_pyq is null or b.is_pyq=p_pyq)
      and (nullif(trim(p_search),'') is null or b.question_id::text=trim(p_search) or upper(b.friendly_id)=upper(trim(p_search))
        or b.source_test ilike '%'||trim(p_search)||'%'
        or b.review_search @@ websearch_to_tsquery('simple',trim(p_search)))
  ), paged as (
    select * from filtered order by existing_subject,question_id
    offset (greatest(p_page,1)-1)*page_size limit page_size
  )
  select jsonb_build_object(
    'page',greatest(p_page,1),'page_size',page_size,'total',(select count(*) from filtered),
    'sample_total',1000,'reviewed',(select count(*) from cohort where review_decision is not null),
    'items',coalesce((select jsonb_agg(to_jsonb(p)-'review_search' order by existing_subject,question_id) from paged p),'[]')
  ) into result;
  return result;
end;
$$;

create or replace function public.qbank_save_canonical_batch_review(
  p_version_key text,p_question_id uuid,p_decision text,p_proposed_node_id uuid default null,
  p_corrected_subject_id uuid default null,p_corrected_system_id uuid default null,p_corrected_topic_id uuid default null,
  p_corrected_subtopic_id uuid default null,p_corrected_concept_id uuid default null,p_secondary_node_id uuid default null,
  p_secondary_concept_id uuid default null,p_reviewer_note text default null,p_proposal_snapshot jsonb default '{}'
) returns public.canonical_taxonomy_draft_reviews language plpgsql security invoker set search_path=''
as $$
declare version_uuid uuid; saved public.canonical_taxonomy_draft_reviews;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  select id into version_uuid from public.canonical_taxonomy_versions where version_key=p_version_key and status='draft';
  if not exists(select 1 from public.canonical_question_versions where question_id=p_question_id and link_method='classifier_batch') then raise exception 'Question is outside the exact batch cohort'; end if;
  insert into public.canonical_taxonomy_draft_reviews(
    taxonomy_version_id,question_id,reviewer_id,decision,proposed_node_id,corrected_subject_id,
    corrected_system_id,corrected_topic_id,corrected_subtopic_id,corrected_concept_id,
    secondary_node_id,secondary_concept_id,reviewer_note,proposal_snapshot,review_scope
  ) values (
    version_uuid,p_question_id,(select auth.uid()),p_decision,p_proposed_node_id,p_corrected_subject_id,
    p_corrected_system_id,p_corrected_topic_id,p_corrected_subtopic_id,p_corrected_concept_id,
    p_secondary_node_id,p_secondary_concept_id,nullif(trim(p_reviewer_note),''),coalesce(p_proposal_snapshot,'{}'),'batch-1000-v2'
  ) on conflict(taxonomy_version_id,question_id,reviewer_id) do update set
    decision=excluded.decision,proposed_node_id=excluded.proposed_node_id,corrected_subject_id=excluded.corrected_subject_id,
    corrected_system_id=excluded.corrected_system_id,corrected_topic_id=excluded.corrected_topic_id,
    corrected_subtopic_id=excluded.corrected_subtopic_id,corrected_concept_id=excluded.corrected_concept_id,
    secondary_node_id=excluded.secondary_node_id,secondary_concept_id=excluded.secondary_concept_id,
    reviewer_note=excluded.reviewer_note,proposal_snapshot=excluded.proposal_snapshot,review_scope=excluded.review_scope
  returning * into saved;
  return saved;
end;
$$;

create or replace function public.qbank_canonical_concepts_for_node(
  p_version_key text,p_node_id uuid
) returns table(id uuid,name text,path text)
language sql stable security definer set search_path=''
as $$
select c.id,c.canonical_name,coalesce(c.metadata->>'canonical_path',n.metadata->>'path'||' → '||c.canonical_name)
from public.canonical_medical_concepts c
join public.canonical_taxonomy_versions v on v.id=c.taxonomy_version_id
join public.canonical_taxonomy_nodes n on n.id=c.taxonomy_node_id and n.taxonomy_version_id=c.taxonomy_version_id
where (select auth.uid()) is not null and v.version_key=p_version_key and c.taxonomy_node_id=p_node_id
order by c.canonical_name limit 100;
$$;

create or replace function public.qbank_canonical_concept_search(
  p_version_key text,p_search text,p_limit integer default 25
) returns table(id uuid,node_id uuid,name text,path text)
language sql stable security definer set search_path=''
as $$
select c.id,c.taxonomy_node_id,c.canonical_name,coalesce(c.metadata->>'canonical_path',n.metadata->>'path'||' → '||c.canonical_name)
from public.canonical_medical_concepts c
join public.canonical_taxonomy_versions v on v.id=c.taxonomy_version_id
join public.canonical_taxonomy_nodes n on n.id=c.taxonomy_node_id and n.taxonomy_version_id=c.taxonomy_version_id
where (select auth.uid()) is not null and v.version_key=p_version_key and length(trim(coalesce(p_search,'')))>=2
  and (c.canonical_name ilike '%'||trim(p_search)||'%' or exists(select 1 from unnest(c.aliases) alias where alias ilike '%'||trim(p_search)||'%'))
order by case when lower(c.canonical_name)=lower(trim(p_search)) then 0 else 1 end,c.canonical_name
limit least(greatest(p_limit,1),25);
$$;

revoke all on function public.qbank_canonical_batch_review_overview(text) from public,anon;
revoke all on function public.qbank_canonical_batch_review_page(text,integer,integer,text,text,text,text,boolean,boolean,boolean,boolean) from public,anon;
revoke all on function public.qbank_save_canonical_batch_review(text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb) from public,anon;
revoke all on function public.qbank_canonical_concepts_for_node(text,uuid) from public,anon;
revoke all on function public.qbank_canonical_concept_search(text,text,integer) from public,anon;
grant execute on function public.qbank_canonical_batch_review_overview(text) to authenticated;
grant execute on function public.qbank_canonical_batch_review_page(text,integer,integer,text,text,text,text,boolean,boolean,boolean,boolean) to authenticated;
grant execute on function public.qbank_save_canonical_batch_review(text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb) to authenticated;
grant execute on function public.qbank_canonical_concepts_for_node(text,uuid) to authenticated;
grant execute on function public.qbank_canonical_concept_search(text,text,integer) to authenticated;

notify pgrst,'reload schema';
