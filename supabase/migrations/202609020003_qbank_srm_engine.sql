-- QBank Hub deterministic spaced-repetition engine.
-- Additive only: preserves questions, attempts, sessions, bookmarks and all
-- existing user_question_state rows. Timestamps are stored as timestamptz.

select pg_advisory_xact_lock(hashtextextended('qbank:202609020003:srm', 0));

do $$
begin
  if to_regclass('public.user_question_state') is null
     or to_regclass('public.question_attempts') is null
     or to_regclass('public.questions') is null then
    raise exception 'SRM migration stopped: canonical QBank tables are missing';
  end if;
end $$;

alter table public.user_question_state
  add column if not exists srm_active boolean not null default false,
  add column if not exists srm_state text not null default 'new',
  add column if not exists srm_due_at timestamptz,
  add column if not exists srm_last_reviewed_at timestamptz,
  add column if not exists srm_last_result text,
  add column if not exists srm_confidence text,
  add column if not exists srm_consecutive_correct integer not null default 0,
  add column if not exists srm_consecutive_incorrect integer not null default 0,
  add column if not exists srm_total_reviews integer not null default 0,
  add column if not exists srm_interval_minutes integer not null default 0,
  add column if not exists srm_lapse_count integer not null default 0,
  add column if not exists srm_immediate_repeats_today smallint not null default 0,
  add column if not exists srm_last_immediate_repeat_at timestamptz,
  add column if not exists srm_enrolled_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.user_question_state'::regclass and conname='user_question_state_srm_state_valid') then
    alter table public.user_question_state add constraint user_question_state_srm_state_valid
      check (srm_state in ('new','learning','relearning','review','mature')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.user_question_state'::regclass and conname='user_question_state_srm_result_valid') then
    alter table public.user_question_state add constraint user_question_state_srm_result_valid
      check (srm_last_result is null or srm_last_result in ('correct','incorrect')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.user_question_state'::regclass and conname='user_question_state_srm_confidence_valid') then
    alter table public.user_question_state add constraint user_question_state_srm_confidence_valid
      check (srm_confidence is null or srm_confidence in ('sure','unsure')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.user_question_state'::regclass and conname='user_question_state_srm_counters_nonnegative') then
    alter table public.user_question_state add constraint user_question_state_srm_counters_nonnegative
      check (srm_consecutive_correct >= 0 and srm_consecutive_incorrect >= 0 and srm_total_reviews >= 0
        and srm_interval_minutes >= 0 and srm_lapse_count >= 0 and srm_immediate_repeats_today >= 0) not valid;
  end if;
end $$;

alter table public.user_question_state validate constraint user_question_state_srm_state_valid;
alter table public.user_question_state validate constraint user_question_state_srm_result_valid;
alter table public.user_question_state validate constraint user_question_state_srm_confidence_valid;
alter table public.user_question_state validate constraint user_question_state_srm_counters_nonnegative;

-- Preserve the 14 legacy recall schedules instead of discarding them.
update public.user_question_state
set srm_active = true,
    srm_state = case when last_is_correct is false then 'relearning' else 'learning' end,
    srm_due_at = recall_due_at,
    srm_last_result = case when last_is_correct is true then 'correct' when last_is_correct is false then 'incorrect' end,
    srm_confidence = case when last_confidence in ('sure') then 'sure' when last_confidence in ('unsure','guess') then 'unsure' end,
    srm_enrolled_reason = coalesce(srm_enrolled_reason, 'legacy_recall')
where recall_due_at is not null and not srm_active;

alter table public.question_attempts add column if not exists client_event_id uuid;
alter table public.test_answers add column if not exists client_event_id uuid;
create unique index if not exists question_attempts_user_event_uidx
  on public.question_attempts(user_id, client_event_id) where client_event_id is not null;
create unique index if not exists test_answers_session_event_uidx
  on public.test_answers(session_id, client_event_id) where client_event_id is not null;

create table if not exists public.qbank_srm_events (
  event_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  result text not null check (result in ('correct','incorrect','manual_add','manual_remove','manual_reset')),
  confidence text check (confidence is null or confidence in ('sure','unsure')),
  source text not null check (source in ('qbank','test','recall','manual')),
  previous_state text,
  next_state text,
  interval_minutes integer check (interval_minutes is null or interval_minutes >= 0),
  occurred_at timestamptz not null,
  processed_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

create table if not exists public.user_srm_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone_name text not null default 'Asia/Kolkata',
  new_daily_limit integer not null default 20 check (new_daily_limit between 1 and 500),
  review_daily_limit integer not null default 40 check (review_daily_limit between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_question_state_srm_due_idx
  on public.user_question_state(user_id, srm_due_at, question_id) where srm_active;
create index if not exists user_question_state_srm_priority_idx
  on public.user_question_state(user_id, srm_consecutive_incorrect desc, srm_due_at) where srm_active;
create index if not exists qbank_srm_events_user_occurred_idx
  on public.qbank_srm_events(user_id, occurred_at desc);
create index if not exists qbank_srm_events_question_idx
  on public.qbank_srm_events(user_id, question_id, occurred_at desc);

alter table public.qbank_srm_events enable row level security;
alter table public.user_srm_settings enable row level security;

drop policy if exists "qbank owner reads srm events" on public.qbank_srm_events;
create policy "qbank owner reads srm events" on public.qbank_srm_events for select to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
drop policy if exists "qbank owner creates srm events" on public.qbank_srm_events;
create policy "qbank owner creates srm events" on public.qbank_srm_events for insert to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
drop policy if exists "qbank owner finalizes srm events" on public.qbank_srm_events;
create policy "qbank owner finalizes srm events" on public.qbank_srm_events for update to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
drop policy if exists "qbank owner manages srm settings" on public.user_srm_settings;
create policy "qbank owner manages srm settings" on public.user_srm_settings for all to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

grant select, insert on public.qbank_srm_events to authenticated;
grant update(next_state,interval_minutes) on public.qbank_srm_events to authenticated;
grant select, insert, update on public.user_srm_settings to authenticated;

create or replace function public.qbank_apply_srm_event(
  p_question_id uuid,
  p_event_id uuid,
  p_result text,
  p_confidence text default null,
  p_source text default 'recall',
  p_occurred_at timestamptz default now()
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_state public.user_question_state;
  v_previous text;
  v_next text;
  v_interval integer := 0;
  v_confidence text;
  v_is_pyq boolean := false;
  v_timezone text := 'Asia/Kolkata';
  v_inserted integer := 0;
  v_same_day boolean := false;
  v_active boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_event_id is null then raise exception 'Event ID is required'; end if;
  if p_result not in ('correct','incorrect','manual_add','manual_remove','manual_reset') then raise exception 'Invalid SRM result'; end if;
  if p_source not in ('qbank','test','recall','manual') then raise exception 'Invalid SRM source'; end if;
  if p_result='correct' and p_confidence is not null and p_confidence not in ('sure','unsure','guess') then raise exception 'Invalid confidence'; end if;

  select coalesce(q.is_pyq,false) or exists (
    select 1 from public.qbank_source_occurrences o
    where o.question_id=q.id and o.is_current and o.is_pyq
  ) into v_is_pyq
  from public.questions q where q.id=p_question_id and q.is_usable;
  if not found then raise exception 'Question is missing or quarantined'; end if;

  select s.timezone_name into v_timezone from public.user_srm_settings s where s.user_id=v_user;
  v_timezone := coalesce(v_timezone, 'Asia/Kolkata');
  v_confidence := case when p_result='correct' and p_confidence='sure' then 'sure'
                       when p_result='correct' then 'unsure' end;

  insert into public.user_question_state(user_id,question_id)
  values(v_user,p_question_id) on conflict(user_id,question_id) do nothing;
  select * into v_state from public.user_question_state
  where user_id=v_user and question_id=p_question_id for update;
  v_previous := v_state.srm_state;
  v_active := v_state.srm_active;

  insert into public.qbank_srm_events(event_id,user_id,question_id,result,confidence,source,previous_state,occurred_at)
  values(p_event_id,v_user,p_question_id,p_result,v_confidence,p_source,v_previous,p_occurred_at)
  on conflict(user_id,event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted=0 then
    return jsonb_build_object('replayed',true,'question_id',p_question_id,'state',v_state.srm_state,
      'due_at',v_state.srm_due_at,'interval_minutes',v_state.srm_interval_minutes,'active',v_state.srm_active);
  end if;

  if p_result='manual_remove' then
    update public.user_question_state set srm_active=false,srm_due_at=null,recall_due_at=null,srm_enrolled_reason=null
    where user_id=v_user and question_id=p_question_id returning * into v_state;
    v_next := v_state.srm_state;
  elsif p_result='manual_reset' then
    update public.user_question_state set srm_active=true,srm_state='new',srm_due_at=p_occurred_at,recall_due_at=p_occurred_at,
      srm_last_reviewed_at=null,srm_last_result=null,srm_confidence=null,srm_consecutive_correct=0,
      srm_consecutive_incorrect=0,srm_total_reviews=0,srm_interval_minutes=0,srm_lapse_count=0,
      srm_immediate_repeats_today=0,srm_last_immediate_repeat_at=null,srm_enrolled_reason='manual'
    where user_id=v_user and question_id=p_question_id returning * into v_state;
    v_next := 'new';
  elsif p_result='manual_add' then
    update public.user_question_state set srm_active=true,srm_state=case when srm_active then srm_state else 'new' end,
      srm_due_at=coalesce(srm_due_at,p_occurred_at),recall_due_at=coalesce(srm_due_at,p_occurred_at),srm_enrolled_reason=coalesce(srm_enrolled_reason,'manual')
    where user_id=v_user and question_id=p_question_id returning * into v_state;
    v_next := v_state.srm_state;
  else
    -- A fresh ordinary non-PYQ answered correctly and surely stays outside
    -- Recall unless explicitly added. Correct PYQs get one reinforcement.
    if not v_active and p_result='correct' and v_confidence='sure' and not v_is_pyq then
      v_next := 'new'; v_interval := 0;
      update public.user_question_state set srm_last_result='correct',srm_confidence='sure'
      where user_id=v_user and question_id=p_question_id returning * into v_state;
    else
      if p_result='incorrect' then
        v_same_day := v_state.srm_last_immediate_repeat_at is not null
          and (v_state.srm_last_immediate_repeat_at at time zone v_timezone)::date = (p_occurred_at at time zone v_timezone)::date;
        if not v_same_day then v_state.srm_immediate_repeats_today := 0; end if;
        if v_state.srm_immediate_repeats_today < 1 then v_interval := 10; else v_interval := 1440; end if;
        v_next := 'relearning';
        update public.user_question_state set srm_active=true,srm_state=v_next,
          srm_due_at=p_occurred_at+make_interval(mins=>v_interval),recall_due_at=p_occurred_at+make_interval(mins=>v_interval),srm_last_reviewed_at=p_occurred_at,
          srm_last_result='incorrect',srm_confidence=null,srm_consecutive_correct=0,
          srm_consecutive_incorrect=srm_consecutive_incorrect+1,srm_total_reviews=srm_total_reviews+1,
          srm_interval_minutes=v_interval,
          srm_lapse_count=srm_lapse_count+case when srm_state in ('review','mature') then 1 else 0 end,
          srm_immediate_repeats_today=case when v_interval=10 then v_state.srm_immediate_repeats_today+1 else v_state.srm_immediate_repeats_today end,
          srm_last_immediate_repeat_at=case when v_interval=10 then p_occurred_at else srm_last_immediate_repeat_at end,
          srm_enrolled_reason=coalesce(srm_enrolled_reason,case when v_is_pyq then 'incorrect_pyq' else 'incorrect' end)
        where user_id=v_user and question_id=p_question_id returning * into v_state;
      else
        if v_state.srm_state='relearning' then
          v_interval := 1440; v_next := 'learning';
        elsif v_state.srm_state='learning' and v_state.srm_enrolled_reason like 'incorrect%'
          and v_state.srm_consecutive_correct>=1 and v_confidence='sure' then
          v_interval := 10080; v_next := 'review';
        elsif v_confidence='unsure' then
          v_interval := case when v_state.srm_interval_minutes < 1440 then 1440
            when v_state.srm_interval_minutes < 4320 then 4320
            when v_state.srm_interval_minutes < 10080 then 10080 else 20160 end;
          v_next := case when v_interval>=10080 then 'review' else 'learning' end;
        else
          v_interval := case when v_state.srm_interval_minutes < 4320 then 4320
            when v_state.srm_interval_minutes < 10080 then 10080
            when v_state.srm_interval_minutes < 20160 then 20160
            when v_state.srm_interval_minutes < 43200 then 43200 else 86400 end;
          v_next := case when v_interval>=43200 then 'mature' else 'review' end;
        end if;
        update public.user_question_state set srm_active=true,srm_state=v_next,
          srm_due_at=p_occurred_at+make_interval(mins=>v_interval),recall_due_at=p_occurred_at+make_interval(mins=>v_interval),srm_last_reviewed_at=p_occurred_at,
          srm_last_result='correct',srm_confidence=v_confidence,
          srm_consecutive_correct=srm_consecutive_correct+1,srm_consecutive_incorrect=0,
          srm_total_reviews=srm_total_reviews+1,srm_interval_minutes=v_interval,
          srm_immediate_repeats_today=0,
          srm_enrolled_reason=coalesce(srm_enrolled_reason,case when v_is_pyq then 'pyq_reinforcement' else 'unsure' end)
        where user_id=v_user and question_id=p_question_id returning * into v_state;
      end if;
    end if;
  end if;

  update public.qbank_srm_events set next_state=v_next,interval_minutes=v_interval
  where user_id=v_user and event_id=p_event_id;
  return jsonb_build_object('replayed',false,'question_id',p_question_id,'state',v_state.srm_state,
    'due_at',v_state.srm_due_at,'interval_minutes',v_state.srm_interval_minutes,'active',v_state.srm_active,
    'result',p_result,'confidence',v_confidence);
end;
$$;

create or replace function public.qbank_record_attempt_v2(
  p_question_id uuid,
  p_selected_option text,
  p_mode text,
  p_event_id uuid,
  p_test_session_id uuid default null,
  p_time_spent_seconds integer default null,
  p_confidence text default null,
  p_error_reason text default null
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_correct boolean;
  v_attempt_id uuid;
  v_state public.user_question_state;
  v_srm jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_event_id is null then raise exception 'Event ID is required'; end if;
  if p_test_session_id is not null and not exists(select 1 from public.test_sessions where id=p_test_session_id and user_id=v_user) then
    raise exception 'Test session not found';
  end if;
  select coalesce((select bool_or(o.is_correct) from public.question_options o
    where o.question_id=q.id and upper(o.option_key)=upper(p_selected_option)),
    upper(coalesce(p_selected_option,''))=upper(left(coalesce(q.correct_answer,''),1)))
  into v_correct from public.questions q where q.id=p_question_id and q.is_usable;
  if not found then raise exception 'Question is missing or quarantined'; end if;

  insert into public.question_attempts(user_id,question_id,selected_option,is_correct,mode,test_session_id,
    answered_at,time_spent_seconds,confidence,error_reason,client_event_id)
  values(v_user,p_question_id,p_selected_option,v_correct,coalesce(p_mode,'qbank'),p_test_session_id,
    now(),greatest(coalesce(p_time_spent_seconds,0),0),case when v_correct then coalesce(nullif(p_confidence,'guess'),'unsure') end,
    p_error_reason,p_event_id)
  on conflict(user_id,client_event_id) where client_event_id is not null do nothing
  returning id into v_attempt_id;

  if v_attempt_id is not null then
    insert into public.user_question_state(user_id,question_id,attempts,correct_attempts,wrong,last_answer,last_is_correct,
      last_time_seconds,last_confidence,last_error_reason,last_attempted_at,last_wrong_at,total_time_seconds)
    values(v_user,p_question_id,1,case when v_correct then 1 else 0 end,not v_correct,p_selected_option,v_correct,
      greatest(coalesce(p_time_spent_seconds,0),0),case when v_correct then coalesce(nullif(p_confidence,'guess'),'unsure') end,
      p_error_reason,now(),case when v_correct then null else now() end,greatest(coalesce(p_time_spent_seconds,0),0))
    on conflict(user_id,question_id) do update set
      attempts=public.user_question_state.attempts+1,
      correct_attempts=public.user_question_state.correct_attempts+case when v_correct then 1 else 0 end,
      wrong=not v_correct,last_answer=p_selected_option,last_is_correct=v_correct,
      last_time_seconds=greatest(coalesce(p_time_spent_seconds,0),0),
      last_confidence=case when v_correct then coalesce(nullif(p_confidence,'guess'),'unsure') end,
      last_error_reason=p_error_reason,last_attempted_at=now(),
      last_wrong_at=case when v_correct then public.user_question_state.last_wrong_at else now() end,
      total_time_seconds=public.user_question_state.total_time_seconds+greatest(coalesce(p_time_spent_seconds,0),0);
  end if;
  v_srm := public.qbank_apply_srm_event(p_question_id,p_event_id,case when v_correct then 'correct' else 'incorrect' end,
    p_confidence,case when p_mode='recall' then 'recall' when p_mode='test' then 'test' else 'qbank' end,now());
  select * into v_state from public.user_question_state where user_id=v_user and question_id=p_question_id;
  return v_srm || jsonb_build_object('attempt_inserted',v_attempt_id is not null,'is_correct',v_correct,
    'attempts',v_state.attempts,'correct_attempts',v_state.correct_attempts);
end;
$$;

create or replace function public.qbank_srm_manual(p_question_id uuid,p_action text,p_event_id uuid)
returns jsonb language sql security invoker set search_path=public,pg_temp as $$
  select public.qbank_apply_srm_event(p_question_id,p_event_id,
    case p_action when 'add' then 'manual_add' when 'remove' then 'manual_remove' when 'reset' then 'manual_reset'
      else 'invalid' end,null,'manual',now());
$$;

create or replace function public.qbank_srm_update_settings(
  p_timezone_name text,p_new_daily_limit integer,p_review_daily_limit integer
) returns public.user_srm_settings
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_result public.user_srm_settings;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists(select 1 from pg_timezone_names where name=p_timezone_name) then raise exception 'Invalid timezone'; end if;
  insert into public.user_srm_settings(user_id,timezone_name,new_daily_limit,review_daily_limit)
  values(auth.uid(),p_timezone_name,p_new_daily_limit,p_review_daily_limit)
  on conflict(user_id) do update set timezone_name=excluded.timezone_name,new_daily_limit=excluded.new_daily_limit,
    review_daily_limit=excluded.review_daily_limit,updated_at=now()
  returning * into v_result;
  return v_result;
end;
$$;

create or replace function public.qbank_srm_queue(
  p_platform_ids uuid[] default null,
  p_subject_ids uuid[] default null,
  p_pyq_only boolean default false,
  p_repeated_only boolean default false,
  p_limit integer default null
) returns table(question_id uuid,due_at timestamptz,srm_state text,reason text,priority_class integer,
  is_pyq boolean,consecutive_incorrect integer,bookmarked boolean,marked_for_review boolean,overdue_seconds bigint)
language sql stable security invoker set search_path=public,pg_temp as $$
with settings as (
  select coalesce((select new_daily_limit from public.user_srm_settings where user_id=auth.uid()),20) new_limit,
         coalesce((select review_daily_limit from public.user_srm_settings where user_id=auth.uid()),40) review_limit
), candidates as (
  select s.question_id,s.srm_due_at due_at,s.srm_state,
    case when s.srm_consecutive_incorrect>=2 then 'repeated_incorrect'
         when s.srm_last_result='incorrect' then 'incorrect'
         when s.srm_confidence='unsure' then 'unsure' else 'scheduled' end reason,
    (coalesce(q.is_pyq,false) or exists(select 1 from public.qbank_source_occurrences o
      where o.question_id=q.id and o.is_current and o.is_pyq)) pyq,
    s.srm_consecutive_incorrect,s.bookmarked,s.marked_for_review,
    greatest(0,extract(epoch from now()-s.srm_due_at)::bigint) overdue,
    s.srm_total_reviews=0 is_new
  from public.user_question_state s join public.questions q on q.id=s.question_id
  where s.user_id=auth.uid() and s.srm_active and s.srm_due_at<=now() and q.is_usable
    and (coalesce(cardinality(p_platform_ids),0)=0 or q.platform_id=any(p_platform_ids))
    and (coalesce(cardinality(p_subject_ids),0)=0 or q.subject_id=any(p_subject_ids))
), ranked as (
  select c.*,row_number() over(partition by is_new order by overdue desc,pyq desc,srm_consecutive_incorrect desc,
    marked_for_review desc,bookmarked desc,question_id) bucket_row
  from candidates c where (not p_pyq_only or pyq) and (not p_repeated_only or srm_consecutive_incorrect>=2)
), limited as (
  select r.* from ranked r cross join settings s
  where (r.is_new and r.bucket_row<=s.new_limit) or (not r.is_new and r.bucket_row<=s.review_limit)
)
select l.question_id,l.due_at,l.srm_state,l.reason,
  case when l.pyq and l.srm_consecutive_incorrect>=2 then 7
       when l.pyq and l.reason='incorrect' then 6
       when not l.pyq and l.srm_consecutive_incorrect>=2 then 5
       when l.reason='incorrect' then 4 when l.pyq and l.reason='unsure' then 3
       when l.pyq then 2 else 1 end priority_class,
  l.pyq,l.srm_consecutive_incorrect,l.bookmarked,l.marked_for_review,l.overdue
from limited l
order by l.overdue desc,priority_class desc,l.srm_consecutive_incorrect desc,l.marked_for_review desc,l.bookmarked desc,l.question_id
limit least(greatest(coalesce(p_limit,500),1),500);
$$;

create or replace function public.qbank_srm_summary(
  p_platform_ids uuid[] default null,p_subject_ids uuid[] default null
) returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
with due as (
  select s.*,q.is_pyq or exists(select 1 from public.qbank_source_occurrences o
    where o.question_id=q.id and o.is_current and o.is_pyq) pyq
  from public.user_question_state s join public.questions q on q.id=s.question_id
  where s.user_id=auth.uid() and s.srm_active and s.srm_due_at<=now() and q.is_usable
    and (coalesce(cardinality(p_platform_ids),0)=0 or q.platform_id=any(p_platform_ids))
    and (coalesce(cardinality(p_subject_ids),0)=0 or q.subject_id=any(p_subject_ids))
), settings as (
  select coalesce((select timezone_name from public.user_srm_settings where user_id=auth.uid()),'Asia/Kolkata') timezone_name
), today_events as (
  select e.* from public.qbank_srm_events e cross join settings s
  where e.user_id=auth.uid() and e.result in ('correct','incorrect')
    and (e.occurred_at at time zone s.timezone_name)::date=(now() at time zone s.timezone_name)::date
)
select jsonb_build_object('due_now',(select count(*) from due),'overdue',(select count(*) from due where srm_due_at<now()-interval '1 day'),
  'pyq_due',(select count(*) from due where pyq),'repeated_due',(select count(*) from due where srm_consecutive_incorrect>=2),
  'reviewed_today',(select count(*) from today_events),'successful_today',(select count(*) from today_events where result='correct'),
  'retention_today',case when (select count(*) from today_events)=0 then null else round(100.0*(select count(*) from today_events where result='correct')/(select count(*) from today_events)) end);
$$;

revoke all on function public.qbank_apply_srm_event(uuid,uuid,text,text,text,timestamptz) from public;
revoke all on function public.qbank_record_attempt_v2(uuid,text,text,uuid,uuid,integer,text,text) from public;
revoke all on function public.qbank_srm_manual(uuid,text,uuid) from public;
revoke all on function public.qbank_srm_update_settings(text,integer,integer) from public;
revoke all on function public.qbank_srm_queue(uuid[],uuid[],boolean,boolean,integer) from public;
revoke all on function public.qbank_srm_summary(uuid[],uuid[]) from public;
grant execute on function public.qbank_apply_srm_event(uuid,uuid,text,text,text,timestamptz) to authenticated;
grant execute on function public.qbank_record_attempt_v2(uuid,text,text,uuid,uuid,integer,text,text) to authenticated;
grant execute on function public.qbank_srm_manual(uuid,text,uuid) to authenticated;
grant execute on function public.qbank_srm_update_settings(text,integer,integer) to authenticated;
grant execute on function public.qbank_srm_queue(uuid[],uuid[],boolean,boolean,integer) to authenticated;
grant execute on function public.qbank_srm_summary(uuid[],uuid[]) to authenticated;

notify pgrst,'reload schema';
