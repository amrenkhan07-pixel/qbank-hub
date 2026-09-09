import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flattenTaxonomy, taxonomyVersion } from './taxonomy-v1-catalog.mjs';

const target = resolve(process.argv[2] || 'supabase/migrations/20260909155548_canonical_medical_taxonomy_v1_draft.sql');
const rows = flattenTaxonomy();
const byCode = new Map(rows.map((row) => [row.code, row]));
const quote = (value) => `'${String(value ?? '').replaceAll("'", "''")}'`;
const nodeValues = rows.map((row) => {
  const chain = [];
  let current = row;
  while (current) {
    chain.unshift(current);
    current = current.parentCode ? byCode.get(current.parentCode) : null;
  }
  const meta = {
    path: chain.map((item) => item.name).join(' → '),
    subject: chain.find((item) => item.type === 'subject')?.name || null,
    system: chain.find((item) => item.type === 'system')?.name || null,
    topic: chain.find((item) => item.type === 'topic')?.name || null,
    subtopic: chain.find((item) => item.type === 'subtopic')?.name || null,
    review_status: 'draft',
  };
  return `(${quote(row.code)}, ${row.parentCode ? quote(row.parentCode) : 'null'}, ${quote(row.type)}, ${quote(row.name)}, ${row.sort}, ${quote(JSON.stringify(meta))}::jsonb)`;
});

const rules = [];
for (const row of rows) {
  if (row.type === 'topic') {
    for (const alias of row.aliases || []) rules.push({ code: row.code, phrase: alias, weight: alias.includes(' ') ? 4 : 3, basis: 'reviewed topic alias' });
  }
  if (row.type === 'subtopic' && row.name.length >= 8) rules.push({ code: row.code, phrase: row.name.toLowerCase(), weight: 6, basis: 'exact canonical subtopic phrase' });
}
const ruleValues = rules.map((rule) => `(${quote(rule.code)}, ${quote(rule.phrase.toLowerCase())}, ${rule.weight}, ${quote(rule.basis)})`);

const sql = `-- Canonical Medical Taxonomy v1 DRAFT.
-- Additive and review-only: no existing question, option, source occurrence,
-- learner state, or canonical question-assignment row is changed.

create or replace function public.qbank_validate_canonical_taxonomy_parent()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare parent_type text;
begin
  if new.node_type = 'subject' then
    if new.parent_id is not null then raise exception 'Canonical subject nodes cannot have a parent'; end if;
    return new;
  end if;
  if new.parent_id is null then raise exception 'Canonical % nodes require a parent', new.node_type; end if;
  select node_type into parent_type from public.canonical_taxonomy_nodes
   where id = new.parent_id and taxonomy_version_id = new.taxonomy_version_id;
  if parent_type is null
     or (new.node_type = 'system' and parent_type <> 'subject')
     or (new.node_type = 'topic' and parent_type not in ('subject','system'))
     or (new.node_type = 'subtopic' and parent_type <> 'topic') then
    raise exception 'Invalid canonical taxonomy parent: % cannot be beneath %', new.node_type, coalesce(parent_type,'missing');
  end if;
  return new;
end;
$$;
comment on function public.qbank_validate_canonical_taxonomy_parent() is
  'Enforces Subject -> optional System -> Topic -> Subtopic within one taxonomy version.';
revoke all on function public.qbank_validate_canonical_taxonomy_parent() from public, anon, authenticated;

insert into public.canonical_taxonomy_versions(version_key,name,description,status)
values (${quote(taxonomyVersion.key)},${quote(taxonomyVersion.name)},${quote(taxonomyVersion.description)},'draft')
on conflict (version_key) do update set
  name=excluded.name, description=excluded.description
where public.canonical_taxonomy_versions.status='draft';

create temporary table qbank_taxonomy_v1_seed(
  stable_code text primary key, parent_code text, node_type text, name text,
  sort_order integer, metadata jsonb
) on commit drop;
insert into qbank_taxonomy_v1_seed values
${nodeValues.join(',\n')};

do $$
declare version_uuid uuid; level_type text;
begin
  select id into version_uuid from public.canonical_taxonomy_versions where version_key=${quote(taxonomyVersion.key)};
  foreach level_type in array array['subject','system','topic','subtopic'] loop
    insert into public.canonical_taxonomy_nodes(taxonomy_version_id,parent_id,node_type,stable_code,name,sort_order,metadata)
    select version_uuid,p.id,s.node_type,s.stable_code,s.name,s.sort_order,s.metadata
    from qbank_taxonomy_v1_seed s
    left join public.canonical_taxonomy_nodes p
      on p.taxonomy_version_id=version_uuid and p.stable_code=s.parent_code
    where s.node_type=level_type
    on conflict (taxonomy_version_id,stable_code) do update set
      parent_id=excluded.parent_id,node_type=excluded.node_type,name=excluded.name,
      sort_order=excluded.sort_order,metadata=excluded.metadata;
  end loop;
end $$;

create table if not exists public.canonical_taxonomy_node_relations(
  id uuid primary key default gen_random_uuid(),
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  from_node_id uuid not null,
  to_node_id uuid not null,
  relation_type text not null check (relation_type in ('related','confusable','prerequisite','broader_reference')),
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (from_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  foreign key (to_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  unique(taxonomy_version_id,from_node_id,to_node_id,relation_type),
  check (from_node_id<>to_node_id)
);
comment on table public.canonical_taxonomy_node_relations is
  'Versioned related/confusable/prerequisite concept edges for future concept-aware testing; no learner state is stored here.';
create index if not exists canonical_taxonomy_relations_from_idx on public.canonical_taxonomy_node_relations(taxonomy_version_id,from_node_id,relation_type);
create index if not exists canonical_taxonomy_relations_to_idx on public.canonical_taxonomy_node_relations(taxonomy_version_id,to_node_id,relation_type);

create table if not exists public.canonical_global_evidence(
  id uuid primary key default gen_random_uuid(),
  canonical_question_id uuid references public.canonical_questions(id) on delete restrict,
  taxonomy_version_id uuid references public.canonical_taxonomy_versions(id) on delete restrict,
  taxonomy_node_id uuid,
  evidence_type text not null check (evidence_type in ('neet_pg_pyq','inicet_pyq','pyq_recency','grand_test','curated_subject_test','platform_recurrence','core_btr','curated_source')),
  evidence_key text not null unique,
  exam_year integer check (exam_year is null or exam_year between 1950 and 2200),
  raw_value numeric,
  source_reference text,
  metadata jsonb not null default '{}'::jsonb,
  observed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (taxonomy_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  check ((taxonomy_node_id is null and taxonomy_version_id is null) or (taxonomy_node_id is not null and taxonomy_version_id is not null)),
  check (canonical_question_id is not null or taxonomy_node_id is not null)
);
comment on table public.canonical_global_evidence is
  'Independent raw population-level evidence for future Global Importance. Deliberately contains no user accuracy, timing, SRM, confidence, or mastery signals.';
create index if not exists canonical_global_evidence_question_idx on public.canonical_global_evidence(canonical_question_id,evidence_type) where canonical_question_id is not null;
create index if not exists canonical_global_evidence_node_idx on public.canonical_global_evidence(taxonomy_version_id,taxonomy_node_id,evidence_type) where taxonomy_node_id is not null;

create table if not exists public.canonical_taxonomy_draft_rules(
  id uuid primary key default gen_random_uuid(),
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  taxonomy_node_id uuid not null,
  match_phrase text not null,
  evidence_weight smallint not null check (evidence_weight between 1 and 10),
  evidence_basis text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (taxonomy_node_id,taxonomy_version_id) references public.canonical_taxonomy_nodes(id,taxonomy_version_id) on delete restrict,
  unique(taxonomy_version_id,taxonomy_node_id,match_phrase)
);
comment on table public.canonical_taxonomy_draft_rules is
  'Transparent phrase evidence used only for the review dry run; it does not create question assignments.';
create index if not exists canonical_taxonomy_draft_rules_version_idx on public.canonical_taxonomy_draft_rules(taxonomy_version_id,enabled,taxonomy_node_id);

create temporary table qbank_taxonomy_v1_rules(stable_code text,match_phrase text,evidence_weight smallint,evidence_basis text) on commit drop;
insert into qbank_taxonomy_v1_rules values
${ruleValues.join(',\n')};
insert into public.canonical_taxonomy_draft_rules(taxonomy_version_id,taxonomy_node_id,match_phrase,evidence_weight,evidence_basis)
select n.taxonomy_version_id,n.id,r.match_phrase,r.evidence_weight,r.evidence_basis
from qbank_taxonomy_v1_rules r
join public.canonical_taxonomy_versions v on v.version_key=${quote(taxonomyVersion.key)}
join public.canonical_taxonomy_nodes n on n.taxonomy_version_id=v.id and n.stable_code=r.stable_code
on conflict (taxonomy_version_id,taxonomy_node_id,match_phrase) do update set
 evidence_weight=excluded.evidence_weight,evidence_basis=excluded.evidence_basis,enabled=true;

alter table public.canonical_taxonomy_node_relations enable row level security;
alter table public.canonical_global_evidence enable row level security;
alter table public.canonical_taxonomy_draft_rules enable row level security;
revoke all on table public.canonical_taxonomy_node_relations from public,anon,authenticated;
revoke all on table public.canonical_global_evidence from public,anon,authenticated;
revoke all on table public.canonical_taxonomy_draft_rules from public,anon,authenticated;
grant all on table public.canonical_taxonomy_node_relations to service_role;
grant all on table public.canonical_global_evidence to service_role;
grant all on table public.canonical_taxonomy_draft_rules to service_role;

-- Authenticated review access is deliberately read-only and limited to draft taxonomy material.
grant select on table public.canonical_taxonomy_versions,public.canonical_taxonomy_nodes to authenticated;
create policy canonical_taxonomy_versions_authenticated_read on public.canonical_taxonomy_versions for select to authenticated using ((select auth.uid()) is not null);
create policy canonical_taxonomy_nodes_authenticated_read on public.canonical_taxonomy_nodes for select to authenticated using ((select auth.uid()) is not null);

create or replace function public.qbank_taxonomy_review(p_version_key text default 'canonical-medical-v1')
returns jsonb language sql stable security invoker set search_path=''
as $$
  select jsonb_build_object(
    'version',jsonb_build_object('key',v.version_key,'name',v.name,'status',v.status,'description',v.description),
    'counts',coalesce((select jsonb_object_agg(node_type,cnt) from (select node_type,count(*) cnt from public.canonical_taxonomy_nodes where taxonomy_version_id=v.id group by node_type) c),'{}'::jsonb),
    'nodes',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'parent_id',n.parent_id,'type',n.node_type,'code',n.stable_code,'name',n.name,'path',n.metadata->>'path','review_status',n.metadata->>'review_status','sort_order',n.sort_order) order by n.metadata->>'path') from public.canonical_taxonomy_nodes n where n.taxonomy_version_id=v.id),'[]'::jsonb)
  ) from public.canonical_taxonomy_versions v where v.version_key=p_version_key;
$$;
revoke all on function public.qbank_taxonomy_review(text) from public,anon;
grant execute on function public.qbank_taxonomy_review(text) to authenticated,service_role;

create or replace function public.qbank_taxonomy_classification_dry_run(p_version_key text default 'canonical-medical-v1',p_limit integer default 380)
returns table(
  question_id uuid,platform text,source_test text,existing_subject text,is_pyq boolean,
  proposed_system text,proposed_topic text,proposed_subtopic text,proposed_path text,
  classifier_confidence numeric,ambiguity boolean,secondary_concept text,
  cross_subject_ambiguity boolean,reason text
) language sql stable security invoker set search_path=''
as $$
with version_row as (
  select id from public.canonical_taxonomy_versions where version_key=p_version_key and status='draft'
), ranked_sample as (
  select q.*,s.name subject_name,p.name platform_name,
    row_number() over(partition by s.id,(q.is_pyq is true) order by md5(q.id::text)) bucket_rank
  from public.questions q join public.subjects s on s.id=q.subject_id join public.platforms p on p.id=q.platform_id
  where q.is_usable is true
), initial_sample as (
  select * from ranked_sample where bucket_rank<=greatest(1,ceil(least(greatest(p_limit,1),500)::numeric/38.0))
), sample as (
  select * from initial_sample order by md5(id::text) limit least(greatest(p_limit,1),500)
), matches as (
  select q.id question_id,n.id node_id,n.metadata,n.metadata->>'subject' canonical_subject,
    sum(r.evidence_weight)::numeric score,string_agg(distinct r.match_phrase,', ' order by r.match_phrase) phrases
  from sample q cross join version_row v
  join public.canonical_taxonomy_draft_rules r on r.taxonomy_version_id=v.id and r.enabled
  join public.canonical_taxonomy_nodes n on n.id=r.taxonomy_node_id and n.taxonomy_version_id=v.id
  where position(r.match_phrase in lower(coalesce(q.question_text,'')||' '||coalesce(q.explanation_html,'')))>0
  group by q.id,n.id,n.metadata,n.metadata->>'subject'
), same_subject as (
  select m.*,row_number() over(partition by m.question_id order by m.score desc,m.node_id) choice_rank,
    sum(m.score) over(partition by m.question_id) total_score,
    lead(m.metadata->>'path') over(partition by m.question_id order by m.score desc,m.node_id) second_path,
    lead(m.score) over(partition by m.question_id order by m.score desc,m.node_id) second_score
  from matches m join sample q on q.id=m.question_id and q.subject_name=m.canonical_subject
), foreign_best as (
  select m.question_id,max(m.score) score from matches m join sample q on q.id=m.question_id and q.subject_name<>m.canonical_subject group by m.question_id
)
select q.id,q.platform_name,coalesce(q.source_test_label,q.source_reference),q.subject_name,q.is_pyq,
  top.metadata->>'system',top.metadata->>'topic',top.metadata->>'subtopic',top.metadata->>'path',
  case when top.score is null then 0 else round((top.score/nullif(top.total_score,0))*(1-exp(-top.score/3.0)),4) end,
  coalesce(top.second_score>=top.score*0.75,false),top.second_path,
  coalesce(f.score>=top.score*0.75,false),
  case when top.score is null then 'No reviewed draft rule matched; left unclassifiable.'
       else 'Matched reviewed phrase evidence: '||top.phrases||'. Confidence is evidence dominance × evidence coverage, not a clinical probability.' end
from sample q left join same_subject top on top.question_id=q.id and top.choice_rank=1 left join foreign_best f on f.question_id=q.id
order by q.subject_name,q.is_pyq desc,md5(q.id::text);
$$;
revoke all on function public.qbank_taxonomy_classification_dry_run(text,integer) from public,anon;
grant execute on function public.qbank_taxonomy_classification_dry_run(text,integer) to authenticated,service_role;
comment on function public.qbank_taxonomy_classification_dry_run(text,integer) is
  'Read-only, deterministic, server-bounded review sample (max 500). Writes no canonical assignments or learner state.';

notify pgrst,'reload schema';
`;

writeFileSync(target, sql);
console.log(JSON.stringify({ target, nodes: rows.length, rules: rules.length }, null, 2));
