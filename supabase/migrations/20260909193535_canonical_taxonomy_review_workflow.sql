-- Additive reviewer workflow for Canonical Taxonomy v1 DRAFT.
-- This stores review metadata only. It never changes source content, learner state,
-- source occurrences, or production taxonomy assignments.

create table if not exists public.canonical_taxonomy_draft_sample (
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  question_id uuid not null references public.questions(id) on delete restrict,
  sample_order integer not null,
  platform text not null,
  source_test text,
  existing_subject text not null,
  is_pyq boolean not null default false,
  proposed_node_id uuid,
  proposed_system text,
  proposed_topic text,
  proposed_subtopic text,
  proposed_path text,
  classifier_confidence numeric not null check (classifier_confidence between 0 and 1),
  ambiguity boolean not null default false,
  secondary_concept text,
  cross_subject_ambiguity boolean not null default false,
  reason text not null,
  generated_at timestamptz not null default now(),
  generator_version text not null default 'canonical-medical-v1-rules',
  primary key (taxonomy_version_id,question_id),
  unique (taxonomy_version_id,sample_order),
  foreign key (proposed_node_id,taxonomy_version_id)
    references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict
);
comment on table public.canonical_taxonomy_draft_sample is
  'Bounded review sample and classifier proposals; not production question-taxonomy assignments.';

create index if not exists canonical_taxonomy_draft_sample_subject_idx
  on public.canonical_taxonomy_draft_sample(taxonomy_version_id,existing_subject,sample_order);
create index if not exists canonical_taxonomy_draft_sample_confidence_idx
  on public.canonical_taxonomy_draft_sample(taxonomy_version_id,classifier_confidence,sample_order);
create index if not exists canonical_taxonomy_draft_sample_question_idx
  on public.canonical_taxonomy_draft_sample(question_id,taxonomy_version_id);
create index if not exists canonical_taxonomy_draft_sample_proposed_fk_idx
  on public.canonical_taxonomy_draft_sample(proposed_node_id,taxonomy_version_id) where proposed_node_id is not null;

with version as (
  select id from public.canonical_taxonomy_versions where version_key='canonical-medical-v1'
), generated as (
  select row_number() over(order by d.existing_subject,d.is_pyq desc,md5(d.question_id::text))::integer sample_order,d.*
  from public.qbank_taxonomy_classification_dry_run('canonical-medical-v1',380) d
), prepared as (
  select v.id taxonomy_version_id,g.question_id,g.sample_order,g.platform,g.source_test,g.existing_subject,g.is_pyq,
    n.id proposed_node_id,g.proposed_system,g.proposed_topic,g.proposed_subtopic,g.proposed_path,
    g.classifier_confidence,g.ambiguity,g.secondary_concept,g.cross_subject_ambiguity,g.reason
  from generated g cross join version v
  left join public.canonical_taxonomy_nodes n
    on n.taxonomy_version_id=v.id and n.metadata->>'path'=g.proposed_path
)
insert into public.canonical_taxonomy_draft_sample(
  taxonomy_version_id,question_id,sample_order,platform,source_test,existing_subject,is_pyq,proposed_node_id,
  proposed_system,proposed_topic,proposed_subtopic,proposed_path,classifier_confidence,ambiguity,
  secondary_concept,cross_subject_ambiguity,reason
)
select taxonomy_version_id,question_id,sample_order,platform,source_test,existing_subject,is_pyq,proposed_node_id,
  proposed_system,proposed_topic,proposed_subtopic,proposed_path,classifier_confidence,ambiguity,
  secondary_concept,cross_subject_ambiguity,reason from prepared
on conflict (taxonomy_version_id,question_id) do update set
  sample_order=excluded.sample_order,platform=excluded.platform,source_test=excluded.source_test,
  existing_subject=excluded.existing_subject,is_pyq=excluded.is_pyq,proposed_node_id=excluded.proposed_node_id,
  proposed_system=excluded.proposed_system,proposed_topic=excluded.proposed_topic,
  proposed_subtopic=excluded.proposed_subtopic,proposed_path=excluded.proposed_path,
  classifier_confidence=excluded.classifier_confidence,ambiguity=excluded.ambiguity,
  secondary_concept=excluded.secondary_concept,cross_subject_ambiguity=excluded.cross_subject_ambiguity,
  reason=excluded.reason,generated_at=now();

create table if not exists public.canonical_taxonomy_draft_reviews (
  id uuid primary key default gen_random_uuid(),
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  question_id uuid not null references public.questions(id) on delete restrict,
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check (decision in ('accepted','needs_correction','unclassifiable','defer')),
  proposed_node_id uuid,
  corrected_subject_id uuid,
  corrected_system_id uuid,
  corrected_topic_id uuid,
  corrected_subtopic_id uuid,
  secondary_node_id uuid,
  reviewer_note text check (reviewer_note is null or length(reviewer_note)<=2000),
  proposal_snapshot jsonb not null default '{}'::jsonb,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (taxonomy_version_id,question_id,reviewer_id),
  foreign key (proposed_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key (corrected_subject_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key (corrected_system_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key (corrected_topic_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key (corrected_subtopic_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key (secondary_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  check (
    (decision='needs_correction' and corrected_subject_id is not null and corrected_topic_id is not null)
    or (decision<>'needs_correction' and corrected_subject_id is null and corrected_system_id is null and corrected_topic_id is null and corrected_subtopic_id is null)
  )
);
comment on table public.canonical_taxonomy_draft_reviews is
  'User-owned draft review decisions; inputs to a future explicit publish step, never production assignments.';

create index if not exists canonical_taxonomy_draft_reviews_reviewer_idx
  on public.canonical_taxonomy_draft_reviews(reviewer_id,taxonomy_version_id,decision,reviewed_at desc);
create index if not exists canonical_taxonomy_draft_reviews_question_idx
  on public.canonical_taxonomy_draft_reviews(question_id,taxonomy_version_id);
create index if not exists canonical_taxonomy_draft_reviews_proposed_fk_idx
  on public.canonical_taxonomy_draft_reviews(proposed_node_id,taxonomy_version_id) where proposed_node_id is not null;
create index if not exists canonical_taxonomy_draft_reviews_subject_fk_idx
  on public.canonical_taxonomy_draft_reviews(corrected_subject_id,taxonomy_version_id) where corrected_subject_id is not null;
create index if not exists canonical_taxonomy_draft_reviews_system_fk_idx
  on public.canonical_taxonomy_draft_reviews(corrected_system_id,taxonomy_version_id) where corrected_system_id is not null;
create index if not exists canonical_taxonomy_draft_reviews_topic_fk_idx
  on public.canonical_taxonomy_draft_reviews(corrected_topic_id,taxonomy_version_id) where corrected_topic_id is not null;
create index if not exists canonical_taxonomy_draft_reviews_subtopic_fk_idx
  on public.canonical_taxonomy_draft_reviews(corrected_subtopic_id,taxonomy_version_id) where corrected_subtopic_id is not null;
create index if not exists canonical_taxonomy_draft_reviews_secondary_fk_idx
  on public.canonical_taxonomy_draft_reviews(secondary_node_id,taxonomy_version_id) where secondary_node_id is not null;

create or replace function public.qbank_validate_taxonomy_draft_review()
returns trigger language plpgsql security invoker set search_path=''
as $$
declare subject_type text; system_parent uuid; topic_parent uuid; subtopic_parent uuid; secondary_version uuid;
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
  end if;
  if new.secondary_node_id is not null then
    select taxonomy_version_id into secondary_version from public.canonical_taxonomy_nodes where id=new.secondary_node_id;
    if secondary_version is distinct from new.taxonomy_version_id then raise exception 'Secondary concept is outside this taxonomy version'; end if;
  end if;
  new.updated_at=now(); new.reviewed_at=now(); return new;
end;
$$;
drop trigger if exists canonical_taxonomy_draft_reviews_validate on public.canonical_taxonomy_draft_reviews;
create trigger canonical_taxonomy_draft_reviews_validate before insert or update
on public.canonical_taxonomy_draft_reviews for each row execute function public.qbank_validate_taxonomy_draft_review();

alter table public.canonical_taxonomy_draft_sample enable row level security;
alter table public.canonical_taxonomy_draft_reviews enable row level security;
revoke all on table public.canonical_taxonomy_draft_sample from public,anon;
revoke all on table public.canonical_taxonomy_draft_reviews from public,anon,authenticated;
grant select on table public.canonical_taxonomy_draft_sample to authenticated;
grant select,insert,update on table public.canonical_taxonomy_draft_reviews to authenticated;
grant all on table public.canonical_taxonomy_draft_sample,public.canonical_taxonomy_draft_reviews to service_role;
create policy canonical_taxonomy_draft_sample_read on public.canonical_taxonomy_draft_sample for select to authenticated using (true);
create policy canonical_taxonomy_draft_reviews_select_own on public.canonical_taxonomy_draft_reviews for select to authenticated using ((select auth.uid())=reviewer_id);
create policy canonical_taxonomy_draft_reviews_insert_own on public.canonical_taxonomy_draft_reviews for insert to authenticated with check ((select auth.uid())=reviewer_id);
create policy canonical_taxonomy_draft_reviews_update_own on public.canonical_taxonomy_draft_reviews for update to authenticated using ((select auth.uid())=reviewer_id) with check ((select auth.uid())=reviewer_id);
revoke all on function public.qbank_validate_taxonomy_draft_review() from public,anon,authenticated;

create or replace function public.qbank_taxonomy_review_overview(p_version_key text default 'canonical-medical-v1')
returns jsonb language sql stable security invoker set search_path=''
as $$
select jsonb_build_object(
  'version',jsonb_build_object('id',v.id,'key',v.version_key,'name',v.name,'status',v.status,'description',v.description),
  'counts',coalesce((select jsonb_object_agg(node_type,cnt) from (
    select node_type,count(*) cnt from public.canonical_taxonomy_nodes where taxonomy_version_id=v.id group by node_type
  ) grouped),'{}'::jsonb),
  'subjects',coalesce((select jsonb_agg(jsonb_build_object(
    'id',n.id,'name',n.name,'path',n.metadata->>'path','type',n.node_type,'sort_order',n.sort_order
  ) order by n.sort_order,n.name) from public.canonical_taxonomy_nodes n
    where n.taxonomy_version_id=v.id and n.node_type='subject'),'[]'::jsonb),
  'sample_total',(select count(*) from public.canonical_taxonomy_draft_sample s where s.taxonomy_version_id=v.id),
  'reviewed',(select count(*) from public.canonical_taxonomy_draft_reviews r where r.taxonomy_version_id=v.id and r.reviewer_id=(select auth.uid())),
  'metrics',coalesce((select jsonb_build_object(
    'high',count(*) filter(where classifier_confidence>=.8 and not ambiguity and not cross_subject_ambiguity),
    'ambiguous',count(*) filter(where ambiguity),
    'unclassifiable',count(*) filter(where classifier_confidence=0),
    'cross_subject',count(*) filter(where cross_subject_ambiguity)
  ) from public.canonical_taxonomy_draft_sample s where s.taxonomy_version_id=v.id),'{}'::jsonb)
) from public.canonical_taxonomy_versions v where v.version_key=p_version_key;
$$;

create or replace function public.qbank_taxonomy_review_children(p_version_key text,p_parent_id uuid)
returns table(id uuid,parent_id uuid,node_type text,name text,path text,sort_order integer)
language sql stable security invoker set search_path=''
as $$
select n.id,n.parent_id,n.node_type,n.name,n.metadata->>'path',n.sort_order
from public.canonical_taxonomy_nodes n join public.canonical_taxonomy_versions v on v.id=n.taxonomy_version_id
where v.version_key=p_version_key and n.parent_id=p_parent_id order by n.sort_order,n.name;
$$;

create or replace function public.qbank_taxonomy_review_node_search(
  p_version_key text,p_search text,p_limit integer default 25
) returns table(id uuid,node_type text,name text,path text)
language sql stable security invoker set search_path=''
as $$
select n.id,n.node_type,n.name,n.metadata->>'path'
from public.canonical_taxonomy_nodes n join public.canonical_taxonomy_versions v on v.id=n.taxonomy_version_id
where v.version_key=p_version_key and length(trim(coalesce(p_search,'')))>=2
  and (n.name ilike '%'||trim(p_search)||'%' or n.metadata->>'path' ilike '%'||trim(p_search)||'%')
order by case when lower(n.name)=lower(trim(p_search)) then 0 else 1 end,n.node_type,n.name
limit least(greatest(p_limit,1),25);
$$;

create or replace function public.qbank_taxonomy_review_page(
  p_version_key text default 'canonical-medical-v1',p_page integer default 1,p_page_size integer default 25,
  p_subject text default null,p_status text default null,p_confidence text default null,
  p_review_state text default null,p_search text default null
) returns jsonb language sql stable security invoker set search_path=''
as $$
with version as (select id from public.canonical_taxonomy_versions where version_key=p_version_key),
base as (
  select s.*,
    case when s.classifier_confidence=0 then 'unclassifiable'
      when s.ambiguity or s.cross_subject_ambiguity then 'ambiguous' else 'classified' end classifier_status,
    case when s.classifier_confidence=0 then 'none' when s.classifier_confidence<.5 then 'low'
      when s.classifier_confidence<.8 then 'medium' else 'high' end confidence_band,
    r.decision review_decision,r.corrected_subject_id,r.corrected_system_id,r.corrected_topic_id,
    r.corrected_subtopic_id,r.secondary_node_id,r.reviewer_note,r.reviewed_at,
    coalesce(csub.metadata->>'path',ctopic.metadata->>'path') corrected_path,
    secondary.metadata->>'path' secondary_path
  from public.canonical_taxonomy_draft_sample s cross join version v
  left join public.canonical_taxonomy_draft_reviews r
    on r.taxonomy_version_id=v.id and r.question_id=s.question_id and r.reviewer_id=(select auth.uid())
  left join public.canonical_taxonomy_nodes csub on csub.id=r.corrected_subtopic_id
  left join public.canonical_taxonomy_nodes ctopic on ctopic.id=r.corrected_topic_id
  left join public.canonical_taxonomy_nodes secondary on secondary.id=r.secondary_node_id
  where s.taxonomy_version_id=v.id
), filtered as (
  select b.* from base b left join public.questions q on q.id=b.question_id
  where (nullif(p_subject,'') is null or b.existing_subject=p_subject)
    and (nullif(p_status,'') is null or b.classifier_status=p_status)
    and (nullif(p_confidence,'') is null or b.confidence_band=p_confidence)
    and (nullif(p_review_state,'') is null
      or (p_review_state='unreviewed' and b.review_decision is null)
      or b.review_decision=p_review_state)
    and (nullif(trim(p_search),'') is null or b.question_id::text=trim(p_search)
      or q.question_text ilike '%'||trim(p_search)||'%')
), paged as (
  select * from filtered order by sample_order
  offset (greatest(p_page,1)-1)*least(greatest(p_page_size,25),50)
  limit least(greatest(p_page_size,25),50)
)
select jsonb_build_object(
  'page',greatest(p_page,1),'page_size',least(greatest(p_page_size,25),50),
  'total',(select count(*) from filtered),'sample_total',(select count(*) from base),
  'reviewed',(select count(*) from base where review_decision is not null),
  'items',coalesce((select jsonb_agg(to_jsonb(p) order by sample_order) from paged p),'[]'::jsonb)
);
$$;

create or replace function public.qbank_save_taxonomy_draft_review(
  p_version_key text,p_question_id uuid,p_decision text,p_proposed_node_id uuid default null,
  p_corrected_subject_id uuid default null,p_corrected_system_id uuid default null,
  p_corrected_topic_id uuid default null,p_corrected_subtopic_id uuid default null,
  p_secondary_node_id uuid default null,p_reviewer_note text default null,
  p_proposal_snapshot jsonb default '{}'::jsonb
) returns public.canonical_taxonomy_draft_reviews language plpgsql security invoker set search_path=''
as $$
declare version_uuid uuid; saved public.canonical_taxonomy_draft_reviews;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  select id into version_uuid from public.canonical_taxonomy_versions where version_key=p_version_key and status='draft';
  if version_uuid is null then raise exception 'Draft taxonomy version not found'; end if;
  if not exists(select 1 from public.canonical_taxonomy_draft_sample where taxonomy_version_id=version_uuid and question_id=p_question_id) then
    raise exception 'Question is outside the review sample';
  end if;
  insert into public.canonical_taxonomy_draft_reviews(
    taxonomy_version_id,question_id,reviewer_id,decision,proposed_node_id,corrected_subject_id,
    corrected_system_id,corrected_topic_id,corrected_subtopic_id,secondary_node_id,reviewer_note,proposal_snapshot
  ) values (
    version_uuid,p_question_id,(select auth.uid()),p_decision,p_proposed_node_id,p_corrected_subject_id,
    p_corrected_system_id,p_corrected_topic_id,p_corrected_subtopic_id,p_secondary_node_id,
    nullif(trim(p_reviewer_note),''),coalesce(p_proposal_snapshot,'{}'::jsonb)
  ) on conflict(taxonomy_version_id,question_id,reviewer_id) do update set
    decision=excluded.decision,proposed_node_id=excluded.proposed_node_id,
    corrected_subject_id=excluded.corrected_subject_id,corrected_system_id=excluded.corrected_system_id,
    corrected_topic_id=excluded.corrected_topic_id,corrected_subtopic_id=excluded.corrected_subtopic_id,
    secondary_node_id=excluded.secondary_node_id,reviewer_note=excluded.reviewer_note,
    proposal_snapshot=excluded.proposal_snapshot
  returning * into saved;
  return saved;
end;
$$;

revoke all on function public.qbank_taxonomy_review_overview(text) from public,anon;
revoke all on function public.qbank_taxonomy_review_children(text,uuid) from public,anon;
revoke all on function public.qbank_taxonomy_review_node_search(text,text,integer) from public,anon;
revoke all on function public.qbank_taxonomy_review_page(text,integer,integer,text,text,text,text,text) from public,anon;
revoke all on function public.qbank_save_taxonomy_draft_review(text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.qbank_taxonomy_review_overview(text) to authenticated,service_role;
grant execute on function public.qbank_taxonomy_review_children(text,uuid) to authenticated,service_role;
grant execute on function public.qbank_taxonomy_review_node_search(text,text,integer) to authenticated,service_role;
grant execute on function public.qbank_taxonomy_review_page(text,integer,integer,text,text,text,text,text) to authenticated,service_role;
grant execute on function public.qbank_save_taxonomy_draft_review(text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb) to authenticated,service_role;
notify pgrst,'reload schema';
