-- PREPLADDER CONCEPT V1: compact, service-only, idempotent persistence.
-- This migration is additive. It does not alter source questions or learner state.

create table public.prepladder_concept_v1_concepts (
  normalized_concept_ref text not null,
  classifier_version text not null,
  subject text not null,
  normalized_label text not null,
  created_at timestamptz not null default now(),
  primary key (normalized_concept_ref, classifier_version),
  unique (subject, normalized_label, classifier_version),
  check (classifier_version = 'safe-v1-filter-2026-09-14'),
  check (normalized_concept_ref ~ '^[0-9a-f]{16}$'),
  check (length(subject) between 1 and 80),
  check (length(normalized_label) between 1 and 200)
);

create table public.prepladder_concept_v1_assignments (
  question_id uuid not null references public.questions(id) on delete restrict,
  normalized_concept_ref text not null,
  classifier_version text not null,
  confidence real not null check (confidence between 0 and 1),
  provenance_summary text not null,
  review_status text not null check (review_status = 'safe_v1'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (question_id, classifier_version),
  foreign key (normalized_concept_ref, classifier_version)
    references public.prepladder_concept_v1_concepts
      (normalized_concept_ref, classifier_version)
    on delete restrict,
  check (classifier_version = 'safe-v1-filter-2026-09-14'),
  check (length(provenance_summary) between 1 and 120)
);

create index prepladder_concept_v1_assignments_concept_idx
  on public.prepladder_concept_v1_assignments
    (normalized_concept_ref, classifier_version);

alter table public.prepladder_concept_v1_concepts enable row level security;
alter table public.prepladder_concept_v1_assignments enable row level security;

revoke all on table public.prepladder_concept_v1_concepts from public, anon, authenticated;
revoke all on table public.prepladder_concept_v1_assignments from public, anon, authenticated;
grant select, insert, update, delete on table public.prepladder_concept_v1_concepts to service_role;
grant select, insert, update, delete on table public.prepladder_concept_v1_assignments to service_role;

comment on table public.prepladder_concept_v1_concepts is
  'Frozen generated concept registry for the medically validated PrepLadder SAFE_V1 subset; service-only.';
comment on table public.prepladder_concept_v1_assignments is
  'Compact PrepLadder SAFE_V1 question-to-generated-concept links; contains no source content or learner state.';

create or replace function public.persist_prepladder_concept_v1(rows_json jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  expected_version constant text := 'safe-v1-filter-2026-09-14';
  input_count integer;
  inserted_count integer := 0;
  updated_count integer := 0;
  skipped_count integer := 0;
begin
  if jsonb_typeof(rows_json) <> 'array' then
    raise exception 'SAFE_V1 payload must be a JSON array';
  end if;

  create temporary table incoming_safe_v1 (
    question_id uuid not null,
    normalized_concept_ref text not null,
    classifier_version text not null,
    subject text not null,
    normalized_label text not null,
    confidence real not null,
    provenance_summary text not null,
    review_status text not null,
    primary key (question_id, classifier_version)
  ) on commit drop;

  insert into incoming_safe_v1
  select x.question_id, x.normalized_concept_ref, x.classifier_version,
         x.subject, x.normalized_label, x.confidence,
         x.provenance_summary, x.review_status
  from jsonb_to_recordset(rows_json) as x(
    question_id uuid,
    normalized_concept_ref text,
    classifier_version text,
    subject text,
    normalized_label text,
    confidence real,
    provenance_summary text,
    review_status text
  );

  select count(*) into input_count from incoming_safe_v1;
  if input_count <> 1355 or jsonb_array_length(rows_json) <> 1355 then
    raise exception 'Expected exactly 1355 unique SAFE_V1 rows, received % rows (% JSON items)',
      input_count, jsonb_array_length(rows_json);
  end if;
  if exists (
    select 1 from incoming_safe_v1
    where classifier_version <> expected_version
       or review_status <> 'safe_v1'
       or normalized_concept_ref !~ '^[0-9a-f]{16}$'
       or confidence not between 0 and 1
       or length(provenance_summary) not between 1 and 120
  ) then
    raise exception 'SAFE_V1 payload contract failed';
  end if;
  if exists (
    select 1 from incoming_safe_v1 i
    left join public.questions q on q.id = i.question_id
    where q.id is null
  ) then
    raise exception 'SAFE_V1 payload contains unresolved question IDs';
  end if;
  if exists (
    select 1 from incoming_safe_v1
    group by normalized_concept_ref, classifier_version
    having count(distinct (subject, normalized_label)) <> 1
  ) then
    raise exception 'SAFE_V1 payload contains conflicting normalized concept references';
  end if;

  insert into public.prepladder_concept_v1_concepts (
    normalized_concept_ref, classifier_version, subject, normalized_label
  )
  select distinct normalized_concept_ref, classifier_version, subject, normalized_label
  from incoming_safe_v1
  on conflict (normalized_concept_ref, classifier_version) do nothing;

  if exists (
    select 1
    from incoming_safe_v1 i
    join public.prepladder_concept_v1_concepts c
      using (normalized_concept_ref, classifier_version)
    where (c.subject, c.normalized_label) is distinct from (i.subject, i.normalized_label)
  ) then
    raise exception 'Existing normalized concept conflicts with SAFE_V1 payload';
  end if;

  select count(*) into inserted_count
  from incoming_safe_v1 i
  left join public.prepladder_concept_v1_assignments a
    using (question_id, classifier_version)
  where a.question_id is null;

  select count(*) into updated_count
  from incoming_safe_v1 i
  join public.prepladder_concept_v1_assignments a
    using (question_id, classifier_version)
  where (a.normalized_concept_ref, a.confidence, a.provenance_summary, a.review_status)
        is distinct from
        (i.normalized_concept_ref, i.confidence, i.provenance_summary, i.review_status);

  skipped_count := input_count - inserted_count - updated_count;

  insert into public.prepladder_concept_v1_assignments (
    question_id, normalized_concept_ref, classifier_version, confidence,
    provenance_summary, review_status
  )
  select question_id, normalized_concept_ref, classifier_version, confidence,
         provenance_summary, review_status
  from incoming_safe_v1
  on conflict (question_id, classifier_version) do update set
    normalized_concept_ref = excluded.normalized_concept_ref,
    confidence = excluded.confidence,
    provenance_summary = excluded.provenance_summary,
    review_status = excluded.review_status,
    updated_at = now()
  where (prepladder_concept_v1_assignments.normalized_concept_ref,
         prepladder_concept_v1_assignments.confidence,
         prepladder_concept_v1_assignments.provenance_summary,
         prepladder_concept_v1_assignments.review_status)
        is distinct from
        (excluded.normalized_concept_ref, excluded.confidence,
         excluded.provenance_summary, excluded.review_status);

  return jsonb_build_object(
    'expected', input_count,
    'inserted', inserted_count,
    'updated', updated_count,
    'skipped', skipped_count,
    'failed', 0
  );
end;
$$;

revoke all on function public.persist_prepladder_concept_v1(jsonb) from public, anon, authenticated;
grant execute on function public.persist_prepladder_concept_v1(jsonb) to service_role;

create or replace function public.prepladder_concept_v1_checkpoint()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'assignment_rows', (select count(*) from public.prepladder_concept_v1_assignments),
    'concept_rows', (select count(*) from public.prepladder_concept_v1_concepts),
    'assignment_relation_bytes', pg_total_relation_size('public.prepladder_concept_v1_assignments'::regclass),
    'concept_relation_bytes', pg_total_relation_size('public.prepladder_concept_v1_concepts'::regclass)
  );
$$;

revoke all on function public.prepladder_concept_v1_checkpoint() from public, anon, authenticated;
grant execute on function public.prepladder_concept_v1_checkpoint() to service_role;
