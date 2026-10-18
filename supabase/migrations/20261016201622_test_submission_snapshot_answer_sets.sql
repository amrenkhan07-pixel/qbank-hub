-- Exact snapshot answer sets for future submissions. Existing completed scores remain unchanged.
CREATE OR REPLACE FUNCTION public.submit_test_session(p_session_id uuid, p_timed_out boolean DEFAULT false)
 RETURNS test_sessions
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    case when v_session.timer_state->>'version'='1' then public.qbank_session_elapsed_ms(v_session.timer_state)>=v_session.total_questions*50000 else v_session.duration_minutes is not null and now() >= v_session.started_at + make_interval(mins => v_session.duration_minutes) end
  );
  select count(*) into v_total from public.test_session_questions where session_id = p_session_id;
  select count(*) into v_answered from public.test_answers
    where session_id = p_session_id and nullif(selected_option, '') is not null;
  select count(*) into v_correct
  from public.test_session_questions sq
  join public.test_answers a on a.session_id = sq.session_id and a.question_id = sq.question_id
  where sq.session_id = p_session_id
    and nullif(trim(a.selected_option),'') is not null
    and public.qbank_normalize_answer_keys(a.selected_option) =
      public.qbank_normalize_answer_keys(coalesce(
        (select string_agg(k,',') from jsonb_array_elements_text(
          case when jsonb_typeof(sq.question_snapshot->'correct_option_keys')='array'
            then sq.question_snapshot->'correct_option_keys' else '[]'::jsonb end) k),
        case when coalesce(sq.question_snapshot->>'correct_answer','') ~ '^\s*[[:alnum:]]+\s*[.):\-]\s*.+'
          then substring(sq.question_snapshot->>'correct_answer' from '^\s*([[:alnum:]]+)')
          else sq.question_snapshot->>'correct_answer' end));

  update public.test_sessions
  set status = case when v_timed_out then 'timed_out' else 'completed' end,
      completed_at = now(), timed_out = v_timed_out,
      total_questions = v_total, total_correct = v_correct,
      incorrect_count = v_answered - v_correct,
      unanswered_count = v_total - v_answered,
      total_time_seconds = case when timer_state->>'version'='1' then floor(public.qbank_session_elapsed_ms(timer_state)/1000)::integer else greatest(0, extract(epoch from now() - started_at)::integer) end
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$function$
