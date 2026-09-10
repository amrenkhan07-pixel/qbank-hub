-- Canonical Taxonomy v1 positive-evidence classifier foundation.
-- Additive and draft-only: no production taxonomy assignments, source content,
-- source occurrences, or learner state are changed.

do $$
declare version_uuid uuid; topic_uuid uuid;
begin
  select id into version_uuid from public.canonical_taxonomy_versions
  where version_key='canonical-medical-v1' and status='draft';
  if version_uuid is null then raise exception 'Canonical Taxonomy v1 draft is missing'; end if;
  select id into topic_uuid from public.canonical_taxonomy_nodes
  where taxonomy_version_id=version_uuid and stable_code='subject.pathology.topic.red-cell-disorders';
  if topic_uuid is null then raise exception 'Pathology Red Cell Disorders topic is missing'; end if;
  insert into public.canonical_taxonomy_nodes(
    taxonomy_version_id,parent_id,node_type,stable_code,name,description,sort_order,metadata
  ) values (
    version_uuid,topic_uuid,'subtopic','subject.pathology.topic.red-cell-disorders.subtopic.hemoglobinopathies',
    'Hemoglobinopathies','Inherited disorders of hemoglobin structure or synthesis, including sickle cell disease and thalassemia.',5,
    jsonb_build_object('path','Pathology → Hematolymphoid System → Red Cell Disorders → Hemoglobinopathies',
      'subject','Pathology','system','Hematolymphoid System','topic','Red Cell Disorders','subtopic','Hemoglobinopathies','review_status','draft')
  ) on conflict (taxonomy_version_id,stable_code) do update set
    name=excluded.name,description=excluded.description,metadata=excluded.metadata;
end $$;

create table if not exists public.canonical_medical_concepts(
  id uuid primary key default gen_random_uuid(),
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  taxonomy_node_id uuid not null,
  parent_concept_id uuid references public.canonical_medical_concepts(id) on delete restrict,
  stable_code text not null,
  subject_name text not null,
  canonical_name text not null,
  aliases text[] not null default '{}',
  provenance text not null default 'canonical_subtopic',
  status text not null default 'draft' check(status in ('draft','reviewed','published','retired')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(taxonomy_node_id,taxonomy_version_id)
    references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  unique(id,taxonomy_version_id),
  unique(taxonomy_version_id,stable_code),
  unique(taxonomy_version_id,subject_name,canonical_name)
);
comment on table public.canonical_medical_concepts is
  'Versioned draft vocabulary beneath stable taxonomy nodes. Aliases support classification without creating excessively granular hierarchy nodes.';
create index if not exists canonical_medical_concepts_node_idx
  on public.canonical_medical_concepts(taxonomy_node_id,taxonomy_version_id);
create index if not exists canonical_medical_concepts_parent_idx
  on public.canonical_medical_concepts(parent_concept_id) where parent_concept_id is not null;

insert into public.canonical_medical_concepts(
  taxonomy_version_id,taxonomy_node_id,stable_code,subject_name,canonical_name,aliases,provenance,metadata
)
select n.taxonomy_version_id,n.id,'concept.'||n.stable_code,n.metadata->>'subject',n.name,
  array(select distinct phrase from (
    select n.name phrase union all
    select r.match_phrase from public.canonical_taxonomy_draft_rules r
    where r.taxonomy_version_id=n.taxonomy_version_id and r.taxonomy_node_id=n.id and r.enabled
  ) names where nullif(trim(phrase),'') is not null),
  'canonical_subtopic',jsonb_build_object('canonical_path',n.metadata->>'path','review_status','draft')
from public.canonical_taxonomy_nodes n join public.canonical_taxonomy_versions v on v.id=n.taxonomy_version_id
where v.version_key='canonical-medical-v1' and v.status='draft' and n.node_type='subtopic'
on conflict (taxonomy_version_id,subject_name,canonical_name) do update set
  taxonomy_node_id=excluded.taxonomy_node_id,aliases=excluded.aliases,updated_at=now();

create table if not exists public.canonical_taxonomy_draft_evidence(
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  question_id uuid not null references public.questions(id) on delete restrict,
  subject_name text not null,
  platform_name text,
  source_test text,
  stem_text text not null,
  correct_answer_text text,
  explanation_positive_text text,
  correct_keys text[] not null default '{}',
  extractor_version text not null,
  extracted_at timestamptz not null default now(),
  evidence_metadata jsonb not null default '{}',
  primary key(taxonomy_version_id,question_id)
);
comment on table public.canonical_taxonomy_draft_evidence is
  'Bounded review-only positive evidence extracted from the 300–500 question draft sample; distractor text is deliberately excluded.';
create index if not exists canonical_taxonomy_draft_evidence_question_idx
  on public.canonical_taxonomy_draft_evidence(question_id);

alter table public.canonical_taxonomy_draft_sample
  add column if not exists proposed_concept_id uuid,
  add column if not exists proposed_concept text,
  add column if not exists proposed_concept_path text,
  add column if not exists concept_confidence numeric,
  add column if not exists evidence_usage jsonb not null default '{}'::jsonb;
alter table public.canonical_taxonomy_draft_sample
  drop constraint if exists canonical_taxonomy_draft_sample_concept_fk,
  add constraint canonical_taxonomy_draft_sample_concept_fk
    foreign key(proposed_concept_id,taxonomy_version_id)
    references public.canonical_medical_concepts(id,taxonomy_version_id) on delete restrict;
create index if not exists canonical_taxonomy_draft_sample_concept_idx
  on public.canonical_taxonomy_draft_sample(proposed_concept_id) where proposed_concept_id is not null;
alter table public.canonical_taxonomy_draft_sample
  drop constraint if exists canonical_taxonomy_draft_sample_level_check,
  add constraint canonical_taxonomy_draft_sample_level_check
    check(classification_level in ('topic','subtopic','concept','unclassifiable'));

alter table public.canonical_medical_concepts enable row level security;
alter table public.canonical_taxonomy_draft_evidence enable row level security;
revoke all on table public.canonical_medical_concepts,public.canonical_taxonomy_draft_evidence from public,anon,authenticated;
grant all on table public.canonical_medical_concepts,public.canonical_taxonomy_draft_evidence to service_role;

create or replace function public.qbank_refresh_taxonomy_draft_v3(
  p_version_key text,p_concepts jsonb,p_evidence jsonb,p_predictions jsonb
) returns jsonb language plpgsql security invoker set search_path=''
as $$
declare version_uuid uuid; sample_count integer; evidence_count integer; prediction_count integer;
begin
  if current_user not in ('service_role','postgres') then raise exception 'Service role required'; end if;
  select id into version_uuid from public.canonical_taxonomy_versions where version_key=p_version_key and status='draft';
  if version_uuid is null then raise exception 'Draft taxonomy version not found'; end if;
  select count(*) into sample_count from public.canonical_taxonomy_draft_sample where taxonomy_version_id=version_uuid;
  evidence_count=jsonb_array_length(coalesce(p_evidence,'[]'::jsonb));
  prediction_count=jsonb_array_length(coalesce(p_predictions,'[]'::jsonb));
  if sample_count not between 300 and 500 or evidence_count<>sample_count or prediction_count<>sample_count then
    raise exception 'Bounded sample mismatch: sample %, evidence %, predictions %',sample_count,evidence_count,prediction_count;
  end if;
  if exists(
    select 1 from jsonb_to_recordset(p_predictions) p(question_id uuid)
    left join public.canonical_taxonomy_draft_sample s on s.taxonomy_version_id=version_uuid and s.question_id=p.question_id
    where s.question_id is null
  ) then raise exception 'Prediction contains a question outside the bounded draft sample'; end if;

  insert into public.canonical_medical_concepts(
    taxonomy_version_id,taxonomy_node_id,stable_code,subject_name,canonical_name,aliases,provenance,metadata
  )
  select version_uuid,n.id,'concept.curated.'||md5(c.subject||'|'||c.concept),c.subject,c.concept,c.aliases,
    'reviewed_vocabulary_v1',jsonb_build_object('parent_concept',c.parent_concept,'canonical_path',n.metadata->>'path','review_status','draft')
  from jsonb_to_recordset(p_concepts) c(subject text,topic text,subtopic text,concept text,aliases text[],parent_concept text)
  join lateral(
    select candidate.id,candidate.metadata from public.canonical_taxonomy_nodes candidate
    where candidate.taxonomy_version_id=version_uuid and candidate.metadata->>'subject'=c.subject
      and candidate.metadata->>'topic'=c.topic
      and ((candidate.node_type='subtopic' and candidate.metadata->>'subtopic'=c.subtopic)
        or (candidate.node_type='topic' and candidate.name=c.topic))
    order by case when candidate.node_type='subtopic' and candidate.metadata->>'subtopic'=c.subtopic then 0 else 1 end
    limit 1
  ) n on true
  on conflict (taxonomy_version_id,subject_name,canonical_name) do update set
    taxonomy_node_id=excluded.taxonomy_node_id,aliases=excluded.aliases,provenance=excluded.provenance,
    metadata=excluded.metadata,updated_at=now();

  update public.canonical_medical_concepts child set parent_concept_id=parent.id,updated_at=now()
  from public.canonical_medical_concepts parent
  where child.taxonomy_version_id=version_uuid and parent.taxonomy_version_id=version_uuid
    and child.subject_name=parent.subject_name
    and child.metadata->>'parent_concept'=parent.canonical_name;

  insert into public.canonical_taxonomy_draft_evidence(
    taxonomy_version_id,question_id,subject_name,platform_name,source_test,stem_text,correct_answer_text,
    explanation_positive_text,correct_keys,extractor_version,evidence_metadata
  )
  select version_uuid,e.question_id,e.subject,e.platform,e.source_test,e.stem_text,e.correct_answer_text,
    e.explanation_positive_text,coalesce(e.correct_keys,'{}'),'positive-evidence-v3',
    jsonb_build_object('bounded_sample',true,'distractors_excluded',true,
      'before_path',e.before_path,'before_confidence',e.before_confidence,
      'before_ambiguity',e.before_ambiguity,'before_cross_subject',e.before_cross_subject,
      'before_level',e.before_level,'before_basis',e.before_basis)
  from jsonb_to_recordset(p_evidence) e(
    question_id uuid,subject text,platform text,source_test text,stem_text text,correct_answer_text text,
    explanation_positive_text text,correct_keys text[],before_path text,before_confidence numeric,
    before_ambiguity boolean,before_cross_subject boolean,before_level text,before_basis text
  )
  on conflict(taxonomy_version_id,question_id) do update set
    subject_name=excluded.subject_name,platform_name=excluded.platform_name,source_test=excluded.source_test,
    stem_text=excluded.stem_text,correct_answer_text=excluded.correct_answer_text,
    explanation_positive_text=excluded.explanation_positive_text,correct_keys=excluded.correct_keys,
    extractor_version=excluded.extractor_version,extracted_at=now(),evidence_metadata=excluded.evidence_metadata;

  update public.canonical_taxonomy_draft_sample s set
    proposed_node_id=p.proposed_node_id,proposed_system=p.proposed_system,proposed_topic=p.proposed_topic,
    proposed_subtopic=p.proposed_subtopic,proposed_path=p.proposed_path,
    proposed_concept_id=(select concept.id from public.canonical_medical_concepts concept
      where concept.taxonomy_version_id=version_uuid and concept.subject_name=s.existing_subject
        and concept.canonical_name=p.proposed_concept limit 1),proposed_concept=p.proposed_concept,
    proposed_concept_path=p.proposed_concept_path,classifier_confidence=p.classifier_confidence,
    concept_confidence=p.concept_confidence,ambiguity=p.ambiguity,
    cross_subject_ambiguity=p.cross_subject_ambiguity,classification_basis=p.classification_basis,
    classification_level=p.classification_level,source_evidence_topic=p.source_evidence_topic,
    source_topic_supported=p.source_topic_supported,content_override=p.content_override,
    reason=p.reason,evidence_usage=coalesce(p.evidence_usage,'{}'::jsonb),
    generated_at=now(),generator_version='canonical-medical-v1-positive-evidence-v3'
  from jsonb_to_recordset(p_predictions) p(
    question_id uuid,proposed_node_id uuid,proposed_system text,proposed_topic text,proposed_subtopic text,
    proposed_path text,proposed_concept text,proposed_concept_path text,classifier_confidence numeric,
    concept_confidence numeric,ambiguity boolean,cross_subject_ambiguity boolean,classification_basis text,
    classification_level text,source_evidence_topic text,source_topic_supported boolean,content_override boolean,
    reason text,evidence_usage jsonb
  )
  where s.taxonomy_version_id=version_uuid and s.question_id=p.question_id;

  return jsonb_build_object(
    'sample',sample_count,
    'high',(select count(*) from public.canonical_taxonomy_draft_sample where taxonomy_version_id=version_uuid and classifier_confidence>=.8 and not ambiguity and not cross_subject_ambiguity),
    'ambiguous',(select count(*) from public.canonical_taxonomy_draft_sample where taxonomy_version_id=version_uuid and ambiguity),
    'unclassifiable',(select count(*) from public.canonical_taxonomy_draft_sample where taxonomy_version_id=version_uuid and classifier_confidence=0),
    'cross_subject',(select count(*) from public.canonical_taxonomy_draft_sample where taxonomy_version_id=version_uuid and cross_subject_ambiguity),
    'topic_resolved',(select count(*) from public.canonical_taxonomy_draft_sample where taxonomy_version_id=version_uuid and proposed_topic is not null),
    'subtopic_resolved',(select count(*) from public.canonical_taxonomy_draft_sample where taxonomy_version_id=version_uuid and proposed_subtopic is not null),
    'concept_resolved',(select count(*) from public.canonical_taxonomy_draft_sample where taxonomy_version_id=version_uuid and proposed_concept_id is not null)
  );
end;
$$;
revoke all on function public.qbank_refresh_taxonomy_draft_v3(text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.qbank_refresh_taxonomy_draft_v3(text,jsonb,jsonb,jsonb) to service_role;
comment on function public.qbank_refresh_taxonomy_draft_v3(text,jsonb,jsonb,jsonb) is
  'Service-only bounded refresh of draft evidence, concepts and predictions. Never writes production assignments.';

notify pgrst,'reload schema';
