-- Canonical answer correctness for legacy and hybrid questions.
-- Keeps source answer keys unchanged and compares exact normalized option-key sets.

select pg_advisory_xact_lock(hashtext('qbank_answer_correctness_v1'));

create or replace function public.qbank_normalize_answer_keys(p_value text)
returns text[] language sql immutable parallel safe set search_path=public,pg_temp as $$
  select coalesce(array_agg(distinct upper(trim(part)) order by upper(trim(part))), '{}'::text[])
  from regexp_split_to_table(coalesce(p_value,''), '\s*[,;|+]\s*') part
  where trim(part) ~ '^[[:alnum:]]+$';
$$;

create or replace function public.qbank_correct_option_keys(p_question_id uuid)
returns text[] language sql stable security invoker set search_path=public,pg_temp as $$
  select coalesce(
    (select array_agg(distinct upper(trim(o.option_key)) order by upper(trim(o.option_key)))
       from public.question_options o where o.question_id=p_question_id and o.is_correct),
    (select array_agg(distinct upper(trim(k)) order by upper(trim(k)))
       from public.qbank_question_payloads p, unnest(p.correct_option_keys) k
      where p.question_id=p_question_id),
    (select public.qbank_normalize_answer_keys(
       case when q.correct_answer ~ '^\s*[[:alnum:]]+\s*[.):\-]\s*.+'
            then substring(q.correct_answer from '^\s*([[:alnum:]]+)')
            else q.correct_answer end)
       from public.questions q where q.id=p_question_id),
    '{}'::text[]
  );
$$;

create or replace function public.qbank_is_answer_correct(p_question_id uuid,p_selected_option text)
returns boolean language sql stable security invoker set search_path=public,pg_temp as $$
  select cardinality(public.qbank_correct_option_keys(p_question_id)) > 0
     and public.qbank_correct_option_keys(p_question_id)=public.qbank_normalize_answer_keys(p_selected_option);
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
  if not exists(select 1 from public.questions q where q.id=p_question_id and q.is_usable) then
    raise exception 'Question is missing or quarantined';
  end if;
  v_correct := public.qbank_is_answer_correct(p_question_id,p_selected_option);

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

revoke all on function public.qbank_normalize_answer_keys(text) from public;
revoke all on function public.qbank_correct_option_keys(uuid) from public;
revoke all on function public.qbank_is_answer_correct(uuid,text) from public;
revoke all on function public.qbank_record_attempt_v2(uuid,text,text,uuid,uuid,integer,text,text) from public;
grant execute on function public.qbank_normalize_answer_keys(text) to authenticated;
grant execute on function public.qbank_correct_option_keys(uuid) to authenticated;
grant execute on function public.qbank_is_answer_correct(uuid,text) to authenticated;
grant execute on function public.qbank_record_attempt_v2(uuid,text,text,uuid,uuid,integer,text,text) to authenticated;

notify pgrst,'reload schema';
