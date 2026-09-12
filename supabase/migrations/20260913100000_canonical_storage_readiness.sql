-- Canonical storage readiness before classification expands beyond the
-- existing 150-question pilot. No new question is classified by this migration.

create table if not exists public.canonical_classification_runs (
  id uuid primary key default gen_random_uuid(),
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  scope_key text not null,
  scope_type text not null check (scope_type in ('pilot','batch','manual','import')),
  classifier_name text not null,
  classifier_version text not null,
  assignment_method text not null check (assignment_method in ('manual','rule','model','imported')),
  status text not null default 'draft' check (status in ('draft','running','completed','approved','archived','failed')),
  configuration_sha256 text,
  summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (taxonomy_version_id, scope_key),
  unique (id, taxonomy_version_id)
);

comment on table public.canonical_classification_runs is
  'One compact provenance record per classification run; assignments reference it instead of repeating classifier configuration.';
comment on column public.canonical_classification_runs.summary is
  'Aggregate run metrics only. Never store question stems, options, explanations, or per-question evidence here.';

create index if not exists canonical_classification_runs_version_status_idx
  on public.canonical_classification_runs (taxonomy_version_id, status, created_at desc);

alter table public.canonical_question_taxonomy_assignments
  add column if not exists classification_run_id uuid,
  add column if not exists source_test_prior_used boolean not null default false,
  add column if not exists ambiguity_state smallint not null default 0,
  add column if not exists review_state smallint not null default 0,
  add column if not exists evidence_retained boolean not null default false;

alter table public.canonical_question_taxonomy_assignments
  drop constraint if exists canonical_taxonomy_assignment_ambiguity_state_check,
  add constraint canonical_taxonomy_assignment_ambiguity_state_check
    check (ambiguity_state between 0 and 3),
  drop constraint if exists canonical_taxonomy_assignment_review_state_check,
  add constraint canonical_taxonomy_assignment_review_state_check
    check (review_state between 0 and 3),
  drop constraint if exists canonical_taxonomy_assignment_run_fk,
  add constraint canonical_taxonomy_assignment_run_fk
    foreign key (classification_run_id, taxonomy_version_id)
    references public.canonical_classification_runs(id, taxonomy_version_id) on delete restrict;

comment on column public.canonical_question_taxonomy_assignments.ambiguity_state is
  'Compact state: 0 none, 1 uncertain-primary, 2 genuinely integrated, 3 content-overrode-source-prior.';
comment on column public.canonical_question_taxonomy_assignments.review_state is
  'Compact state: 0 draft, 1 reviewed, 2 approved, 3 rejected.';
comment on column public.canonical_question_taxonomy_assignments.evidence_retained is
  'True only when detailed evidence is retained in a sparse review/pilot artifact.';

create index if not exists canonical_taxonomy_assignment_run_idx
  on public.canonical_question_taxonomy_assignments (classification_run_id)
  where classification_run_id is not null;

alter table public.canonical_question_concept_assignments
  add column if not exists classification_run_id uuid;

alter table public.canonical_question_concept_assignments
  drop constraint if exists canonical_concept_assignment_run_fk,
  add constraint canonical_concept_assignment_run_fk
    foreign key (classification_run_id, taxonomy_version_id)
    references public.canonical_classification_runs(id, taxonomy_version_id) on delete restrict;

create index if not exists canonical_concept_assignment_run_idx
  on public.canonical_question_concept_assignments (classification_run_id)
  where classification_run_id is not null;

-- Detailed evidence is sparse and exception-only. High-confidence production
-- assignments keep only the compact columns above.
create table if not exists public.canonical_assignment_review_evidence (
  id uuid primary key default gen_random_uuid(),
  canonical_question_id uuid not null references public.canonical_questions(id) on delete restrict,
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  classification_run_id uuid,
  evidence_kind text not null check (evidence_kind in ('low_confidence','ambiguous','content_override','human_review')),
  evidence jsonb not null,
  review_state smallint not null default 0 check (review_state between 0 and 3),
  evidence_sha256 text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  foreign key (classification_run_id, taxonomy_version_id)
    references public.canonical_classification_runs(id, taxonomy_version_id) on delete restrict
);

comment on table public.canonical_assignment_review_evidence is
  'Sparse detailed evidence for ambiguous, low-confidence, override, or human-reviewed classifications only.';

create unique index if not exists canonical_assignment_evidence_kind_uidx
  on public.canonical_assignment_review_evidence
  (canonical_question_id, taxonomy_version_id, classification_run_id, evidence_kind)
  nulls not distinct;
create index if not exists canonical_assignment_evidence_run_idx
  on public.canonical_assignment_review_evidence (classification_run_id)
  where classification_run_id is not null;
create index if not exists canonical_assignment_evidence_version_idx
  on public.canonical_assignment_review_evidence (taxonomy_version_id);

-- Compact publication target for Source-Test -> canonical Topic mappings.
-- The Topic's parent supplies the optional System; source title and ordering
-- remain solely in qbank_source_tests.
create table if not exists public.canonical_source_test_topic_assignments (
  id uuid primary key default gen_random_uuid(),
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  source_test_id uuid not null references public.qbank_source_tests(id) on delete restrict,
  topic_node_id uuid not null,
  classification_run_id uuid,
  is_primary boolean not null default false,
  is_current boolean not null default true,
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  source_test_prior_method text not null default 'source_title',
  manual_override boolean not null default false,
  review_state smallint not null default 0 check (review_state between 0 and 3),
  assigned_at timestamptz not null default now(),
  assigned_by uuid references auth.users(id) on delete set null,
  foreign key (topic_node_id, taxonomy_version_id)
    references public.canonical_taxonomy_nodes(id, taxonomy_version_id) on delete restrict,
  foreign key (classification_run_id, taxonomy_version_id)
    references public.canonical_classification_runs(id, taxonomy_version_id) on delete restrict
);

comment on table public.canonical_source_test_topic_assignments is
  'Compact approved/draft Source-Test Topic paths. One primary is normal; secondary rows are reserved for genuinely multi-topic Source Tests, not probabilistic alternatives.';

create unique index if not exists canonical_source_test_assignment_current_node_uidx
  on public.canonical_source_test_topic_assignments
  (taxonomy_version_id, source_test_id, topic_node_id) where is_current;
create unique index if not exists canonical_source_test_assignment_primary_uidx
  on public.canonical_source_test_topic_assignments
  (taxonomy_version_id, source_test_id) where is_current and is_primary;
create index if not exists canonical_source_test_assignment_topic_idx
  on public.canonical_source_test_topic_assignments
  (taxonomy_version_id, topic_node_id, is_current);
create index if not exists canonical_source_test_assignment_source_test_idx
  on public.canonical_source_test_topic_assignments (source_test_id);
create index if not exists canonical_source_test_assignment_run_idx
  on public.canonical_source_test_topic_assignments (classification_run_id)
  where classification_run_id is not null;
create index if not exists canonical_source_test_assignment_assigned_by_idx
  on public.canonical_source_test_topic_assignments (assigned_by)
  where assigned_by is not null;

-- Register the already-existing pilot once, without changing its question set
-- or its classification decisions.
with version as (
  select id from public.canonical_taxonomy_versions
  where version_key = 'canonical-medical-v1' and status = 'draft'
), inserted as (
  insert into public.canonical_classification_runs (
    taxonomy_version_id, scope_key, scope_type, classifier_name,
    classifier_version, assignment_method, status, summary, completed_at
  )
  select id, 'canonical-medical-v1-pilot-150', 'pilot',
    'qbank-taxonomy-pilot', 'positive-evidence-v3+source-test-v1.1',
    'model', 'completed',
    jsonb_build_object('question_count', 150, 'scope', 'existing pilot only'), now()
  from version
  on conflict (taxonomy_version_id, scope_key) do update set
    status = excluded.status, summary = excluded.summary,
    completed_at = coalesce(public.canonical_classification_runs.completed_at, excluded.completed_at)
  returning id, taxonomy_version_id
), run as (
  select id, taxonomy_version_id from inserted
  union all
  select r.id, r.taxonomy_version_id
  from public.canonical_classification_runs r join version v on v.id = r.taxonomy_version_id
  where r.scope_key = 'canonical-medical-v1-pilot-150'
  limit 1
)
update public.canonical_question_taxonomy_assignments a set
  classification_run_id = run.id,
  source_test_prior_used = true,
  evidence_retained = true,
  ambiguity_state = case
    when p.content_overrode_source_topic then 3
    when p.evidence_snapshot->>'source_topic_status' = 'ambiguous' then 1
    else 0 end
from run
join public.canonical_taxonomy_assignment_pilot p
  on p.taxonomy_version_id = run.taxonomy_version_id
where a.taxonomy_version_id = run.taxonomy_version_id
  and a.canonical_question_id = p.canonical_question_id;

with run as (
  select id, taxonomy_version_id from public.canonical_classification_runs
  where scope_key = 'canonical-medical-v1-pilot-150'
)
update public.canonical_question_concept_assignments a set
  classification_run_id = run.id
from run
join public.canonical_taxonomy_assignment_pilot p
  on p.taxonomy_version_id = run.taxonomy_version_id
where a.taxonomy_version_id = run.taxonomy_version_id
  and a.canonical_question_id = p.canonical_question_id;

alter table public.canonical_classification_runs enable row level security;
alter table public.canonical_assignment_review_evidence enable row level security;
alter table public.canonical_source_test_topic_assignments enable row level security;

revoke all on table public.canonical_classification_runs from public, anon, authenticated;
revoke all on table public.canonical_assignment_review_evidence from public, anon, authenticated;
revoke all on table public.canonical_source_test_topic_assignments from public, anon, authenticated;
grant all on table public.canonical_classification_runs to service_role;
grant all on table public.canonical_assignment_review_evidence to service_role;
grant all on table public.canonical_source_test_topic_assignments to service_role;

-- These indexes are byte-for-byte duplicates. Keep the constraint-backed or
-- demonstrably used equivalent in every case.
drop index if exists public.questions_platform_source_question_uidx;
drop index if exists public.test_answers_session_idx;
drop index if exists public.idx_user_state_bookmarked;
drop index if exists public.personal_tags_user_name_idx;

notify pgrst, 'reload schema';
