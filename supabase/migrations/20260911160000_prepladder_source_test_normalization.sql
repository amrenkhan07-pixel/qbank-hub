-- PrepLadder source-test normalization against Canonical Taxonomy v1 DRAFT.
-- Source tests remain immutable source metadata. These rows are reviewable
-- proposals only and never become taxonomy nodes or question assignments.

create or replace function public.qbank_normalize_medical_label(p_value text)
returns text language sql immutable parallel safe security invoker set search_path=''
as $$
  select trim(regexp_replace(
    regexp_replace(lower(coalesce(p_value,'')),'^\s*[0-9]+\s*',''),
    '[^a-z0-9]+',' ','g'
  ));
$$;

create table if not exists public.canonical_source_test_topic_proposals(
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  source_test_id uuid not null references public.qbank_source_tests(id) on delete restrict,
  existing_subject_id uuid not null references public.subjects(id) on delete restrict,
  existing_subject_name text not null,
  canonical_subject_node_id uuid not null,
  proposed_system_node_id uuid,
  proposed_topic_node_id uuid,
  original_title text not null,
  evidence_title text not null,
  classification_status text not null check(classification_status in ('confident','ambiguous','unmapped')),
  confidence numeric(5,4) not null check(confidence between 0 and 1),
  ambiguity boolean not null default false,
  classification_basis text not null check(classification_basis in ('source_title','adjacent_source_test_context','insufficient_title_evidence')),
  rationale text not null,
  candidates jsonb not null default '[]'::jsonb,
  generator_name text not null default 'qbank-source-test-normalizer',
  generator_version text not null default 'canonical-medical-v1-source-test-v1',
  generated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key(taxonomy_version_id,source_test_id),
  foreign key(canonical_subject_node_id,taxonomy_version_id)
    references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key(proposed_system_node_id,taxonomy_version_id)
    references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key(proposed_topic_node_id,taxonomy_version_id)
    references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  check((classification_status='unmapped' and proposed_topic_node_id is null)
    or (classification_status<>'unmapped' and proposed_topic_node_id is not null))
);

comment on table public.canonical_source_test_topic_proposals is
  'Review-only mapping from preserved source-test metadata to an existing canonical Topic; never a question assignment.';

create index if not exists canonical_source_test_proposals_review_idx
  on public.canonical_source_test_topic_proposals(taxonomy_version_id,classification_status,existing_subject_name,source_test_id);
create index if not exists canonical_source_test_proposals_topic_fk_idx
  on public.canonical_source_test_topic_proposals(proposed_topic_node_id,taxonomy_version_id) where proposed_topic_node_id is not null;
create index if not exists canonical_source_test_proposals_system_fk_idx
  on public.canonical_source_test_topic_proposals(proposed_system_node_id,taxonomy_version_id) where proposed_system_node_id is not null;
create index if not exists canonical_source_test_proposals_subject_fk_idx
  on public.canonical_source_test_topic_proposals(canonical_subject_node_id,taxonomy_version_id);
create index if not exists canonical_source_test_proposals_existing_subject_fk_idx
  on public.canonical_source_test_topic_proposals(existing_subject_id);

create table if not exists public.canonical_source_test_topic_reviews(
  id uuid primary key default gen_random_uuid(),
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  source_test_id uuid not null references public.qbank_source_tests(id) on delete restrict,
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check(decision in ('accepted','corrected','defer')),
  proposed_topic_node_id uuid,
  corrected_subject_node_id uuid,
  corrected_system_node_id uuid,
  corrected_topic_node_id uuid,
  reviewer_note text check(reviewer_note is null or length(reviewer_note)<=2000),
  proposal_snapshot jsonb not null default '{}'::jsonb,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(taxonomy_version_id,source_test_id,reviewer_id),
  foreign key(proposed_topic_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key(corrected_subject_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key(corrected_system_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key(corrected_topic_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  check((decision='corrected' and corrected_subject_node_id is not null and corrected_topic_node_id is not null)
    or (decision<>'corrected' and corrected_subject_node_id is null and corrected_system_node_id is null and corrected_topic_node_id is null))
);

create index if not exists canonical_source_test_reviews_reviewer_idx
  on public.canonical_source_test_topic_reviews(reviewer_id,taxonomy_version_id,decision,reviewed_at desc);
create index if not exists canonical_source_test_reviews_source_test_idx
  on public.canonical_source_test_topic_reviews(source_test_id,taxonomy_version_id);
create index if not exists canonical_source_test_reviews_proposed_fk_idx
  on public.canonical_source_test_topic_reviews(proposed_topic_node_id,taxonomy_version_id) where proposed_topic_node_id is not null;
create index if not exists canonical_source_test_reviews_subject_fk_idx
  on public.canonical_source_test_topic_reviews(corrected_subject_node_id,taxonomy_version_id) where corrected_subject_node_id is not null;
create index if not exists canonical_source_test_reviews_system_fk_idx
  on public.canonical_source_test_topic_reviews(corrected_system_node_id,taxonomy_version_id) where corrected_system_node_id is not null;
create index if not exists canonical_source_test_reviews_topic_fk_idx
  on public.canonical_source_test_topic_reviews(corrected_topic_node_id,taxonomy_version_id) where corrected_topic_node_id is not null;

create or replace function public.qbank_validate_source_test_topic_review()
returns trigger language plpgsql security invoker set search_path=''
as $$
declare subject_type text; system_parent uuid; topic_parent uuid;
begin
  if new.decision='accepted' and new.proposed_topic_node_id is null then
    raise exception 'Accepted source-test reviews require a proposed Topic';
  end if;
  if new.decision='corrected' then
    select node_type into subject_type from public.canonical_taxonomy_nodes
    where id=new.corrected_subject_node_id and taxonomy_version_id=new.taxonomy_version_id;
    if subject_type is distinct from 'subject' then raise exception 'Corrected canonical Subject is invalid'; end if;
    if new.corrected_system_node_id is not null then
      select parent_id into system_parent from public.canonical_taxonomy_nodes
      where id=new.corrected_system_node_id and taxonomy_version_id=new.taxonomy_version_id and node_type='system';
      if system_parent is distinct from new.corrected_subject_node_id then raise exception 'Corrected System is outside the selected Subject'; end if;
    end if;
    select parent_id into topic_parent from public.canonical_taxonomy_nodes
    where id=new.corrected_topic_node_id and taxonomy_version_id=new.taxonomy_version_id and node_type='topic';
    if topic_parent is null or topic_parent is distinct from coalesce(new.corrected_system_node_id,new.corrected_subject_node_id) then
      raise exception 'Corrected Topic is outside the selected Subject/System';
    end if;
  end if;
  new.updated_at=now(); new.reviewed_at=now(); return new;
end $$;

drop trigger if exists qbank_validate_source_test_topic_review_trigger on public.canonical_source_test_topic_reviews;
create trigger qbank_validate_source_test_topic_review_trigger before insert or update
on public.canonical_source_test_topic_reviews for each row execute function public.qbank_validate_source_test_topic_review();

create or replace function public.qbank_refresh_source_test_topic_proposals(p_version_key text default 'canonical-medical-v1')
returns jsonb language plpgsql security invoker set search_path=''
as $$
declare version_uuid uuid; proposal_count integer;
begin
  if current_user not in ('service_role','postgres') then raise exception 'Service role required'; end if;
  select id into version_uuid from public.canonical_taxonomy_versions where version_key=p_version_key and status='draft';
  if version_uuid is null then raise exception 'Draft taxonomy version not found'; end if;

  with source_base as (
    select st.id source_test_id,st.subject_id,s.name subject_name,st.title original_title,st.sequence,st.is_pyq,
      lower(st.title) ~ '(previous year questions|grand test|mock test|mixed questions|rapid revision|comprehensive)' broad_title,
      coalesce(prior.title,st.title) evidence_title
    from public.qbank_source_tests st
    join public.platforms p on p.id=st.platform_id and lower(trim(p.name))='prepladder'
    join public.subjects s on s.id=st.subject_id
    left join lateral(
      select prior_test.title from public.qbank_source_tests prior_test
      where prior_test.platform_id=st.platform_id and prior_test.subject_id=st.subject_id
        and prior_test.sequence<st.sequence
        and lower(prior_test.title) !~ '(previous year questions|grand test|mock test|mixed questions|rapid revision|comprehensive)'
      order by prior_test.sequence desc limit 1
    ) prior on lower(st.title) ~ '(previous year questions|grand test|mock test|mixed questions|rapid revision|comprehensive)'
  ), subjects as (
    select n.id subject_node_id,n.name subject_name
    from public.canonical_taxonomy_nodes n where n.taxonomy_version_id=version_uuid and n.node_type='subject'
  ), topic_context as (
    select topic.id topic_id,topic.name topic_name,topic.metadata->>'subject' subject_name,
      case when parent.node_type='system' then parent.id end system_id,
      case when parent.node_type='system' then parent.name end system_name
    from public.canonical_taxonomy_nodes topic
    join public.canonical_taxonomy_nodes parent on parent.id=topic.parent_id and parent.taxonomy_version_id=topic.taxonomy_version_id
    where topic.taxonomy_version_id=version_uuid and topic.node_type='topic'
  ), lexicon as (
    select t.topic_id,t.subject_name,t.system_id,t.system_name,t.topic_name,t.topic_name phrase,1.000::numeric weight from topic_context t
    union all
    select t.topic_id,t.subject_name,t.system_id,t.system_name,t.topic_name,sub.name,.980 from topic_context t
      join public.canonical_taxonomy_nodes sub on sub.parent_id=t.topic_id and sub.taxonomy_version_id=version_uuid and sub.node_type='subtopic'
    union all
    select t.topic_id,t.subject_name,t.system_id,t.system_name,t.topic_name,c.canonical_name,.990 from topic_context t
      join public.canonical_medical_concepts c on c.taxonomy_version_id=version_uuid
      join public.canonical_taxonomy_nodes cn on cn.id=c.taxonomy_node_id and cn.taxonomy_version_id=version_uuid
      where cn.id=t.topic_id or cn.parent_id=t.topic_id
    union all
    select t.topic_id,t.subject_name,t.system_id,t.system_name,t.topic_name,alias,.960 from topic_context t
      join public.canonical_medical_concepts c on c.taxonomy_version_id=version_uuid
      join public.canonical_taxonomy_nodes cn on cn.id=c.taxonomy_node_id and cn.taxonomy_version_id=version_uuid
      cross join lateral unnest(c.aliases) alias
      where cn.id=t.topic_id or cn.parent_id=t.topic_id
  ), phrase_scores as (
    select b.*,s.subject_node_id,l.topic_id,l.topic_name,l.system_id,l.system_name,
      public.qbank_normalize_medical_label(b.evidence_title) normalized_title,
      public.qbank_normalize_medical_label(l.phrase) normalized_phrase,
      case
        when public.qbank_normalize_medical_label(b.evidence_title)=public.qbank_normalize_medical_label(l.phrase) then l.weight
        when length(public.qbank_normalize_medical_label(l.phrase))>=4 and
          ' '||public.qbank_normalize_medical_label(b.evidence_title)||' ' like '% '||public.qbank_normalize_medical_label(l.phrase)||' %' then l.weight*.970
        when length(public.qbank_normalize_medical_label(b.evidence_title))>=5 and
          ' '||public.qbank_normalize_medical_label(l.phrase)||' ' like '% '||public.qbank_normalize_medical_label(b.evidence_title)||' %' then l.weight*.880
        else coalesce((
          select count(distinct title_word)::numeric/nullif(least(count(distinct title_word),
            (select count(distinct phrase_word) from regexp_split_to_table(public.qbank_normalize_medical_label(l.phrase),'\s+') phrase_word
             where length(phrase_word)>=3 and phrase_word not in ('and','the','with','from','part','general','basics','introduction','disease','disorders'))),0)*l.weight*.820
          from regexp_split_to_table(public.qbank_normalize_medical_label(b.evidence_title),'\s+') title_word
          where length(title_word)>=3 and title_word not in ('and','the','with','from','part','general','basics','introduction','disease','disorders')
            and title_word in (select phrase_word from regexp_split_to_table(public.qbank_normalize_medical_label(l.phrase),'\s+') phrase_word)
        ),0)
      end phrase_score
    from source_base b join subjects s on s.subject_name=b.subject_name join lexicon l on l.subject_name=b.subject_name
  ), topic_scores as (
    select source_test_id,subject_id,subject_name,subject_node_id,original_title,evidence_title,sequence,is_pyq,broad_title,
      topic_id,topic_name,system_id,system_name,max(phrase_score) topic_score
    from phrase_scores group by source_test_id,subject_id,subject_name,subject_node_id,original_title,evidence_title,sequence,is_pyq,broad_title,topic_id,topic_name,system_id,system_name
  ), ranked as (
    select t.*,row_number() over(partition by source_test_id order by topic_score desc,topic_name) rank,
      lead(topic_score) over(partition by source_test_id order by topic_score desc,topic_name) second_score
    from topic_scores t
  ), prepared as (
    select top.*,coalesce(top.second_score,0) runner_up,
      case when top.topic_score<.34 then 'unmapped'
        when top.topic_score-coalesce(top.second_score,0)<.075 then 'ambiguous' else 'confident' end classification_status,
      case when top.topic_score<.34 then 0
        when top.broad_title then least(top.topic_score,.880)
        when top.topic_score-coalesce(top.second_score,0)<.075 then least(top.topic_score,.690)
        else least(top.topic_score,.990) end final_confidence
    from ranked top where top.rank=1
  )
  insert into public.canonical_source_test_topic_proposals(
    taxonomy_version_id,source_test_id,existing_subject_id,existing_subject_name,canonical_subject_node_id,
    proposed_system_node_id,proposed_topic_node_id,original_title,evidence_title,classification_status,
    confidence,ambiguity,classification_basis,rationale,candidates,generator_version,generated_at,metadata
  )
  select version_uuid,p.source_test_id,p.subject_id,p.subject_name,p.subject_node_id,
    case when p.classification_status='unmapped' then null else p.system_id end,
    case when p.classification_status='unmapped' then null else p.topic_id end,
    p.original_title,p.evidence_title,p.classification_status,p.final_confidence,
    p.classification_status='ambiguous',
    case when p.classification_status='unmapped' then 'insufficient_title_evidence'
      when p.broad_title then 'adjacent_source_test_context' else 'source_title' end,
    case when p.classification_status='unmapped' then 'The title does not provide enough evidence for one stable canonical Topic.'
      when p.broad_title then 'Generic test title mapped using the nearest preceding subject module as source-context evidence.'
      when p.classification_status='ambiguous' then 'The source title supports more than one nearby canonical Topic; reviewer confirmation is required.'
      else 'The preserved source-test title strongly matches vocabulary beneath this canonical Topic.' end,
    coalesce((select jsonb_agg(jsonb_build_object('topic_id',candidate.topic_id,'topic',candidate.topic_name,'system',candidate.system_name,'score',round(candidate.topic_score,4)) order by candidate.topic_score desc,candidate.topic_name)
      from (select * from topic_scores candidate where candidate.source_test_id=p.source_test_id order by candidate.topic_score desc,candidate.topic_name limit 3) candidate),'[]'::jsonb),
    'canonical-medical-v1-source-test-v1',now(),
    jsonb_build_object('source_order',p.sequence,'is_pyq',p.is_pyq,'runner_up_score',round(p.runner_up,4),'source_test_preserved',true)
  from prepared p
  on conflict(taxonomy_version_id,source_test_id) do update set
    existing_subject_id=excluded.existing_subject_id,existing_subject_name=excluded.existing_subject_name,
    canonical_subject_node_id=excluded.canonical_subject_node_id,proposed_system_node_id=excluded.proposed_system_node_id,
    proposed_topic_node_id=excluded.proposed_topic_node_id,original_title=excluded.original_title,
    evidence_title=excluded.evidence_title,classification_status=excluded.classification_status,
    confidence=excluded.confidence,ambiguity=excluded.ambiguity,classification_basis=excluded.classification_basis,
    rationale=excluded.rationale,candidates=excluded.candidates,generator_version=excluded.generator_version,
    generated_at=now(),metadata=excluded.metadata;

  select count(*) into proposal_count from public.canonical_source_test_topic_proposals where taxonomy_version_id=version_uuid;
  if proposal_count<>1129 then raise exception 'Expected 1129 PrepLadder source-test proposals, got %',proposal_count; end if;
  return jsonb_build_object('total',proposal_count,
    'confident',(select count(*) from public.canonical_source_test_topic_proposals where taxonomy_version_id=version_uuid and classification_status='confident'),
    'ambiguous',(select count(*) from public.canonical_source_test_topic_proposals where taxonomy_version_id=version_uuid and classification_status='ambiguous'),
    'unmapped',(select count(*) from public.canonical_source_test_topic_proposals where taxonomy_version_id=version_uuid and classification_status='unmapped'));
end $$;

create or replace function public.qbank_source_test_review_overview(p_version_key text default 'canonical-medical-v1')
returns jsonb language sql stable security invoker set search_path=''
as $$
with v as (select id,name,status from public.canonical_taxonomy_versions where version_key=p_version_key)
select jsonb_build_object(
  'version',jsonb_build_object('name',v.name,'status',v.status),
  'total',(select count(*) from public.canonical_source_test_topic_proposals p where p.taxonomy_version_id=v.id),
  'confident',(select count(*) from public.canonical_source_test_topic_proposals p where p.taxonomy_version_id=v.id and p.classification_status='confident'),
  'ambiguous',(select count(*) from public.canonical_source_test_topic_proposals p where p.taxonomy_version_id=v.id and p.classification_status='ambiguous'),
  'unmapped',(select count(*) from public.canonical_source_test_topic_proposals p where p.taxonomy_version_id=v.id and p.classification_status='unmapped'),
  'reviewed',(select count(*) from public.canonical_source_test_topic_reviews r where r.taxonomy_version_id=v.id and r.reviewer_id=(select auth.uid())),
  'subjects',coalesce((select jsonb_agg(distinct p.existing_subject_name order by p.existing_subject_name) from public.canonical_source_test_topic_proposals p where p.taxonomy_version_id=v.id),'[]'::jsonb)
) from v;
$$;

create or replace function public.qbank_source_test_review_page(
  p_version_key text default 'canonical-medical-v1',p_page integer default 1,p_page_size integer default 25,
  p_subject text default null,p_status text default null,p_review_state text default null,p_search text default null
) returns jsonb language sql stable security invoker set search_path=''
as $$
with v as (select id from public.canonical_taxonomy_versions where version_key=p_version_key), base as (
  select p.*,subject_node.name canonical_subject,system_node.name proposed_system,topic_node.name proposed_topic,
    topic_node.metadata->>'path' proposed_path,st.sequence,st.is_pyq,st.declared_question_count,
    r.decision review_decision,r.corrected_subject_node_id,r.corrected_system_node_id,r.corrected_topic_node_id,
    r.reviewer_note,r.reviewed_at,corrected_topic.metadata->>'path' corrected_path
  from public.canonical_source_test_topic_proposals p cross join v
  join public.qbank_source_tests st on st.id=p.source_test_id
  join public.canonical_taxonomy_nodes subject_node on subject_node.id=p.canonical_subject_node_id
  left join public.canonical_taxonomy_nodes system_node on system_node.id=p.proposed_system_node_id
  left join public.canonical_taxonomy_nodes topic_node on topic_node.id=p.proposed_topic_node_id
  left join public.canonical_source_test_topic_reviews r on r.taxonomy_version_id=v.id and r.source_test_id=p.source_test_id and r.reviewer_id=(select auth.uid())
  left join public.canonical_taxonomy_nodes corrected_topic on corrected_topic.id=r.corrected_topic_node_id
  where p.taxonomy_version_id=v.id
), filtered as (
  select * from base where (nullif(p_subject,'') is null or existing_subject_name=p_subject)
    and (nullif(p_status,'') is null or classification_status=p_status)
    and (nullif(p_review_state,'') is null or (p_review_state='unreviewed' and review_decision is null) or review_decision=p_review_state)
    and (nullif(trim(p_search),'') is null or original_title ilike '%'||trim(p_search)||'%' or source_test_id::text=trim(p_search))
), paged as (
  select * from filtered order by existing_subject_name,sequence,source_test_id
  offset (greatest(p_page,1)-1)*least(greatest(p_page_size,25),50)
  limit least(greatest(p_page_size,25),50)
)
select jsonb_build_object('page',greatest(p_page,1),'page_size',least(greatest(p_page_size,25),50),
  'total',(select count(*) from filtered),'all_total',(select count(*) from base),
  'items',coalesce((select jsonb_agg(to_jsonb(p) order by existing_subject_name,sequence,source_test_id) from paged p),'[]'::jsonb));
$$;

create or replace function public.qbank_save_source_test_topic_review(
  p_version_key text,p_source_test_id uuid,p_decision text,p_proposed_topic_node_id uuid default null,
  p_corrected_subject_node_id uuid default null,p_corrected_system_node_id uuid default null,
  p_corrected_topic_node_id uuid default null,p_reviewer_note text default null,p_proposal_snapshot jsonb default '{}'::jsonb
) returns public.canonical_source_test_topic_reviews language plpgsql security invoker set search_path=''
as $$
declare version_uuid uuid; saved public.canonical_source_test_topic_reviews;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  select id into version_uuid from public.canonical_taxonomy_versions where version_key=p_version_key and status='draft';
  if version_uuid is null then raise exception 'Draft taxonomy version not found'; end if;
  if not exists(select 1 from public.canonical_source_test_topic_proposals where taxonomy_version_id=version_uuid and source_test_id=p_source_test_id) then raise exception 'Source Test is outside this normalization draft'; end if;
  insert into public.canonical_source_test_topic_reviews(
    taxonomy_version_id,source_test_id,reviewer_id,decision,proposed_topic_node_id,
    corrected_subject_node_id,corrected_system_node_id,corrected_topic_node_id,reviewer_note,proposal_snapshot
  ) values(version_uuid,p_source_test_id,(select auth.uid()),p_decision,p_proposed_topic_node_id,
    p_corrected_subject_node_id,p_corrected_system_node_id,p_corrected_topic_node_id,nullif(trim(p_reviewer_note),''),coalesce(p_proposal_snapshot,'{}'::jsonb))
  on conflict(taxonomy_version_id,source_test_id,reviewer_id) do update set
    decision=excluded.decision,proposed_topic_node_id=excluded.proposed_topic_node_id,
    corrected_subject_node_id=excluded.corrected_subject_node_id,corrected_system_node_id=excluded.corrected_system_node_id,
    corrected_topic_node_id=excluded.corrected_topic_node_id,reviewer_note=excluded.reviewer_note,
    proposal_snapshot=excluded.proposal_snapshot
  returning * into saved;
  return saved;
end $$;

alter table public.canonical_source_test_topic_proposals enable row level security;
alter table public.canonical_source_test_topic_reviews enable row level security;
revoke all on table public.canonical_source_test_topic_proposals from public,anon;
revoke all on table public.canonical_source_test_topic_reviews from public,anon,authenticated;
grant select on table public.canonical_source_test_topic_proposals to authenticated;
grant select,insert,update on table public.canonical_source_test_topic_reviews to authenticated;
grant all on table public.canonical_source_test_topic_proposals,public.canonical_source_test_topic_reviews to service_role;
create policy canonical_source_test_proposals_read on public.canonical_source_test_topic_proposals for select to authenticated using(true);
create policy canonical_source_test_reviews_select_own on public.canonical_source_test_topic_reviews for select to authenticated using((select auth.uid())=reviewer_id);
create policy canonical_source_test_reviews_insert_own on public.canonical_source_test_topic_reviews for insert to authenticated with check((select auth.uid())=reviewer_id);
create policy canonical_source_test_reviews_update_own on public.canonical_source_test_topic_reviews for update to authenticated using((select auth.uid())=reviewer_id) with check((select auth.uid())=reviewer_id);

revoke all on function public.qbank_normalize_medical_label(text) from public,anon,authenticated;
revoke all on function public.qbank_validate_source_test_topic_review() from public,anon,authenticated;
revoke all on function public.qbank_refresh_source_test_topic_proposals(text) from public,anon,authenticated;
revoke all on function public.qbank_source_test_review_overview(text) from public,anon;
revoke all on function public.qbank_source_test_review_page(text,integer,integer,text,text,text,text) from public,anon;
revoke all on function public.qbank_save_source_test_topic_review(text,uuid,text,uuid,uuid,uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.qbank_refresh_source_test_topic_proposals(text) to service_role;
grant execute on function public.qbank_source_test_review_overview(text) to authenticated,service_role;
grant execute on function public.qbank_source_test_review_page(text,integer,integer,text,text,text,text) to authenticated,service_role;
grant execute on function public.qbank_save_source_test_topic_review(text,uuid,text,uuid,uuid,uuid,uuid,text,jsonb) to authenticated,service_role;

select public.qbank_refresh_source_test_topic_proposals('canonical-medical-v1');
notify pgrst,'reload schema';
