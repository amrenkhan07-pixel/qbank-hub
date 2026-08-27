-- QBank Hub learning-interface foundation.
-- Depends on 202608250001_qbank_learning_features.sql.
-- Additive only: existing questions, attempts, user state, and tests are retained.

select pg_advisory_xact_lock(hashtextextended('qbank:202608270001', 0));

do $$
declare v_problem text;
begin
  with required(table_name, column_name, udt_name) as (
    values
      ('questions', 'id', 'uuid'), ('questions', 'status', 'text'),
      ('question_options', 'question_id', 'uuid'),
      ('question_attempts', 'id', 'uuid'), ('question_attempts', 'test_session_id', 'uuid'),
      ('user_question_state', 'user_id', 'uuid'), ('user_question_state', 'question_id', 'uuid'),
      ('user_question_state', 'attempts', 'int4'), ('user_question_state', 'correct_attempts', 'int4'),
      ('topics', 'id', 'uuid'), ('topics', 'platform_subject_id', 'uuid'),
      ('topics', 'parent_topic_id', 'uuid'), ('topics', 'sort_order', 'int4'),
      ('systems', 'id', 'uuid'), ('question_topics', 'question_id', 'uuid'),
      ('test_sessions', 'id', 'uuid'), ('test_answers', 'session_id', 'uuid')
  )
  select string_agg(format('%I.%I (%s)', r.table_name, r.column_name, r.udt_name), ', ')
  into v_problem
  from required r
  left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = r.table_name
   and c.column_name = r.column_name and c.udt_name = r.udt_name
  where c.column_name is null;

  if v_problem is not null then
    raise exception 'Learning foundation stopped; run 202608250001 first or fix incompatible columns: %', v_problem;
  end if;
end $$;

alter table public.questions
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists content_origin text not null default 'imported',
  add column if not exists source_collection text;

alter table public.question_attempts
  add column if not exists time_spent_seconds integer,
  add column if not exists confidence text,
  add column if not exists error_reason text;

-- Reuse the live question_attempts.test_session_id column; do not add a second
-- session_id column for the same relationship.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.question_attempts'::regclass and conname = 'question_attempts_test_session_id_fkey') then
    alter table public.question_attempts add constraint question_attempts_test_session_id_fkey
      foreign key (test_session_id) references public.test_sessions(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.question_attempts'::regclass and conname = 'question_attempts_time_nonnegative') then
    alter table public.question_attempts add constraint question_attempts_time_nonnegative
      check (time_spent_seconds is null or time_spent_seconds >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.question_attempts'::regclass and conname = 'question_attempts_confidence_valid') then
    alter table public.question_attempts add constraint question_attempts_confidence_valid
      check (confidence is null or confidence in ('sure', 'unsure', 'guess')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.question_attempts'::regclass and conname = 'question_attempts_error_reason_valid') then
    alter table public.question_attempts add constraint question_attempts_error_reason_valid
      check (error_reason is null or error_reason in ('didnt_know', 'forgot', 'misread', 'confused_options', 'overthought', 'silly_mistake', 'guess')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.questions'::regclass and conname = 'questions_content_origin_valid') then
    alter table public.questions add constraint questions_content_origin_valid
      check (content_origin in ('imported', 'editorial', 'user')) not valid;
  end if;
end $$;

alter table public.question_attempts validate constraint question_attempts_time_nonnegative;
alter table public.question_attempts validate constraint question_attempts_confidence_valid;
alter table public.question_attempts validate constraint question_attempts_error_reason_valid;
alter table public.questions validate constraint questions_content_origin_valid;

alter table public.test_sessions
  add column if not exists preset text not null default 'custom',
  add column if not exists target_seconds_per_question integer not null default 50,
  add column if not exists auto_submit boolean not null default true,
  add column if not exists last_question_started_at timestamptz;

alter table public.test_answers
  add column if not exists is_correct boolean,
  add column if not exists time_spent_seconds integer not null default 0,
  add column if not exists confidence text,
  add column if not exists error_reason text;

create table if not exists public.subtopics (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.topics(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 300),
  slug text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (topic_id, name)
);

create table if not exists public.question_subtopics (
  question_id uuid not null references public.questions(id) on delete cascade,
  subtopic_id uuid not null references public.subtopics(id) on delete cascade,
  primary key (question_id, subtopic_id)
);

-- Preserve the existing hierarchy: child topics become subtopics of their parent.
insert into public.subtopics (id, topic_id, name, slug, sort_order, created_at)
select t.id, t.parent_topic_id, t.name, t.slug, t.sort_order, t.created_at
from public.topics t
where t.parent_topic_id is not null
on conflict (id) do nothing;

insert into public.question_subtopics (question_id, subtopic_id)
select q.id, q.topic_id
from public.questions q
join public.topics t on t.id = q.topic_id and t.parent_topic_id is not null
where q.topic_id is not null
on conflict do nothing;

insert into public.question_subtopics (question_id, subtopic_id)
select qt.question_id, qt.topic_id
from public.question_topics qt
join public.topics t on t.id = qt.topic_id and t.parent_topic_id is not null
on conflict do nothing;

-- Extend the live canonical state table rather than creating a competing
-- question_learning_state table.
alter table public.user_question_state
  add column if not exists last_is_correct boolean,
  add column if not exists marked_for_review boolean not null default false,
  add column if not exists personally_difficult boolean not null default false,
  add column if not exists last_time_seconds integer,
  add column if not exists last_confidence text,
  add column if not exists last_error_reason text,
  add column if not exists recall_stage integer not null default 0,
  add column if not exists recall_due_at timestamptz,
  add column if not exists last_recall_response text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_question_state'::regclass and conname = 'user_question_state_last_time_nonnegative') then
    alter table public.user_question_state add constraint user_question_state_last_time_nonnegative
      check (last_time_seconds is null or last_time_seconds >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_question_state'::regclass and conname = 'user_question_state_confidence_valid') then
    alter table public.user_question_state add constraint user_question_state_confidence_valid
      check (last_confidence is null or last_confidence in ('sure', 'unsure', 'guess')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_question_state'::regclass and conname = 'user_question_state_error_reason_valid') then
    alter table public.user_question_state add constraint user_question_state_error_reason_valid
      check (last_error_reason is null or last_error_reason in ('didnt_know', 'forgot', 'misread', 'confused_options', 'overthought', 'silly_mistake', 'guess')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_question_state'::regclass and conname = 'user_question_state_recall_stage_valid') then
    alter table public.user_question_state add constraint user_question_state_recall_stage_valid
      check (recall_stage between 0 and 5) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_question_state'::regclass and conname = 'user_question_state_recall_response_valid') then
    alter table public.user_question_state add constraint user_question_state_recall_response_valid
      check (last_recall_response is null or last_recall_response in ('forgot', 'partial', 'knew')) not valid;
  end if;
end $$;

alter table public.user_question_state validate constraint user_question_state_last_time_nonnegative;
alter table public.user_question_state validate constraint user_question_state_confidence_valid;
alter table public.user_question_state validate constraint user_question_state_error_reason_valid;
alter table public.user_question_state validate constraint user_question_state_recall_stage_valid;
alter table public.user_question_state validate constraint user_question_state_recall_response_valid;

create table if not exists public.recall_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  front text not null check (char_length(front) between 1 and 10000),
  back_html text not null check (char_length(back_html) between 1 and 30000),
  subject_id uuid references public.subjects(id) on delete set null,
  system_id uuid references public.systems(id) on delete set null,
  topic_id uuid references public.topics(id) on delete set null,
  subtopic_id uuid references public.subtopics(id) on delete set null,
  source_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recall_card_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references public.recall_cards(id) on delete cascade,
  stage integer not null default 0 check (stage between 0 and 5),
  due_at timestamptz not null default now(),
  last_response text check (last_response in ('forgot', 'partial', 'knew')),
  updated_at timestamptz not null default now(),
  primary key (user_id, card_id)
);

create table if not exists public.personal_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 500),
  body_html text not null check (char_length(body_html) <= 30000),
  subject_id uuid references public.subjects(id) on delete set null,
  topic_id uuid references public.topics(id) on delete set null,
  subtopic_id uuid references public.subtopics(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.personal_tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.question_personal_tags (
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  tag_id uuid not null references public.personal_tags(id) on delete cascade,
  primary key (user_id, question_id, tag_id)
);

create index if not exists subtopics_topic_sort_idx on public.subtopics (topic_id, sort_order, name);
create index if not exists question_subtopics_subtopic_idx on public.question_subtopics (subtopic_id, question_id);
create index if not exists questions_created_by_idx on public.questions (created_by) where created_by is not null;
create index if not exists state_user_review_idx on public.user_question_state (user_id, marked_for_review, updated_at desc);
create index if not exists state_user_recall_idx on public.user_question_state (user_id, recall_due_at) where recall_due_at is not null;
create index if not exists state_user_weak_idx on public.user_question_state (user_id, wrong, last_attempted_at desc);
create index if not exists attempts_user_question_time_idx on public.question_attempts (user_id, question_id, answered_at desc);
create index if not exists recall_cards_user_created_idx on public.recall_cards (user_id, created_at desc);
create index if not exists recall_progress_user_due_idx on public.recall_card_progress (user_id, due_at);
create index if not exists personal_notes_user_created_idx on public.personal_notes (user_id, created_at desc);
create index if not exists personal_tags_user_name_idx on public.personal_tags (user_id, name);

drop trigger if exists qbank_state_updated_at on public.user_question_state;
create trigger qbank_state_updated_at before update on public.user_question_state
for each row execute function public.qbank_set_updated_at();
drop trigger if exists qbank_recall_cards_updated_at on public.recall_cards;
create trigger qbank_recall_cards_updated_at before update on public.recall_cards
for each row execute function public.qbank_set_updated_at();
drop trigger if exists qbank_recall_progress_updated_at on public.recall_card_progress;
create trigger qbank_recall_progress_updated_at before update on public.recall_card_progress
for each row execute function public.qbank_set_updated_at();
drop trigger if exists qbank_personal_notes_updated_at on public.personal_notes;
create trigger qbank_personal_notes_updated_at before update on public.personal_notes
for each row execute function public.qbank_set_updated_at();

-- p_is_correct is retained for API compatibility but is never trusted; the
-- database derives correctness from question_options/correct_answer.
create or replace function public.qbank_record_attempt(
  p_question_id uuid,
  p_selected_option text,
  p_is_correct boolean,
  p_mode text default 'qbank',
  p_test_session_id uuid default null,
  p_time_spent_seconds integer default null,
  p_confidence text default null,
  p_error_reason text default null
)
returns public.user_question_state
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_state public.user_question_state;
  v_is_correct boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_test_session_id is not null and not exists (
    select 1 from public.test_sessions where id = p_test_session_id and user_id = auth.uid()
  ) then raise exception 'Test session not found'; end if;

  select coalesce(
    (select bool_or(o.is_correct) from public.question_options o
     where o.question_id = p_question_id and upper(o.option_key) = upper(p_selected_option)),
    upper(coalesce(p_selected_option, '')) = upper(left(coalesce(q.correct_answer, ''), 1))
  ) into v_is_correct
  from public.questions q where q.id = p_question_id;
  if not found then raise exception 'Question not found'; end if;

  insert into public.question_attempts
    (user_id, question_id, selected_option, is_correct, mode, test_session_id,
     answered_at, time_spent_seconds, confidence, error_reason)
  values
    (auth.uid(), p_question_id, p_selected_option, v_is_correct, p_mode, p_test_session_id,
     now(), greatest(coalesce(p_time_spent_seconds, 0), 0), p_confidence, p_error_reason);

  insert into public.user_question_state
    (user_id, question_id, attempts, correct_attempts, wrong, last_answer,
     last_is_correct, last_time_seconds, last_confidence, last_error_reason,
     last_attempted_at, last_wrong_at, total_time_seconds, recall_due_at)
  values
    (auth.uid(), p_question_id, 1, case when v_is_correct then 1 else 0 end,
     not v_is_correct, p_selected_option, v_is_correct,
     greatest(coalesce(p_time_spent_seconds, 0), 0), p_confidence, p_error_reason,
     now(), case when v_is_correct then null else now() end,
     greatest(coalesce(p_time_spent_seconds, 0), 0),
     case when v_is_correct then null else now() + interval '1 day' end)
  on conflict (user_id, question_id) do update set
    attempts = public.user_question_state.attempts + 1,
    correct_attempts = public.user_question_state.correct_attempts + case when v_is_correct then 1 else 0 end,
    wrong = not v_is_correct,
    last_answer = p_selected_option,
    last_is_correct = v_is_correct,
    last_time_seconds = greatest(coalesce(p_time_spent_seconds, 0), 0),
    last_confidence = p_confidence,
    last_error_reason = p_error_reason,
    last_attempted_at = now(),
    last_wrong_at = case when v_is_correct then public.user_question_state.last_wrong_at else now() end,
    total_time_seconds = public.user_question_state.total_time_seconds + greatest(coalesce(p_time_spent_seconds, 0), 0),
    recall_due_at = case when v_is_correct then public.user_question_state.recall_due_at else now() + interval '1 day' end
  returning * into v_state;
  return v_state;
end;
$$;

create or replace function public.qbank_review_question(p_question_id uuid, p_response text)
returns public.user_question_state
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_state public.user_question_state;
  v_stage integer;
  v_days integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_response not in ('forgot', 'partial', 'knew') then raise exception 'Invalid recall response'; end if;
  insert into public.user_question_state (user_id, question_id)
  values (auth.uid(), p_question_id) on conflict (user_id, question_id) do nothing;
  select recall_stage into v_stage from public.user_question_state
  where user_id = auth.uid() and question_id = p_question_id for update;
  v_stage := case when p_response = 'forgot' then 0
    when p_response = 'partial' then greatest(v_stage - 1, 0)
    else least(v_stage + 1, 5) end;
  v_days := (array[1, 3, 7, 14, 30, 60])[v_stage + 1];
  update public.user_question_state
  set recall_stage = v_stage,
      recall_due_at = now() + make_interval(days => v_days),
      last_recall_response = p_response
  where user_id = auth.uid() and question_id = p_question_id
  returning * into v_state;
  return v_state;
end;
$$;

alter table public.subtopics enable row level security;
alter table public.question_subtopics enable row level security;
alter table public.questions enable row level security;
alter table public.question_options enable row level security;
alter table public.question_attempts enable row level security;
alter table public.user_question_state enable row level security;
alter table public.recall_cards enable row level security;
alter table public.recall_card_progress enable row level security;
alter table public.personal_notes enable row level security;
alter table public.personal_tags enable row level security;
alter table public.question_personal_tags enable row level security;

drop policy if exists "qbank learners read subtopics" on public.subtopics;
create policy "qbank learners read subtopics" on public.subtopics for select to authenticated using (true);
drop policy if exists "qbank learners read question subtopics" on public.question_subtopics;
create policy "qbank learners read question subtopics" on public.question_subtopics for select to authenticated using (true);

drop policy if exists "qbank owner manages recall cards" on public.recall_cards;
create policy "qbank owner manages recall cards" on public.recall_cards for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "qbank owner manages recall progress" on public.recall_card_progress;
create policy "qbank owner manages recall progress" on public.recall_card_progress for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "qbank owner manages personal notes" on public.personal_notes;
create policy "qbank owner manages personal notes" on public.personal_notes for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "qbank owner manages personal tags" on public.personal_tags;
create policy "qbank owner manages personal tags" on public.personal_tags for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "qbank owner manages question personal tags" on public.question_personal_tags;
create policy "qbank owner manages question personal tags" on public.question_personal_tags for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Replace the live broad reads with equivalent published-content reads. All 418
-- current questions become published in the first migration; future personal
-- drafts are visible only to their owner.
drop policy if exists "authenticated read questions" on public.questions;
drop policy if exists "questions_read_authenticated" on public.questions;
drop policy if exists "qbank visible questions" on public.questions;
create policy "qbank visible questions" on public.questions for select to authenticated
using (status = 'published' or created_by = (select auth.uid()));

drop policy if exists "options_read_authenticated" on public.question_options;
drop policy if exists "qbank visible question options" on public.question_options;
create policy "qbank visible question options" on public.question_options for select to authenticated
using (exists (select 1 from public.questions q where q.id = question_id));

drop policy if exists "qbank owner creates personal questions" on public.questions;
create policy "qbank owner creates personal questions" on public.questions for insert to authenticated
with check (created_by = (select auth.uid()) and content_origin = 'user');
drop policy if exists "qbank owner updates personal questions" on public.questions;
create policy "qbank owner updates personal questions" on public.questions for update to authenticated
using (created_by = (select auth.uid()) and content_origin = 'user')
with check (created_by = (select auth.uid()) and content_origin = 'user');
drop policy if exists "qbank owner deletes personal questions" on public.questions;
create policy "qbank owner deletes personal questions" on public.questions for delete to authenticated
using (created_by = (select auth.uid()) and content_origin = 'user');

drop policy if exists "qbank owner manages personal question options" on public.question_options;
create policy "qbank owner manages personal question options" on public.question_options for all to authenticated
using (exists (select 1 from public.questions q where q.id = question_id and q.created_by = (select auth.uid()) and q.content_origin = 'user'))
with check (exists (select 1 from public.questions q where q.id = question_id and q.created_by = (select auth.uid()) and q.content_origin = 'user'));
drop policy if exists "qbank owner classifies personal question topics" on public.question_topics;
create policy "qbank owner classifies personal question topics" on public.question_topics for all to authenticated
using (exists (select 1 from public.questions q where q.id = question_id and q.created_by = (select auth.uid()) and q.content_origin = 'user'))
with check (exists (select 1 from public.questions q where q.id = question_id and q.created_by = (select auth.uid()) and q.content_origin = 'user'));
drop policy if exists "qbank owner classifies personal question subtopics" on public.question_subtopics;
create policy "qbank owner classifies personal question subtopics" on public.question_subtopics for all to authenticated
using (exists (select 1 from public.questions q where q.id = question_id and q.created_by = (select auth.uid()) and q.content_origin = 'user'))
with check (exists (select 1 from public.questions q where q.id = question_id and q.created_by = (select auth.uid()) and q.content_origin = 'user'));

drop policy if exists "qbank owner deletes attempts" on public.question_attempts;
create policy "qbank owner deletes attempts" on public.question_attempts for delete to authenticated
using ((select auth.uid()) = user_id);

grant select on public.subtopics to authenticated;
grant select, insert, delete on public.question_subtopics to authenticated;
grant select, insert, update, delete on public.recall_cards, public.recall_card_progress,
  public.personal_notes, public.personal_tags, public.question_personal_tags to authenticated;
grant select, insert, update, delete on public.questions, public.question_options to authenticated;
grant select, insert, delete on public.question_topics to authenticated;
grant select, insert, delete on public.question_attempts to authenticated;
grant select, insert, update, delete on public.test_sessions, public.test_answers to authenticated;
revoke update, delete on public.test_session_questions from authenticated;
grant select, insert on public.test_session_questions to authenticated;

revoke all on function public.qbank_record_attempt(uuid, text, boolean, text, uuid, integer, text, text) from public;
grant execute on function public.qbank_record_attempt(uuid, text, boolean, text, uuid, integer, text, text) to authenticated;
revoke all on function public.qbank_review_question(uuid, text) from public;
grant execute on function public.qbank_review_question(uuid, text) to authenticated;
