-- Additive Active Recall state. Existing per-question schedules/events remain untouched.
create table public.active_recall_units (
 user_id uuid not null references auth.users(id), unit_key text not null,
 active boolean not null default true, mastery text not null default 'LEARNING' check(mastery in ('LEARNING','WEAK','STABLE','MASTERED')),
 interval_minutes integer not null default 15 check(interval_minutes>=0), due_at timestamptz,
 last_reviewed_at timestamptz, last_question_id uuid references public.questions(id),
 consecutive_failures integer not null default 0, spaced_successes integer not null default 0,
 updated_at timestamptz not null default now(), primary key(user_id,unit_key)
);
alter table public.active_recall_units enable row level security;
create policy active_recall_units_owner on public.active_recall_units for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
grant select,insert,update on public.active_recall_units to authenticated;
create table public.active_recall_retrievals (
 user_id uuid not null references auth.users(id), event_id uuid not null, unit_key text not null,
 question_id uuid not null references public.questions(id), strength text not null check(strength in ('failed','partial','strong')),
 is_correct boolean not null, mastery text not null, interval_minutes integer not null,
 occurred_at timestamptz not null default now(), primary key(user_id,event_id)
);
alter table public.active_recall_retrievals enable row level security;
create policy active_recall_retrievals_owner on public.active_recall_retrievals for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
grant select,insert on public.active_recall_retrievals to authenticated;
create index active_recall_retrieval_history on public.active_recall_retrievals(user_id,occurred_at desc);

-- A question with conflicting finalized mappings deliberately falls back to question-level.
create view public.active_recall_reliable_map with(security_invoker=true) as
with expanded as (
 select qid question_id,subject,concept_id,primary_concept,global_importance_tier,global_importance_score,
 neet_pg_occurrences,ini_cet_occurrences,aiims_occurrences,question_ids,
 count(*) over(partition by qid) mapping_count
 from public.pyq_concept_importance cross join lateral unnest(question_ids) qid
) select *, 'c:'||subject||':'||concept_id unit_key from expanded where mapping_count=1;
grant select on public.active_recall_reliable_map to authenticated;

create function public.qbank_active_recall_rows()
returns table(unit_key text,unit jsonb) language sql stable security invoker set search_path='' as $$
with mapped as materialized (
 select s.*, coalesce(m.unit_key,'q:'||s.question_id) key,
 m.primary_concept,m.global_importance_tier,m.global_importance_score,m.neet_pg_occurrences,m.ini_cet_occurrences,m.aiims_occurrences,
 coalesce(m.subject,su.name,'Unassigned') subject,m.question_ids variants
 from public.user_question_state s join public.questions q on q.id=s.question_id and q.is_usable
 left join public.active_recall_reliable_map m on m.question_id=s.question_id
 left join public.subjects su on su.id=q.subject_id
 where s.user_id=(select auth.uid())
), grouped as (
 select key,max(primary_concept) primary_concept,max(subject) subject,max(global_importance_tier) tier,max(global_importance_score) importance,
 max(neet_pg_occurrences) neet,max(ini_cet_occurrences) ini,max(aiims_occurrences) aiims,
 array_agg(question_id order by last_attempted_at nulls first,question_id) encountered,
 bool_or(srm_active) enrolled,min(srm_due_at) filter(where srm_active) legacy_due,
 max(srm_last_reviewed_at) reviewed,max(updated_at) changed,
 min(srm_interval_minutes) filter(where srm_active) legacy_interval,
 max(srm_consecutive_incorrect) failures,sum(attempts) attempts,sum(correct_attempts) correct,
 jsonb_agg(jsonb_build_object('question_id',question_id,'last_attempted_at',last_attempted_at,'error_reason',last_error_reason)) questions
 from mapped group by key
), effective as (
 select g.*,u.last_question_id,
 case when u.updated_at>=coalesce(g.reviewed,'-infinity'::timestamptz) then u.active else g.enrolled end active,
 case when u.updated_at>=coalesce(g.reviewed,'-infinity'::timestamptz) then u.due_at else g.legacy_due end due,
 case when u.updated_at>=coalesce(g.reviewed,'-infinity'::timestamptz) then u.interval_minutes else coalesce(g.legacy_interval,15) end minutes,
 case when u.updated_at>=coalesce(g.reviewed,'-infinity'::timestamptz) then u.mastery else case when g.failures>=2 then 'WEAK' else 'LEARNING' end end mastery,
 coalesce(u.consecutive_failures,g.failures,0) consecutive_failures,coalesce(u.spaced_successes,0) spaced_successes,
 greatest(u.last_reviewed_at,g.reviewed) last_reviewed
 from grouped g left join public.active_recall_units u on u.user_id=(select auth.uid()) and u.unit_key=g.key
)
select key,jsonb_build_object('unit_key',key,'primary_concept',primary_concept,'subject',subject,
 'tier',tier,'importance',importance,'neet_pg_occurrences',neet,'ini_cet_occurrences',ini,'aiims_occurrences',aiims,
 'encountered_question_ids',encountered,'question_id',coalesce((select x from unnest(encountered) x where x is distinct from last_question_id limit 1),encountered[1]),
 'active',coalesce(active,false),'due_at',due,'interval_minutes',minutes,'mastery',mastery,'last_reviewed_at',last_reviewed,
 'consecutive_failures',consecutive_failures,'spaced_successes',spaced_successes,'attempts',attempts,'correct',correct,'incorrect',attempts-correct,'questions',questions)
from effective;
$$;
revoke all on function public.qbank_active_recall_rows() from public;
grant execute on function public.qbank_active_recall_rows() to authenticated;

create function public.qbank_active_recall_queue(p_limit integer default 30,p_offset integer default 0,p_due_only boolean default true)
returns jsonb language sql stable security invoker set search_path='' as $$
with rows as materialized(select unit from public.qbank_active_recall_rows()), due as (
 select unit from rows where (unit->>'active')::boolean and (unit->>'due_at')::timestamptz<=now()
), page as (
 select unit from rows where not p_due_only or ((unit->>'active')::boolean and (unit->>'due_at')::timestamptz<=now())
 order by (unit->>'due_at')::timestamptz nulls last,unit->>'unit_key'
 limit least(greatest(p_limit,1),500) offset greatest(p_offset,0)
)
select jsonb_build_object('items',coalesce((select jsonb_agg(unit) from page),'[]'::jsonb),
 'total',(select count(*) from rows),'due_count',(select count(*) from due),
 'concepts_due',(select count(*) from due where unit->>'primary_concept' is not null),
 'questions_due',(select count(*) from due where unit->>'primary_concept' is null),
 'weak',(select count(*) from due where unit->>'mastery'='WEAK'),
 'learning',(select count(*) from due where unit->>'mastery'='LEARNING'),
 'stable',(select count(*) from due where unit->>'mastery'='STABLE'),
 'mastered',(select count(*) from due where unit->>'mastery'='MASTERED'),
 'personal_cards_due',(select count(*) from public.recall_card_progress where user_id=(select auth.uid()) and due_at<=now()));
$$;
revoke all on function public.qbank_active_recall_queue(integer,integer,boolean) from public;
grant execute on function public.qbank_active_recall_queue(integer,integer,boolean) to authenticated;

create function public.qbank_active_recall_record(p_question_id uuid,p_selected_option text,p_event_id uuid,p_test_session_id uuid,p_time_spent_seconds integer,p_strength text,p_error_reason text default null)
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
  if strong and spaced then step:=least(7,step+1);elsif not strong then step:=greatest(1,least(step-1,3));end if;
 end if;
 minutes:=ladder[step];mastery:=case when failures>=2 then 'WEAK' when successes>=5 and step>=6 then 'MASTERED' when successes>=3 and step>=4 then 'STABLE' else 'LEARNING' end;
 insert into public.active_recall_units(user_id,unit_key,active,mastery,interval_minutes,due_at,last_reviewed_at,last_question_id,consecutive_failures,spaced_successes)
 values(auth.uid(),key,true,mastery,minutes,now()+make_interval(mins=>minutes),now(),p_question_id,failures,successes)
 on conflict(user_id,unit_key) do update set active=true,mastery=excluded.mastery,interval_minutes=excluded.interval_minutes,due_at=excluded.due_at,last_reviewed_at=excluded.last_reviewed_at,last_question_id=excluded.last_question_id,consecutive_failures=excluded.consecutive_failures,spaced_successes=excluded.spaced_successes,updated_at=now();
 insert into public.active_recall_retrievals(user_id,event_id,unit_key,question_id,strength,is_correct,mastery,interval_minutes) values(auth.uid(),p_event_id,key,p_question_id,p_strength,correct,mastery,minutes);
 return result||jsonb_build_object('active',true,'state',mastery,'due_at',now()+make_interval(mins=>minutes),'interval_minutes',minutes,'relearn',not correct or p_strength='failed');
end;
$$;
revoke all on function public.qbank_active_recall_record(uuid,text,uuid,uuid,integer,text,text) from public;
grant execute on function public.qbank_active_recall_record(uuid,text,uuid,uuid,integer,text,text) to authenticated;

create function public.qbank_active_recall_manual(p_question_id uuid,p_action text,p_event_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare key text; prior jsonb; result jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 if p_action not in ('add','remove') then raise exception 'Only add/remove supported';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select coalesce(m.unit_key,'q:'||p_question_id) into key from (select 1) x left join public.active_recall_reliable_map m on m.question_id=p_question_id;
 select unit into prior from public.qbank_active_recall_rows() r where r.unit_key=key;
 result:=public.qbank_srm_manual(p_question_id,p_action,p_event_id);
 insert into public.active_recall_units(user_id,unit_key,active,due_at,interval_minutes,mastery)
 values(auth.uid(),key,p_action='add',coalesce((prior->>'due_at')::timestamptz,now()),coalesce((prior->>'interval_minutes')::integer,15),coalesce(prior->>'mastery','LEARNING'))
 on conflict(user_id,unit_key) do update set active=excluded.active,due_at=case when excluded.active then coalesce(public.active_recall_units.due_at,now()) else public.active_recall_units.due_at end,updated_at=now();
 return result;
end;
$$;
revoke all on function public.qbank_active_recall_manual(uuid,text,uuid) from public;
grant execute on function public.qbank_active_recall_manual(uuid,text,uuid) to authenticated;

-- Bounded session context: joins happen in one query, only for the requested page.
create function public.qbank_session_history(p_limit integer default 20,p_offset integer default 0,p_include_unfinished boolean default false)
returns jsonb language sql stable security invoker set search_path='' as $$
with page as materialized (
 select t.* from public.test_sessions t where t.user_id=(select auth.uid()) and (p_include_unfinished or t.status<>'in_progress')
 order by t.updated_at desc,t.id limit least(greatest(p_limit,1),30) offset greatest(p_offset,0)
), context as (
 select p.id,string_agg(distinct s.name,', ' order by s.name) subjects,string_agg(distinct pl.name,', ' order by pl.name) platforms
 from page p left join public.test_session_questions sq on sq.session_id=p.id
 left join public.questions q on q.id=sq.question_id left join public.subjects s on s.id=q.subject_id left join public.platforms pl on pl.id=q.platform_id group by p.id
) select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('subjects',coalesce(c.subjects,'Subject unavailable'),'platforms',c.platforms) order by p.updated_at desc,p.id),'[]'::jsonb) from page p join context c using(id);
$$;
revoke all on function public.qbank_session_history(integer,integer,boolean) from public;
grant execute on function public.qbank_session_history(integer,integer,boolean) to authenticated;

create function public.qbank_analytics_tab(p_tab text default 'overview',p_subject_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare output jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in required';end if;
 if p_tab='overview' then
  select jsonb_build_object('attempted',count(*) filter(where attempts>0),'attempts',coalesce(sum(attempts),0),'correct_attempts',coalesce(sum(correct_attempts),0),
   'currently_incorrect',count(*) filter(where last_is_correct=false),'bookmarked',count(*) filter(where bookmarked),'marked',count(*) filter(where marked_for_review or revision),
   'time_seconds',coalesce(sum(total_time_seconds),0)) into output from public.user_question_state where user_id=auth.uid();
 elsif p_tab='subjects' then
  select coalesce(jsonb_agg(to_jsonb(t) order by t.subject),'[]'::jsonb) into output from (
   select q.subject_id,coalesce(s.name,'Unassigned') subject,count(*) filter(where u.attempts>0) attempted,coalesce(sum(u.attempts),0) attempts,coalesce(sum(u.correct_attempts),0) correct_attempts,
   count(*) filter(where u.last_is_correct=false) incorrect from public.user_question_state u join public.questions q on q.id=u.question_id
   left join public.subjects s on s.id=q.subject_id where u.user_id=auth.uid() and (p_subject_id is null or q.subject_id=p_subject_id) group by q.subject_id,s.name
  ) t;
 elsif p_tab='weaknesses' then
  select coalesce(jsonb_agg(unit),'[]'::jsonb) into output from (
   select unit from public.qbank_active_recall_rows() where (unit->>'incorrect')::integer>0
   order by (unit->>'importance')::numeric desc nulls last,(unit->>'consecutive_failures')::integer desc,(unit->>'incorrect')::integer desc limit 30
  ) t;
 elsif p_tab='performance' then
  output:=public.qbank_session_history(20,0,false);
 else raise exception 'Unknown analytics tab';end if;
 return output;
end;
$$;
revoke all on function public.qbank_analytics_tab(text,uuid) from public;
grant execute on function public.qbank_analytics_tab(text,uuid) to authenticated;

create function public.qbank_active_recall_detail(p_unit_key text)
returns jsonb language sql stable security invoker set search_path='' as $$
with item as(select unit from public.qbank_active_recall_rows() where unit_key=p_unit_key), ids as(select (jsonb_array_elements_text(unit->'encountered_question_ids'))::uuid id from item)
select jsonb_build_object('unit',(select unit from item),
 'confident_retrievals',(select count(*) from public.active_recall_retrievals where user_id=(select auth.uid()) and unit_key=p_unit_key and is_correct and strength='strong'),
 'questions',coalesce((select jsonb_agg(jsonb_build_object('question_id',q.id,'platform',p.name)) from ids join public.questions q on q.id=ids.id left join public.platforms p on p.id=q.platform_id),'[]'::jsonb),
 'mistakes',coalesce((select jsonb_agg(to_jsonb(m)) from (select a.error_reason,a.answered_at from public.question_attempts a join ids on ids.id=a.question_id where a.user_id=(select auth.uid()) and a.error_reason is not null order by a.answered_at desc limit 30)m),'[]'::jsonb));
$$;
revoke all on function public.qbank_active_recall_detail(text) from public;
grant execute on function public.qbank_active_recall_detail(text) to authenticated;
