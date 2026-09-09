-- Additive foundation for global question identity and a versioned medical taxonomy.
-- Existing questions remain immutable content versions. Existing qbank_source_occurrences
-- remain the source-of-truth for Platform -> Subject -> Source Test -> ordered occurrence.

create table if not exists public.canonical_questions (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'candidate'
    check (status in ('candidate', 'confirmed', 'deprecated')),
  review_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.canonical_questions is
  'Stable global identities. Rows are created only after deterministic/manual review; source questions are never merged automatically.';

create table if not exists public.canonical_question_versions (
  id uuid primary key default gen_random_uuid(),
  canonical_question_id uuid not null
    references public.canonical_questions(id) on delete restrict,
  question_id uuid not null unique
    references public.questions(id) on delete restrict,
  version_sequence integer not null check (version_sequence > 0),
  version_label text,
  content_sha256 text,
  link_method text not null default 'manual'
    check (link_method in ('manual', 'exact_hash', 'source_declared', 'reviewed_match')),
  linked_by uuid references auth.users(id) on delete set null,
  linked_at timestamptz not null default now(),
  unique (canonical_question_id, version_sequence)
);

comment on table public.canonical_question_versions is
  'Links existing questions (content versions) to a stable global identity. Many versions may share one canonical question; each existing question maps at most once.';

create index if not exists canonical_question_versions_canonical_idx
  on public.canonical_question_versions(canonical_question_id);
create index if not exists canonical_question_versions_hash_idx
  on public.canonical_question_versions(content_sha256)
  where content_sha256 is not null;
create index if not exists canonical_question_versions_linked_by_idx
  on public.canonical_question_versions(linked_by)
  where linked_by is not null;

create table if not exists public.canonical_taxonomy_versions (
  id uuid primary key default gen_random_uuid(),
  version_key text not null unique,
  name text not null,
  description text,
  status text not null default 'draft'
    check (status in ('draft', 'published', 'retired')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  check ((status = 'published' and published_at is not null) or status <> 'published')
);

comment on table public.canonical_taxonomy_versions is
  'Immutable version boundary for future global medical classifications. No source-test metadata belongs here.';

create index if not exists canonical_taxonomy_versions_created_by_idx
  on public.canonical_taxonomy_versions(created_by)
  where created_by is not null;

create table if not exists public.canonical_taxonomy_nodes (
  id uuid primary key default gen_random_uuid(),
  taxonomy_version_id uuid not null
    references public.canonical_taxonomy_versions(id) on delete restrict,
  parent_id uuid,
  node_type text not null
    check (node_type in ('subject', 'system', 'topic', 'subtopic')),
  stable_code text not null,
  name text not null,
  description text,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (taxonomy_version_id, stable_code),
  unique (id, taxonomy_version_id),
  foreign key (parent_id, taxonomy_version_id)
    references public.canonical_taxonomy_nodes(id, taxonomy_version_id)
    on delete restrict
);

comment on table public.canonical_taxonomy_nodes is
  'Versioned global Subject -> System -> Topic -> Subtopic hierarchy, independent of platforms and source tests.';

create index if not exists canonical_taxonomy_nodes_parent_idx
  on public.canonical_taxonomy_nodes(parent_id, taxonomy_version_id, sort_order)
  where parent_id is not null;

create or replace function public.qbank_validate_canonical_taxonomy_parent()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  parent_type text;
begin
  if new.node_type = 'subject' then
    if new.parent_id is not null then
      raise exception 'Canonical subject nodes cannot have a parent';
    end if;
    return new;
  end if;

  if new.parent_id is null then
    raise exception 'Canonical % nodes require a parent', new.node_type;
  end if;

  select node_type into parent_type
  from public.canonical_taxonomy_nodes
  where id = new.parent_id
    and taxonomy_version_id = new.taxonomy_version_id;

  if parent_type is null
     or (new.node_type = 'system' and parent_type <> 'subject')
     or (new.node_type = 'topic' and parent_type <> 'system')
     or (new.node_type = 'subtopic' and parent_type <> 'topic') then
    raise exception 'Invalid canonical taxonomy parent: % cannot be beneath %',
      new.node_type, coalesce(parent_type, 'missing');
  end if;

  return new;
end;
$$;

drop trigger if exists canonical_taxonomy_nodes_validate_parent
  on public.canonical_taxonomy_nodes;
create trigger canonical_taxonomy_nodes_validate_parent
before insert or update of parent_id, node_type, taxonomy_version_id
on public.canonical_taxonomy_nodes
for each row execute function public.qbank_validate_canonical_taxonomy_parent();

create table if not exists public.canonical_question_taxonomy_assignments (
  id uuid primary key default gen_random_uuid(),
  canonical_question_id uuid not null
    references public.canonical_questions(id) on delete restrict,
  taxonomy_version_id uuid not null
    references public.canonical_taxonomy_versions(id) on delete restrict,
  taxonomy_node_id uuid not null,
  is_primary boolean not null default false,
  is_current boolean not null default true,
  assignment_method text not null
    check (assignment_method in ('manual', 'rule', 'model', 'imported')),
  classifier_name text,
  classifier_version text,
  confidence numeric(5,4)
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  assigned_at timestamptz not null default now(),
  assigned_by uuid references auth.users(id) on delete set null,
  manual_override boolean not null default false,
  supersedes_assignment_id uuid
    references public.canonical_question_taxonomy_assignments(id) on delete restrict,
  notes text,
  foreign key (taxonomy_node_id, taxonomy_version_id)
    references public.canonical_taxonomy_nodes(id, taxonomy_version_id)
    on delete restrict,
  check (not manual_override or assignment_method = 'manual')
);

comment on table public.canonical_question_taxonomy_assignments is
  'Versioned, provenance-rich canonical classification. Multiple current concepts are allowed, with at most one current primary path per question and taxonomy version.';

create unique index if not exists canonical_assignment_current_node_uidx
  on public.canonical_question_taxonomy_assignments
    (canonical_question_id, taxonomy_version_id, taxonomy_node_id)
  where is_current;
create unique index if not exists canonical_assignment_primary_uidx
  on public.canonical_question_taxonomy_assignments
    (canonical_question_id, taxonomy_version_id)
  where is_current and is_primary;
create index if not exists canonical_assignment_question_idx
  on public.canonical_question_taxonomy_assignments(canonical_question_id);
create index if not exists canonical_assignment_node_idx
  on public.canonical_question_taxonomy_assignments
    (taxonomy_version_id, taxonomy_node_id, is_current);
create index if not exists canonical_assignment_assigned_by_idx
  on public.canonical_question_taxonomy_assignments(assigned_by)
  where assigned_by is not null;
create index if not exists canonical_assignment_supersedes_idx
  on public.canonical_question_taxonomy_assignments(supersedes_assignment_id)
  where supersedes_assignment_id is not null;

alter table public.canonical_questions enable row level security;
alter table public.canonical_question_versions enable row level security;
alter table public.canonical_taxonomy_versions enable row level security;
alter table public.canonical_taxonomy_nodes enable row level security;
alter table public.canonical_question_taxonomy_assignments enable row level security;

revoke all on table public.canonical_questions from public, anon, authenticated;
revoke all on table public.canonical_question_versions from public, anon, authenticated;
revoke all on table public.canonical_taxonomy_versions from public, anon, authenticated;
revoke all on table public.canonical_taxonomy_nodes from public, anon, authenticated;
revoke all on table public.canonical_question_taxonomy_assignments from public, anon, authenticated;
revoke all on function public.qbank_validate_canonical_taxonomy_parent() from public, anon, authenticated;

grant all on table public.canonical_questions to service_role;
grant all on table public.canonical_question_versions to service_role;
grant all on table public.canonical_taxonomy_versions to service_role;
grant all on table public.canonical_taxonomy_nodes to service_role;
grant all on table public.canonical_question_taxonomy_assignments to service_role;

comment on function public.qbank_validate_canonical_taxonomy_parent() is
  'Enforces Subject -> System -> Topic -> Subtopic within one canonical taxonomy version.';
