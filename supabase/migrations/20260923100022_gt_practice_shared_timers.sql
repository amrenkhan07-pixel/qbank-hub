begin;
alter table public.qbank_gt_attempts add column mode text not null default 'exam_mode' check(mode in ('exam_mode','practice_mode')),
 add column paused_at timestamptz, add column paused_duration_ms numeric not null default 0 check(paused_duration_ms>=0),
 add constraint gt_strict_never_paused check(mode='practice_mode' or (paused_at is null and paused_duration_ms=0));
alter table public.test_sessions add column timer_state jsonb;
create or replace function qbank_gt_private.state(p_attempt uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.qbank_gt_attempts%rowtype; k qbank_gt_private.answer_keys%rowtype;
 v_now timestamptz:=clock_timestamp(); v_section integer; q jsonb; response jsonb;
 pos integer; sec integer; n_correct integer:=0; n_wrong integer:=0; n_blank integer:=0;
 counts jsonb:='[]'; outcomes jsonb:='{}'; c integer; w integer; b integer; outcome text; selected jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 select * into a from public.qbank_gt_attempts where id=p_attempt and user_id=auth.uid() for update;
 if not found then raise exception 'Attempt not found'; end if;
 v_now:=coalesce(a.paused_at,clock_timestamp());
 if a.status='in_progress' and a.paused_at is null and v_now>=a.expires_at then
  select * into strict k from qbank_gt_private.answer_keys where source_test_id=a.source_test_id and payload_sha256=a.payload_sha256;
  for sec in 0..a.section_count-1 loop
   c:=0;w:=0;b:=0;
   for pos in sec*a.section_size..(sec+1)*a.section_size-1 loop
    q:=k.questions->pos;response:=a.responses->(pos+1)::text;selected:=coalesce(response->'selected','[]'::jsonb);
    if jsonb_array_length(selected)=0 or (a.review_unscored and coalesce((response->>'marked')::boolean,false)) then b:=b+1;outcome:='unanswered';
    elsif selected @> (q->'correct') and (q->'correct') @> selected then c:=c+1;outcome:='correct';
    else w:=w+1;outcome:='incorrect'; end if;
    outcomes:=outcomes||jsonb_build_object((pos+1)::text,outcome);
   end loop;
   n_correct:=n_correct+c;n_wrong:=n_wrong+w;n_blank:=n_blank+b;
   counts:=counts||jsonb_build_array(jsonb_build_object('section',sec,'correct',c,'incorrect',w,'unanswered',b,'score',c*a.correct_mark+w*a.wrong_mark));
  end loop;
  update public.qbank_gt_attempts set status='completed',completed_at=expires_at,updated_at=v_now,
   result=jsonb_build_object('correct',n_correct,'incorrect',n_wrong,'unanswered',n_blank,'score',n_correct*a.correct_mark+n_wrong*a.wrong_mark,'maximum_score',a.question_count*a.correct_mark,'accuracy',case when n_correct+n_wrong>0 then round(100.0*n_correct/(n_correct+n_wrong),2) else null end,'sections',counts,'outcomes',outcomes)
   where id=a.id returning * into a;
 end if;
 v_section:=least(a.section_count,greatest(0,floor((extract(epoch from(v_now-a.started_at))-a.paused_duration_ms/1000.0)/a.section_seconds)::integer));
 return to_jsonb(a)||jsonb_build_object('server_now',clock_timestamp(),'effective_elapsed_seconds',greatest(0,extract(epoch from(v_now-a.started_at))-a.paused_duration_ms/1000.0),'paused',a.paused_at is not null,'active_section',v_section,'section_deadline',least(a.expires_at,a.started_at+make_interval(secs=>a.paused_duration_ms/1000.0+(v_section+1)*a.section_seconds)));
end $$;
create or replace function qbank_gt_private.start(p_test uuid,p_preset text,p_mode text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare k qbank_gt_private.answer_keys%rowtype; v_id uuid; existing public.qbank_gt_attempts%rowtype; n integer; size integer; seconds integer; sections integer; plus numeric; minus numeric; unscored boolean; stamp timestamptz;
begin
 if p_mode not in ('exam_mode','practice_mode') or p_mode is null then raise exception 'Invalid mode'; end if;
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':'||p_test::text,0));
 select * into existing from public.qbank_gt_attempts where user_id=auth.uid() and source_test_id=p_test and status='in_progress';
 if found then
  perform qbank_gt_private.state(existing.id);
  if exists(select 1 from public.qbank_gt_attempts where id=existing.id and status='in_progress') then
   if existing.preset<>p_preset or existing.mode<>p_mode then raise exception 'Resume the existing attempt before changing preset'; end if;
   return qbank_gt_private.state(existing.id);
  end if;
 end if;
 select * into strict k from qbank_gt_private.answer_keys where source_test_id=p_test;
 if not exists(select 1 from public.qbank_source_tests t join public.qbank_payload_objects o on o.source_test_id=t.id where t.id=p_test and t.source_path='["tests","downloaded_tests","grand_test"]'::jsonb and o.id=k.payload_object_id and o.sha256=k.payload_sha256 and o.status='committed') then raise exception 'GT payload not ready'; end if;
 case p_preset
 when 'ini_cet_200' then n:=200;size:=50;seconds:=2700;sections:=4;plus:=1;minus:=-1.0/3;unscored:=true;
 when 'neet_pg_2025_200' then n:=200;size:=40;seconds:=2520;sections:=5;plus:=4;minus:=-1;unscored:=false;
 when 'neet_pg_2026_180' then n:=180;size:=36;seconds:=2520;sections:=5;plus:=4;minus:=-1;unscored:=false;
 else raise exception 'Unknown exam preset'; end case;
 if jsonb_array_length(k.questions)<>n then raise exception 'Question count does not match preset; source questions are never silently removed'; end if;
 stamp:=clock_timestamp();
 insert into public.qbank_gt_attempts(user_id,source_test_id,payload_object_id,payload_sha256,preset,question_count,section_size,section_seconds,section_count,correct_mark,wrong_mark,review_unscored,started_at,expires_at,mode)
 values(auth.uid(),p_test,k.payload_object_id,k.payload_sha256,p_preset,n,size,seconds,sections,plus,minus,unscored,stamp,stamp+make_interval(secs=>seconds*sections),p_mode) returning id into v_id;
 return qbank_gt_private.state(v_id);
end $$;
create or replace function qbank_gt_private.answer(p_attempt uuid,p_position integer,p_selected jsonb,p_marked boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.qbank_gt_attempts%rowtype; k jsonb; sec integer; v_now timestamptz;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 select * into a from public.qbank_gt_attempts where id=p_attempt and user_id=auth.uid() for update;
 if not found then raise exception 'Attempt not found'; end if;
 if a.paused_at is not null then raise exception 'Practice GT is paused'; end if;
 v_now:=clock_timestamp();
 sec:=floor((extract(epoch from(v_now-a.started_at))-a.paused_duration_ms/1000.0)/a.section_seconds)::integer;
 if a.status<>'in_progress' or v_now>=a.expires_at then raise exception 'Attempt ended'; end if;
 if p_position is null or p_position<1 or p_position>a.question_count or (p_position-1)/a.section_size<>sec then raise exception 'Section locked'; end if;
 if p_selected is null or jsonb_typeof(p_selected)<>'array' or p_marked is null then raise exception 'Invalid response'; end if;
 select questions->(p_position-1) into strict k from qbank_gt_private.answer_keys where source_test_id=a.source_test_id and payload_sha256=a.payload_sha256;
 if jsonb_array_length(p_selected)>(select count(*) from jsonb_array_elements(k->'allowed'))
 or not (k->'allowed') @> p_selected
 or (select count(*) from jsonb_array_elements(p_selected))<>(select count(distinct value) from jsonb_array_elements(p_selected))
 or (jsonb_array_length(k->'correct')=1 and jsonb_array_length(p_selected)>1) then raise exception 'Invalid option selection'; end if;
 update public.qbank_gt_attempts set responses=jsonb_set(responses,array[p_position::text],jsonb_build_object('selected',p_selected,'marked',p_marked,'saved_at',v_now),true),updated_at=v_now where id=a.id;
 return qbank_gt_private.state(a.id);
end $$;
create or replace function qbank_gt_private.history(p_platform text default null,p_test uuid default null,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record; items jsonb; more boolean;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 if p_offset<0 or p_offset>100000 then raise exception 'Invalid offset'; end if;
 for r in select id from public.qbank_gt_attempts where user_id=auth.uid() and status='in_progress' and paused_at is null and expires_at<=clock_timestamp() order by expires_at limit 50 loop
  perform qbank_gt_private.state(r.id);
 end loop;
 select coalesce(jsonb_agg(x),'[]'::jsonb) into items from (
  select a.id,a.source_test_id,t.title,p.name as platform,a.preset,a.status,a.started_at,a.completed_at,a.mode,a.paused_at,a.paused_duration_ms,
   a.result-'outcomes' as result
  from public.qbank_gt_attempts a join public.qbank_source_tests t on t.id=a.source_test_id join public.platforms p on p.id=t.platform_id
  where a.user_id=auth.uid() and (p_platform is null or p.name=p_platform) and (p_test is null or t.id=p_test)
  order by a.started_at desc,a.id limit 50 offset p_offset
 ) x;
 select exists(select 1 from public.qbank_gt_attempts a join public.qbank_source_tests t on t.id=a.source_test_id join public.platforms p on p.id=t.platform_id
 where a.user_id=auth.uid() and (p_platform is null or p.name=p_platform) and (p_test is null or t.id=p_test) order by a.started_at desc,a.id offset p_offset+50 limit 1) into more;
 return jsonb_build_object('items',items,'has_more',more);
end $$;
create or replace function qbank_gt_private.start(p_test uuid,p_preset text) returns jsonb language sql security invoker set search_path='' as $$select qbank_gt_private.start(p_test,p_preset,'exam_mode')$$;
create function public.qbank_gt_start_mode(p_test uuid,p_preset text,p_mode text) returns jsonb language sql security invoker set search_path='' as $$select qbank_gt_private.start(p_test,p_preset,p_mode)$$;
create function qbank_gt_private.pause(p_attempt uuid,p_paused boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.qbank_gt_attempts%rowtype; stamp timestamptz; delta numeric;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 select * into a from public.qbank_gt_attempts where id=p_attempt and user_id=auth.uid() for update;
 if not found then raise exception 'Attempt not found'; end if;
 if a.mode<>'practice_mode' then raise exception 'Exam Mode cannot pause'; end if;
 if p_paused is null then raise exception 'Invalid pause state'; end if;
 perform qbank_gt_private.state(p_attempt);
 select * into a from public.qbank_gt_attempts where id=p_attempt;
 if a.status<>'in_progress' then return qbank_gt_private.state(p_attempt); end if;
 stamp:=clock_timestamp();
 if p_paused and a.paused_at is null then
  update public.qbank_gt_attempts set paused_at=stamp,updated_at=stamp where id=p_attempt;
 elsif not p_paused and a.paused_at is not null then
  delta:=greatest(0,extract(epoch from(stamp-a.paused_at))*1000);
  update public.qbank_gt_attempts set paused_at=null,paused_duration_ms=paused_duration_ms+delta,expires_at=expires_at+make_interval(secs=>delta/1000.0),updated_at=stamp where id=p_attempt;
 end if;
 return qbank_gt_private.state(p_attempt);
end $$;
create function public.qbank_gt_pause(p_attempt uuid,p_paused boolean) returns jsonb language sql security invoker set search_path='' as $$select qbank_gt_private.pause(p_attempt,p_paused)$$;
revoke all on function qbank_gt_private.start(uuid,text,text),qbank_gt_private.pause(uuid,boolean),public.qbank_gt_start_mode(uuid,text,text),public.qbank_gt_pause(uuid,boolean) from public,anon;
grant execute on function qbank_gt_private.start(uuid,text,text),qbank_gt_private.pause(uuid,boolean),public.qbank_gt_start_mode(uuid,text,text),public.qbank_gt_pause(uuid,boolean) to authenticated;
create function public.qbank_session_elapsed_ms(p_clock jsonb) returns numeric language sql stable security invoker set search_path='' as $$select greatest(0,coalesce((p_clock->>'totalUsedMs')::numeric,0))+case when coalesce((p_clock->>'paused')::boolean,true) then 0 else least(greatest(0,50000-coalesce((p_clock->>'questionUsedMs')::numeric,0)),greatest(0,extract(epoch from statement_timestamp())*1000-(p_clock->>'startedAt')::numeric)) end$$;
revoke all on function public.qbank_session_elapsed_ms(jsonb) from public,anon;
grant execute on function public.qbank_session_elapsed_ms(jsonb) to authenticated;
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
    and upper(coalesce(a.selected_option, '')) = upper(left(coalesce(sq.question_snapshot ->> 'correct_answer', ''), 1));

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
$function$;

commit;
