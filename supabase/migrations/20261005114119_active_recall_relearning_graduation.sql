-- A successful immediate relearning retrieval earns one day but no spaced mastery credit.
create or replace function public.qbank_active_recall_record(p_question_id uuid,p_selected_option text,p_event_id uuid,p_test_session_id uuid,p_time_spent_seconds integer,p_strength text,p_error_reason text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare prior jsonb; result jsonb; key text; correct boolean; strong boolean; spaced boolean; failures integer; successes integer; step integer; minutes integer; mastery text; ladder integer[]:=array[15,1440,4320,10080,20160,43200,86400];
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 if p_strength not in ('failed','partial','strong') or p_strength is null then raise exception 'Invalid strength'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select coalesce(m.unit_key,'q:'||p_question_id) into key from (select 1) x left join public.active_recall_reliable_map m on m.question_id=p_question_id;
 if exists(select 1 from public.active_recall_retrievals where user_id=auth.uid() and event_id=p_event_id) then
  if not exists(select 1 from public.active_recall_retrievals where user_id=auth.uid() and event_id=p_event_id and question_id=p_question_id) then raise exception 'Conflicting event'; end if;
  return (select to_jsonb(u)||jsonb_build_object('state',u.mastery) from public.active_recall_units u where user_id=auth.uid() and unit_key=key);
 end if;
 select unit into prior from public.qbank_active_recall_rows() r where r.unit_key=key;
 result:=public.qbank_record_attempt_v2(p_question_id,p_selected_option,'recall',p_event_id,p_test_session_id,p_time_spent_seconds,case when p_strength='strong' then 'sure' else 'unsure' end,p_error_reason);
 select a.is_correct into correct from public.question_attempts a where a.user_id=auth.uid() and a.client_event_id=p_event_id and a.question_id=p_question_id;
 if correct is null then raise exception 'Attempt was not recorded'; end if;
 strong:=correct and p_strength='strong';
 spaced:=prior->>'last_reviewed_at' is null or now()-(prior->>'last_reviewed_at')::timestamptz>=interval '20 hours';
 select coalesce(max(i),1) into step from generate_subscripts(ladder,1) i where ladder[i]<=coalesce((prior->>'interval_minutes')::integer,0);
 if not correct or p_strength='failed' then
  step:=1;failures:=coalesce((prior->>'consecutive_failures')::integer,0)+1;successes:=0;
 else
  failures:=0;successes:=coalesce((prior->>'spaced_successes')::integer,0)+case when strong and spaced then 1 else 0 end;
  if strong and (spaced or step=1) then step:=least(7,step+1);elsif not strong then step:=greatest(1,least(step-1,3));end if;
 end if;
 minutes:=ladder[step];mastery:=case when failures>=2 then 'WEAK' when successes>=5 and step>=6 then 'MASTERED' when successes>=3 and step>=4 then 'STABLE' else 'LEARNING' end;
 insert into public.active_recall_units(user_id,unit_key,active,mastery,interval_minutes,due_at,last_reviewed_at,last_question_id,consecutive_failures,spaced_successes)
 values(auth.uid(),key,true,mastery,minutes,now()+make_interval(mins=>minutes),now(),p_question_id,failures,successes)
 on conflict(user_id,unit_key) do update set active=true,mastery=excluded.mastery,interval_minutes=excluded.interval_minutes,due_at=excluded.due_at,last_reviewed_at=excluded.last_reviewed_at,last_question_id=excluded.last_question_id,consecutive_failures=excluded.consecutive_failures,spaced_successes=excluded.spaced_successes,updated_at=now();
 insert into public.active_recall_retrievals(user_id,event_id,unit_key,question_id,strength,is_correct,mastery,interval_minutes) values(auth.uid(),p_event_id,key,p_question_id,p_strength,correct,mastery,minutes);
 return result||jsonb_build_object('active',true,'state',mastery,'due_at',now()+make_interval(mins=>minutes),'interval_minutes',minutes,'relearn',not correct or p_strength='failed');
end;
$$;
