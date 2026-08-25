-- QBank Hub: additive personal-study features.
-- Safety: this migration never deletes or renames existing questions, options, attempts,
-- subjects, or platforms. It expects the existing public.questions.id to be UUID.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'questions'
      and column_name = 'id' and data_type = 'uuid'
  ) then
    raise exception 'Safe migration stopped: public.questions.id must be uuid. Inspect the live schema and adapt the foreign-key types before applying.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'subjects'
      and column_name = 'id' and data_type = 'uuid'
  ) then
    raise exception 'Safe migration stopped: public.subjects.id must be uuid. Inspect the live schema and adapt the foreign-key types before applying.';
  end if;
end $$;

alter table public.questions
  add column if not exists system_id uuid,
  add column if not exists difficulty text check (difficulty in ('easy','medium','hard')),
  add column if not exists is_pyq boolean not null default false,
  add column if not exists exam_year integer check (exam_year between 1950 and 2100),
  add column if not exists exam_shift text,
  add column if not exists source_reference text,
  add column if not exists image_path text,
  add column if not exists status text not null default 'published' check (status in ('draft','published','archived')),
  add column if not exists version integer not null default 1,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.systems (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid references public.subjects(id) on delete set null,
  name text not null,
  slug text unique,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique(subject_id, name)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'questions_system_id_fkey') then
    alter table public.questions add constraint questions_system_id_fkey
      foreign key (system_id) references public.systems(id) on delete set null;
  end if;
end $$;

create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid references public.subjects(id) on delete set null,
  system_id uuid references public.systems(id) on delete set null,
  parent_topic_id uuid references public.topics(id) on delete set null,
  name text not null,
  slug text,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique(system_id, name)
);

create table if not exists public.question_topics (
  question_id uuid not null references public.questions(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  primary key (question_id, topic_id)
);
create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text unique,
  created_at timestamptz not null default now()
);
create table if not exists public.question_tags (
  question_id uuid not null references public.questions(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (question_id, tag_id)
);

create table if not exists public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(user_id, question_id)
);
create table if not exists public.question_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  body text not null check (char_length(body) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, question_id)
);
create table if not exists public.review_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  reason text not null check (reason in ('incorrect','marked','bookmark','weak_topic')),
  due_at timestamptz not null default now(),
  last_reviewed_at timestamptz,
  review_count integer not null default 0 check (review_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, question_id)
);
create table if not exists public.question_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  reason text not null check (reason in ('wrong_answer','wrong_explanation','ambiguous','poor_quality','broken_image','other')),
  details text check (char_length(details) <= 5000),
  status text not null default 'open' check (status in ('open','reviewed','resolved','dismissed')),
  created_at timestamptz not null default now()
);

create table if not exists public.test_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Test',
  mode text not null default 'test' check (mode in ('test','practice')),
  status text not null default 'in_progress' check (status in ('in_progress','completed','timed_out','abandoned')),
  filters jsonb not null default '{}'::jsonb,
  question_count integer not null check (question_count > 0 and question_count <= 200),
  duration_minutes integer not null check (duration_minutes > 0 and duration_minutes <= 720),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  current_position integer not null default 0 check (current_position >= 0),
  score integer,
  correct_count integer,
  incorrect_count integer,
  unanswered_count integer,
  time_used_seconds integer,
  timed_out boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'in_progress') or completed_at is not null)
);
create table if not exists public.test_session_questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.test_sessions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete restrict,
  position integer not null check (position >= 0),
  question_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique(session_id, position),
  unique(session_id, question_id)
);
create table if not exists public.test_answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.test_sessions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete restrict,
  selected_option text,
  marked_for_review boolean not null default false,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id, question_id)
);

create index if not exists questions_published_filters_idx on public.questions (status, subject_id, platform_id, system_id, difficulty) where status = 'published';
create index if not exists question_topics_topic_idx on public.question_topics(topic_id, question_id);
create index if not exists question_tags_tag_idx on public.question_tags(tag_id, question_id);
create index if not exists bookmarks_user_created_idx on public.bookmarks(user_id, created_at desc);
create index if not exists review_queue_user_due_idx on public.review_queue(user_id, due_at);
create index if not exists reports_question_status_idx on public.question_reports(question_id, status);
create index if not exists test_sessions_user_updated_idx on public.test_sessions(user_id, updated_at desc);
create index if not exists test_answers_session_idx on public.test_answers(session_id, question_id);

create or replace function public.qbank_set_updated_at()
returns trigger language plpgsql security invoker set search_path = public as $$
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

-- A learner may save navigation state while a test is open, but cannot directly
-- manufacture a score or complete a test through the browser API. Final scoring
-- happens in the guarded RPC below from the immutable question snapshot.
create or replace function public.qbank_protect_test_session()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'in_progress' or new.score is not null or new.completed_at is not null then
      raise exception 'Test sessions must begin in progress without a score';
    end if;
    return new;
  end if;
  if old.status <> 'in_progress' then raise exception 'Completed tests are immutable'; end if;
  if current_setting('qbank.allow_submit', true) = '1' then return new; end if;
  if new.status is distinct from old.status or new.score is distinct from old.score
    or new.correct_count is distinct from old.correct_count
    or new.incorrect_count is distinct from old.incorrect_count
    or new.unanswered_count is distinct from old.unanswered_count
    or new.completed_at is distinct from old.completed_at
    or new.time_used_seconds is distinct from old.time_used_seconds
    or new.timed_out is distinct from old.timed_out then
    raise exception 'Use submit_test_session to finalize a test';
  end if;
  return new;
end;
$$;
drop trigger if exists qbank_protect_test_session on public.test_sessions;
create trigger qbank_protect_test_session before insert or update on public.test_sessions for each row execute function public.qbank_protect_test_session();

create or replace function public.submit_test_session(p_session_id uuid, p_timed_out boolean default false)
returns public.test_sessions language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session public.test_sessions;
  v_correct integer := 0;
  v_answered integer := 0;
  v_timed_out boolean := false;
begin
  select * into v_session from public.test_sessions
  where id = p_session_id and user_id = auth.uid() for update;
  if not found then raise exception 'Test session not found'; end if;
  if v_session.status <> 'in_progress' then return v_session; end if;
  v_timed_out := p_timed_out or now() >= v_session.started_at + make_interval(mins => v_session.duration_minutes);
  select count(*) into v_answered from public.test_answers
    where session_id = p_session_id and nullif(selected_option, '') is not null;
  select count(*) into v_correct from public.test_session_questions q
    join public.test_answers a on a.session_id = q.session_id and a.question_id = q.question_id
    where q.session_id = p_session_id
      and upper(coalesce(a.selected_option, '')) = upper(left(coalesce(q.question_snapshot->>'correct_answer', ''), 1));
  perform set_config('qbank.allow_submit', '1', true);
  update public.test_sessions set
    status = case when v_timed_out then 'timed_out' else 'completed' end,
    completed_at = now(), timed_out = v_timed_out,
    time_used_seconds = least(extract(epoch from now() - started_at)::integer, duration_minutes * 60),
    score = v_correct, correct_count = v_correct,
    incorrect_count = v_answered - v_correct,
    unanswered_count = question_count - v_answered
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$$;
revoke all on function public.submit_test_session(uuid, boolean) from public;
grant execute on function public.submit_test_session(uuid, boolean) to authenticated;

-- Every learner-owned table is private by default. Existing content-table RLS
-- policies are intentionally untouched; review them in the live schema audit.
alter table public.bookmarks enable row level security;
alter table public.question_notes enable row level security;
alter table public.review_queue enable row level security;
alter table public.question_reports enable row level security;
alter table public.test_sessions enable row level security;
alter table public.test_session_questions enable row level security;
alter table public.test_answers enable row level security;
alter table public.systems enable row level security;
alter table public.topics enable row level security;
alter table public.question_topics enable row level security;
alter table public.tags enable row level security;
alter table public.question_tags enable row level security;
alter table public.questions enable row level security;
alter table public.question_options enable row level security;
alter table public.subjects enable row level security;
alter table public.platforms enable row level security;
alter table public.question_attempts enable row level security;

create policy "qbank owner manages bookmarks" on public.bookmarks for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "qbank owner manages notes" on public.question_notes for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "qbank owner manages review queue" on public.review_queue for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "qbank owner reads reports" on public.question_reports for select to authenticated using ((select auth.uid()) = user_id);
create policy "qbank owner creates reports" on public.question_reports for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "qbank owner manages sessions" on public.test_sessions for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "qbank owner reads session questions" on public.test_session_questions for select to authenticated using (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid())));
create policy "qbank owner creates session questions" on public.test_session_questions for insert to authenticated with check (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid()) and s.status = 'in_progress'));
create policy "qbank owner reads answers" on public.test_answers for select to authenticated using (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid())));
create policy "qbank owner writes answers before completion" on public.test_answers for insert to authenticated with check (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid()) and s.status = 'in_progress'));
create policy "qbank owner updates answers before completion" on public.test_answers for update to authenticated using (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid()) and s.status = 'in_progress')) with check (exists (select 1 from public.test_sessions s where s.id = session_id and s.user_id = (select auth.uid()) and s.status = 'in_progress'));
create policy "qbank learners read taxonomy systems" on public.systems for select to authenticated using (true);
create policy "qbank learners read taxonomy topics" on public.topics for select to authenticated using (true);
create policy "qbank learners read question topics" on public.question_topics for select to authenticated using (true);
create policy "qbank learners read tags" on public.tags for select to authenticated using (true);
create policy "qbank learners read question tags" on public.question_tags for select to authenticated using (true);
create policy "qbank learners read published questions" on public.questions for select to authenticated using (status = 'published');
create policy "qbank learners read options for published questions" on public.question_options for select to authenticated using (exists (select 1 from public.questions q where q.id = question_id and q.status = 'published'));
create policy "qbank learners read subjects" on public.subjects for select to authenticated using (true);
create policy "qbank learners read platforms" on public.platforms for select to authenticated using (true);
create policy "qbank owner reads attempts" on public.question_attempts for select to authenticated using ((select auth.uid()) = user_id);
create policy "qbank owner creates attempts" on public.question_attempts for insert to authenticated with check ((select auth.uid()) = user_id);

-- A private Storage bucket for question images. Insert/update/delete policies for
-- editorial uploads are intentionally not granted to browser users.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('question-media', 'question-media', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
create policy "qbank learners read question media" on storage.objects for select to authenticated using (bucket_id = 'question-media');
