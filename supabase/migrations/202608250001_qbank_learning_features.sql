-- QBank Hub: additive test and personal-study foundations.
-- Written for the live schema inspected on 2026-08-27. This preserves the
-- existing topic hierarchy, text question_tags, attempts, and test records.

select pg_advisory_xact_lock(hashtextextended('qbank:202608250001', 0));

-- Fail before DDL if this is pointed at a different/incompatible project.
do $$
declare v_problem text;
begin
  with required(table_name, column_name, udt_name) as (
    values
      ('platform_subjects', 'id', 'uuid'), ('subjects', 'id', 'uuid'),
      ('questions', 'id', 'uuid'), ('questions', 'platform_id', 'uuid'),
      ('questions', 'subject_id', 'uuid'), ('questions', 'topic_id', 'uuid'),
      ('topics', 'id', 'uuid'), ('topics', 'platform_subject_id', 'uuid'),
      ('question_options', 'question_id', 'uuid'),
      ('question_attempts', 'question_id', 'uuid'),
      ('question_tags', 'tag', 'text'),
      ('test_sessions', 'id', 'uuid'), ('test_sessions', 'user_id', 'uuid'),
      ('test_session_questions', 'session_id', 'uuid'),
      ('test_session_questions', 'question_id', 'uuid')
  )
  select string_agg(format('%I.%I (%s)', r.table_name, r.column_name, r.udt_name), ', ')
  into v_problem
  from required r
  left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = r.table_name
   and c.column_name = r.column_name and c.udt_name = r.udt_name
  where c.column_name is null;

  if v_problem is not null then
    raise exception 'QBank migration stopped; missing or incompatible live columns: %', v_problem;
  end if;
end $$;

-- Systems follow the live platform_subjects -> topics taxonomy.
create table if not exists public.systems (
  id uuid primary key default gen_random_uuid(),
  platform_subject_id uuid not null references public.platform_subjects(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 300),
  slug text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (platform_subject_id, name)
);

alter table public.topics
  add column if not exists system_id uuid,
  add column if not exists slug text;

alter table public.questions
  add column if not exists system_id uuid,
  add column if not exists exam_year integer,
  add column if not exists exam_shift text,
  add column if not exists source_reference text,
  add column if not exists image_path text,
  add column if not exists status text not null default 'published',
  add column if not exists version integer not null default 1,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.topics'::regclass and conname = 'topics_system_id_fkey') then
    alter table public.topics add constraint topics_system_id_fkey
      foreign key (system_id) references public.systems(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.questions'::regclass and conname = 'questions_system_id_fkey') then
    alter table public.questions add constraint questions_system_id_fkey
      foreign key (system_id) references public.systems(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.questions'::regclass and conname = 'questions_difficulty_valid') then
    alter table public.questions add constraint questions_difficulty_valid
      check (difficulty is null or difficulty in ('easy', 'medium', 'hard')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.questions'::regclass and conname = 'questions_exam_year_valid') then
    alter table public.questions add constraint questions_exam_year_valid
      check (exam_year is null or exam_year between 1950 and 2100) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.questions'::regclass and conname = 'questions_status_valid') then
    alter table public.questions add constraint questions_status_valid
      check (status in ('draft', 'published', 'archived')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.questions'::regclass and conname = 'questions_version_positive') then
    alter table public.questions add constraint questions_version_positive
      check (version > 0) not valid;
  end if;
end $$;

alter table public.questions validate constraint questions_difficulty_valid;
alter table public.questions validate constraint questions_exam_year_valid;
alter table public.questions validate constraint questions_status_valid;
alter table public.questions validate constraint questions_version_positive;

create table if not exists public.question_topics (
  question_id uuid not null references public.questions(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  primary key (question_id, topic_id)
);

insert into public.question_topics (question_id, topic_id)
select id, topic_id from public.questions where topic_id is not null
on conflict do nothing;

-- Keep live public.question_tags(id, question_id, tag) as the canonical tag model.
create index if not exists question_tags_tag_question_idx
  on public.question_tags (tag, question_id);

create table if not exists public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, question_id)
);

create table if not exists public.question_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  body text not null check (char_length(body) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, question_id)
);

create table if not exists public.review_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  reason text not null check (reason in ('incorrect', 'marked', 'bookmark', 'weak_topic')),
  due_at timestamptz not null default now(),
  last_reviewed_at timestamptz,
  review_count integer not null default 0 check (review_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, question_id)
);

create table if not exists public.question_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  reason text not null check (reason in ('wrong_answer', 'wrong_explanation', 'ambiguous', 'poor_quality', 'broken_image', 'other')),
  details text check (char_length(details) <= 5000),
  status text not null default 'open' check (status in ('open', 'reviewed', 'resolved', 'dismissed')),
  created_at timestamptz not null default now()
);

-- Extend rather than recreate the live test tables.
alter table public.test_sessions
  add column if not exists status text,
  add column if not exists duration_minutes integer,
  add column if not exists current_position integer not null default 0,
  add column if not exists incorrect_count integer,
  add column if not exists unanswered_count integer,
  add column if not exists timed_out boolean not null default false,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update public.test_sessions
set status = case when completed_at is null then 'in_progress' else 'completed' end
where status is null;

alter table public.test_sessions alter column status set default 'in_progress';
alter table public.test_sessions alter column status set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.test_sessions'::regclass and conname = 'test_sessions_status_valid') then
    alter table public.test_sessions add constraint test_sessions_status_valid
      check (status in ('in_progress', 'completed', 'timed_out', 'abandoned')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.test_sessions'::regclass and conname = 'test_sessions_duration_valid') then
    alter table public.test_sessions add constraint test_sessions_duration_valid
      check (duration_minutes is null or duration_minutes between 1 and 720) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.test_sessions'::regclass and conname = 'test_sessions_position_nonnegative') then
    alter table public.test_sessions add constraint test_sessions_position_nonnegative
      check (current_position >= 0) not valid;
  end if;
end $$;

alter table public.test_sessions validate constraint test_sessions_status_valid;
alter table public.test_sessions validate constraint test_sessions_duration_valid;
alter table public.test_sessions validate constraint test_sessions_position_nonnegative;

alter table public.test_session_questions
  add column if not exists question_snapshot jsonb,
  add column if not exists created_at timestamptz not null default now();

update public.test_session_questions sq
set question_snapshot = jsonb_build_object(
  'id', q.id, 'question_text', q.question_text, 'options', q.options,
  'correct_answer', q.correct_answer, 'explanation_html', q.explanation_html,
  'question_images', q.question_images, 'explanation_images', q.explanation_images
)
from public.questions q
where q.id = sq.question_id and sq.question_snapshot is null;

do $$
begin
  if exists (select 1 from public.test_session_questions where question_snapshot is null) then
    raise exception 'QBank migration stopped; a session question has no matching question.';
  end if;
end $$;

alter table public.test_session_questions alter column question_snapshot set not null;
create unique index if not exists test_session_questions_session_position_uidx
  on public.test_session_questions (session_id, position);

create table if not exists public.test_answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.test_sessions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete restrict,
  selected_option text,
  marked_for_review boolean not null default false,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, question_id)
);

create index if not exists systems_platform_subject_sort_idx on public.systems (platform_subject_id, sort_order, name);
create index if not exists topics_system_sort_idx on public.topics (system_id, sort_order, name) where system_id is not null;
create index if not exists questions_published_filters_idx on public.questions (status, platform_id, subject_id, system_id, difficulty) where status = 'published';
create index if not exists question_topics_topic_idx on public.question_topics (topic_id, question_id);
create index if not exists bookmarks_user_created_idx on public.bookmarks (user_id, created_at desc);
create index if not exists review_queue_user_due_idx on public.review_queue (user_id, due_at);
create index if not exists reports_question_status_idx on public.question_reports (question_id, status);
create index if not exists reports_user_created_idx on public.question_reports (user_id, created_at desc);
create index if not exists test_sessions_user_updated_idx on public.test_sessions (user_id, updated_at desc);
create index if not exists test_answers_session_idx on public.test_answers (session_id, question_id);

create or replace function public.qbank_set_updated_at()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists qbank_questions_updated_at on public.questions;
create trigger qbank_questions_updated_at before update on public.questions for each row execute function public.qbank_set_updated_at();
drop trigger if exists qbank_notes_updated_at on public.question_notes;
create trigger qbank_notes_updated_at before update on public.question_notes for each row execute function public.qbank_set_updated_at();
drop trigger if exists qbank_review_updated_at on public.review_queue;
create trigger qbank_review_updated_at before update on public.review_queue for each row execute function public.qbank_set_updated_at();
drop trigger if exists qbank_sessions_updated_at on public.test_sessions;
create trigger qbank_sessions_updated_at before update on public.test_sessions for each row execute function public.qbank_set_updated_at();
drop trigger if exists qbank_answers_updated_at on public.test_answers;
create trigger qbank_answers_updated_at before update on public.test_answers for each row execute function public.qbank_set_updated_at();

-- Finalize a test from its snapshot while retaining the live total_* columns.
create or replace function public.submit_test_session(p_session_id uuid, p_timed_out boolean default false)
returns public.test_sessions
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_session public.test_sessions;
  v_correct integer := 0;
  v_answered integer := 0;
  v_total integer := 0;
  v_timed_out boolean := false;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_session from public.test_sessions
  where id = p_session_id and user_id = auth.uid() for update;
  if not found then raise exception 'Test session not found'; end if;
  if v_session.status <> 'in_progress' then return v_session; end if;

  v_timed_out := p_timed_out or (
    v_session.duration_minutes is not null
    and now() >= v_session.started_at + make_interval(mins => v_session.duration_minutes)
  );
  select count(*) into v_total from public.test_session_questions where session_id = p_session_id;
  select count(*) into v_answered from public.test_answers
    where session_id = p_session_id and nullif(selected_option, '') is not null;
  select count(*) into v_correct
  from public.test_session_questions sq
  join public.test_answers a on a.session_id = sq.session_id and a.question_id = sq.question_id
  where sq.session_id = p_session_id
    and upper(coalesce(a.selected_option, '')) = upper(left(coalesce(sq.question_snapshot ->> 'correct_answer', ''), 1));

  update public.test_sessions
  set status = case when v_timed_out then 'timed_out' else 'completed' end,
      completed_at = now(), timed_out = v_timed_out,
      total_questions = v_total, total_correct = v_correct,
      incorrect_count = v_answered - v_correct,
      unanswered_count = v_total - v_answered,
      total_time_seconds = greatest(0, extract(epoch from now() - started_at)::integer)
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$$;

revoke all on function public.submit_test_session(uuid, boolean) from public;
grant execute on function public.submit_test_session(uuid, boolean) to authenticated;

alter table public.systems enable row level security;
alter table public.question_topics enable row level security;
alter table public.bookmarks enable row level security;
alter table public.question_notes enable row level security;
alter table public.review_queue enable row level security;
alter table public.question_reports enable row level security;
alter table public.test_answers enable row level security;

-- Replace the live ALL policy on session questions with the two operations the
-- current client needs. This prevents browser clients from rewriting snapshots.
drop policy if exists "user owns session questions" on public.test_session_questions;
drop policy if exists "qbank owner reads session questions" on public.test_session_questions;
create policy "qbank owner reads session questions" on public.test_session_questions
for select to authenticated
using (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid())));
drop policy if exists "qbank owner creates session questions" on public.test_session_questions;
create policy "qbank owner creates session questions" on public.test_session_questions
for insert to authenticated
with check (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid()) and s.status = 'in_progress'));

drop policy if exists "qbank learners read systems" on public.systems;
create policy "qbank learners read systems" on public.systems for select to authenticated using (true);
drop policy if exists "qbank learners read question topics" on public.question_topics;
create policy "qbank learners read question topics" on public.question_topics for select to authenticated using (true);

drop policy if exists "qbank owner manages bookmarks" on public.bookmarks;
create policy "qbank owner manages bookmarks" on public.bookmarks for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "qbank owner manages notes" on public.question_notes;
create policy "qbank owner manages notes" on public.question_notes for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "qbank owner manages review queue" on public.review_queue;
create policy "qbank owner manages review queue" on public.review_queue for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "qbank owner reads reports" on public.question_reports;
create policy "qbank owner reads reports" on public.question_reports for select to authenticated
using ((select auth.uid()) = user_id);
drop policy if exists "qbank owner creates reports" on public.question_reports;
create policy "qbank owner creates reports" on public.question_reports for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "qbank owner reads test answers" on public.test_answers;
create policy "qbank owner reads test answers" on public.test_answers for select to authenticated
using (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid())));
drop policy if exists "qbank owner creates test answers" on public.test_answers;
create policy "qbank owner creates test answers" on public.test_answers for insert to authenticated
with check (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid()) and s.status = 'in_progress'));
drop policy if exists "qbank owner updates test answers" on public.test_answers;
create policy "qbank owner updates test answers" on public.test_answers for update to authenticated
using (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid()) and s.status = 'in_progress'))
with check (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid()) and s.status = 'in_progress'));

grant select on public.systems, public.question_topics to authenticated;
grant select, insert, update, delete on public.bookmarks, public.question_notes, public.review_queue, public.test_answers to authenticated;
grant select, insert on public.question_reports to authenticated;
revoke update, delete on public.test_session_questions from authenticated;
grant select, insert on public.test_session_questions to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('question-media', 'question-media', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "qbank learners read question media" on storage.objects;
create policy "qbank learners read question media" on storage.objects
for select to authenticated using (bucket_id = 'question-media');
