-- Bounded real assignment pilot: 150 existing questions only.
-- Each pilot question receives its own candidate canonical identity; no content
-- versions are merged and no source/import/learner rows are changed.

create table if not exists public.canonical_taxonomy_assignment_pilot(
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  question_id uuid not null unique references public.questions(id) on delete restrict,
  canonical_question_id uuid not null unique default gen_random_uuid(),
  source_test_id uuid not null references public.qbank_source_tests(id) on delete restrict,
  source_topic_node_id uuid not null,
  primary_taxonomy_node_id uuid not null,
  primary_concept_id uuid not null,
  existing_subject_name text not null,
  is_pyq boolean not null,
  selection_category text not null,
  source_topic_confidence numeric(5,4) not null check(source_topic_confidence between 0 and 1),
  concept_confidence numeric(5,4) not null check(concept_confidence between 0 and 1),
  content_overrode_source_topic boolean not null default false,
  evidence_snapshot jsonb not null,
  classifier_name text not null default 'qbank-taxonomy-pilot',
  classifier_version text not null default 'positive-evidence-v3+source-test-v1.1',
  created_at timestamptz not null default now(),
  primary key(taxonomy_version_id,question_id),
  foreign key(source_topic_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key(primary_taxonomy_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key(primary_concept_id,taxonomy_version_id) references public.canonical_medical_concepts(id,taxonomy_version_id) on delete restrict
);

create index if not exists canonical_taxonomy_pilot_source_test_idx
  on public.canonical_taxonomy_assignment_pilot(source_test_id);
create index if not exists canonical_taxonomy_pilot_source_topic_fk_idx
  on public.canonical_taxonomy_assignment_pilot(source_topic_node_id,taxonomy_version_id);
create index if not exists canonical_taxonomy_pilot_primary_node_fk_idx
  on public.canonical_taxonomy_assignment_pilot(primary_taxonomy_node_id,taxonomy_version_id);
create index if not exists canonical_taxonomy_pilot_concept_fk_idx
  on public.canonical_taxonomy_assignment_pilot(primary_concept_id,taxonomy_version_id);

create table if not exists public.canonical_question_concept_assignments(
  id uuid primary key default gen_random_uuid(),
  canonical_question_id uuid not null references public.canonical_questions(id) on delete restrict,
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  canonical_concept_id uuid not null,
  is_primary boolean not null default false,
  is_current boolean not null default true,
  assignment_method text not null check(assignment_method in ('manual','rule','model','imported')),
  classifier_name text,
  classifier_version text,
  confidence numeric(5,4) check(confidence is null or confidence between 0 and 1),
  provenance jsonb not null default '{}'::jsonb,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references auth.users(id) on delete set null,
  notes text,
  foreign key(canonical_concept_id,taxonomy_version_id)
    references public.canonical_medical_concepts(id,taxonomy_version_id) on delete restrict
);

comment on table public.canonical_question_concept_assignments is
  'Versioned canonical Concept assignments, separate from taxonomy-path assignments and inactive in SRM/Test/Analytics.';
create unique index if not exists canonical_concept_assignment_current_uidx
  on public.canonical_question_concept_assignments(canonical_question_id,taxonomy_version_id,canonical_concept_id) where is_current;
create unique index if not exists canonical_concept_assignment_primary_uidx
  on public.canonical_question_concept_assignments(canonical_question_id,taxonomy_version_id) where is_current and is_primary;
create index if not exists canonical_concept_assignment_question_idx
  on public.canonical_question_concept_assignments(canonical_question_id);
create index if not exists canonical_concept_assignment_concept_fk_idx
  on public.canonical_question_concept_assignments(canonical_concept_id,taxonomy_version_id);
create index if not exists canonical_concept_assignment_assigned_by_idx
  on public.canonical_question_concept_assignments(assigned_by) where assigned_by is not null;

with version as (
  select id from public.canonical_taxonomy_versions where version_key='canonical-medical-v1' and status='draft'
), linked as (
  select distinct on (s.question_id)
    s.taxonomy_version_id,s.question_id,s.existing_subject,s.is_pyq,s.proposed_concept_id,
    c.taxonomy_node_id primary_node_id,c.canonical_name,c.metadata->>'canonical_path' concept_path,
    coalesce(s.concept_confidence,s.classifier_confidence) concept_confidence,
    s.classifier_confidence,s.classification_basis,s.source_topic_supported,s.content_override,
    s.secondary_concept,s.reason,s.evidence_usage,e.evidence_metadata,
    o.source_test_id,p.proposed_topic_node_id source_topic_id,p.confidence source_topic_confidence,
    p.classification_status source_topic_status,p.original_title,p.evidence_title,
    case when coalesce((e.evidence_metadata->>'before_cross_subject')::boolean,false) then 'resolved_cross_subject_edge'
      when coalesce((e.evidence_metadata->>'before_ambiguity')::boolean,false) then 'resolved_previous_ambiguity'
      when s.is_pyq then 'pyq'
      when coalesce((s.evidence_usage->>'explanation_positive')::boolean,false) then 'explanation_supported'
      when s.source_topic_supported then 'source_title_supported' else 'straightforward' end category,
    case when n.node_type='topic' then n.id else n.parent_id end content_topic_id
  from public.canonical_taxonomy_draft_sample s join version v on v.id=s.taxonomy_version_id
  join public.canonical_medical_concepts c on c.id=s.proposed_concept_id and c.taxonomy_version_id=s.taxonomy_version_id
  join public.canonical_taxonomy_nodes n on n.id=c.taxonomy_node_id and n.taxonomy_version_id=c.taxonomy_version_id
  join public.canonical_taxonomy_draft_evidence e on e.taxonomy_version_id=s.taxonomy_version_id and e.question_id=s.question_id
  join public.qbank_source_occurrences o on o.question_id=s.question_id and o.is_current
  join public.canonical_source_test_topic_proposals p on p.taxonomy_version_id=s.taxonomy_version_id and p.source_test_id=o.source_test_id and p.proposed_topic_node_id is not null
  where s.proposed_concept_id is not null
  order by s.question_id,case when p.original_title=s.source_test then 0 else 1 end,o.question_position
), eligible as (
  select s.*,
    row_number() over(partition by s.existing_subject order by
      case when coalesce((s.evidence_metadata->>'before_cross_subject')::boolean,false) then 0
        when coalesce((s.evidence_metadata->>'before_ambiguity')::boolean,false) then 1
        when s.is_pyq then 2 when coalesce((s.evidence_usage->>'explanation_positive')::boolean,false) then 3 else 4 end,
      coalesce(s.concept_confidence,s.classifier_confidence) desc,md5(s.question_id::text)) subject_rank
  from linked s
), required as (
  select * from eligible where subject_rank<=5
), remaining as (
  select e.*,row_number() over(order by
    case category when 'resolved_cross_subject_edge' then 0 when 'resolved_previous_ambiguity' then 1 when 'pyq' then 2 when 'explanation_supported' then 3 else 4 end,
    concept_confidence desc,md5(question_id::text)) extra_rank
  from eligible e where subject_rank>5
), chosen as (
  select * from required union all select r.taxonomy_version_id,r.question_id,r.existing_subject,r.is_pyq,r.proposed_concept_id,
    r.primary_node_id,r.canonical_name,r.concept_path,r.concept_confidence,r.classifier_confidence,
    r.classification_basis,r.source_topic_supported,r.content_override,r.secondary_concept,r.reason,r.evidence_usage,
    r.evidence_metadata,r.source_test_id,r.source_topic_id,r.source_topic_confidence,r.source_topic_status,
    r.original_title,r.evidence_title,r.category,r.content_topic_id,r.subject_rank
  from remaining r where extra_rank<=55
)
insert into public.canonical_taxonomy_assignment_pilot(
  taxonomy_version_id,question_id,source_test_id,source_topic_node_id,primary_taxonomy_node_id,
  primary_concept_id,existing_subject_name,is_pyq,selection_category,source_topic_confidence,
  concept_confidence,content_overrode_source_topic,evidence_snapshot
)
select taxonomy_version_id,question_id,source_test_id,source_topic_id,primary_node_id,proposed_concept_id,
  existing_subject,is_pyq,category,source_topic_confidence,concept_confidence,
  content_topic_id is distinct from source_topic_id,
  jsonb_build_object('source_test_title',original_title,'source_evidence_title',evidence_title,
    'source_topic_status',source_topic_status,'source_topic_supported',source_topic_supported,
    'content_override',content_override,'classification_basis',classification_basis,
    'reason',reason,'evidence_usage',evidence_usage,'previous_evidence',evidence_metadata,
    'canonical_concept',canonical_name,'canonical_concept_path',concept_path,'secondary_concept',secondary_concept)
from chosen
on conflict(taxonomy_version_id,question_id) do nothing;

do $$ declare pilot_count integer; begin
  select count(*) into pilot_count from public.canonical_taxonomy_assignment_pilot p join public.canonical_taxonomy_versions v on v.id=p.taxonomy_version_id where v.version_key='canonical-medical-v1';
  if pilot_count<>150 then
    raise exception 'Canonical assignment pilot must contain exactly 150 questions; got %',pilot_count;
  end if;
end $$;

insert into public.canonical_questions(id,status,review_notes)
select p.canonical_question_id,'candidate','Bounded Canonical Taxonomy v1 real-assignment pilot; one identity per source question.'
from public.canonical_taxonomy_assignment_pilot p
left join public.canonical_questions c on c.id=p.canonical_question_id where c.id is null;

alter table public.canonical_taxonomy_assignment_pilot
  drop constraint if exists canonical_taxonomy_assignment_pilot_canonical_question_fk,
  add constraint canonical_taxonomy_assignment_pilot_canonical_question_fk
    foreign key(canonical_question_id) references public.canonical_questions(id) on delete restrict;

insert into public.canonical_question_versions(
  canonical_question_id,question_id,version_sequence,version_label,content_sha256,link_method
)
select p.canonical_question_id,p.question_id,1,'Existing imported content version',
  coalesce(payload.content_sha256,md5(coalesce(q.question_text,'')||'|'||coalesce(q.correct_answer,''))),
  'reviewed_match'
from public.canonical_taxonomy_assignment_pilot p join public.questions q on q.id=p.question_id
left join public.qbank_question_payloads payload on payload.question_id=p.question_id
on conflict(question_id) do nothing;

insert into public.canonical_question_taxonomy_assignments(
  canonical_question_id,taxonomy_version_id,taxonomy_node_id,is_primary,is_current,
  assignment_method,classifier_name,classifier_version,confidence,notes
)
select canonical_question_id,taxonomy_version_id,primary_taxonomy_node_id,true,true,'model',
  classifier_name,classifier_version,concept_confidence,
  'Bounded 150-question pilot using normalized Source-Test Topic prior plus stem, correct answer, and positive explanation evidence.'
from public.canonical_taxonomy_assignment_pilot
on conflict do nothing;

insert into public.canonical_question_concept_assignments(
  canonical_question_id,taxonomy_version_id,canonical_concept_id,is_primary,is_current,
  assignment_method,classifier_name,classifier_version,confidence,provenance,notes
)
select canonical_question_id,taxonomy_version_id,primary_concept_id,true,true,'model',
  classifier_name,classifier_version,concept_confidence,evidence_snapshot,
  'Primary Concept for bounded Canonical Taxonomy v1 assignment pilot.'
from public.canonical_taxonomy_assignment_pilot
on conflict do nothing;

-- Secondary taxonomy paths are included only when the reviewed classifier
-- supplied an exact existing canonical path. No secondary label is invented.
insert into public.canonical_question_taxonomy_assignments(
  canonical_question_id,taxonomy_version_id,taxonomy_node_id,is_primary,is_current,
  assignment_method,classifier_name,classifier_version,confidence,notes
)
select p.canonical_question_id,p.taxonomy_version_id,secondary.id,false,true,'model',
  p.classifier_name,p.classifier_version,least(p.concept_confidence,.7500),
  'Exact secondary canonical path retained from the bounded reviewed draft.'
from public.canonical_taxonomy_assignment_pilot p
join public.canonical_taxonomy_nodes secondary on secondary.taxonomy_version_id=p.taxonomy_version_id
  and secondary.metadata->>'path'=p.evidence_snapshot->>'secondary_concept'
where secondary.id<>p.primary_taxonomy_node_id
on conflict do nothing;

alter table public.canonical_taxonomy_assignment_pilot enable row level security;
alter table public.canonical_question_concept_assignments enable row level security;
revoke all on table public.canonical_taxonomy_assignment_pilot,public.canonical_question_concept_assignments from public,anon,authenticated;
grant all on table public.canonical_taxonomy_assignment_pilot,public.canonical_question_concept_assignments to service_role;
notify pgrst,'reload schema';
