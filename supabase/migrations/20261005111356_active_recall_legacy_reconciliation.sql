-- Later ordinary confident attempts must not reactivate stale member schedules. Later lapses still enroll automatically.
create or replace function public.qbank_active_recall_rows()
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
 max(srm_last_reviewed_at) reviewed,max(srm_last_reviewed_at) filter(where last_is_correct=false or last_confidence in ('unsure','guess')) problem_reviewed,max(updated_at) changed,
 min(srm_interval_minutes) filter(where srm_active) legacy_interval,
 max(srm_consecutive_incorrect) failures,sum(attempts) attempts,sum(correct_attempts) correct,
 jsonb_agg(jsonb_build_object('question_id',question_id,'last_attempted_at',last_attempted_at,'error_reason',last_error_reason)) questions
 from mapped group by key
), effective as (
 select g.*,u.last_question_id,
 case when u.updated_at>=coalesce(g.problem_reviewed,'-infinity'::timestamptz) then u.active else g.enrolled end active,
 case when u.updated_at>=coalesce(g.problem_reviewed,'-infinity'::timestamptz) then u.due_at else g.legacy_due end due,
 case when u.updated_at>=coalesce(g.problem_reviewed,'-infinity'::timestamptz) then u.interval_minutes else coalesce(g.legacy_interval,15) end minutes,
 case when u.updated_at>=coalesce(g.problem_reviewed,'-infinity'::timestamptz) then u.mastery else case when g.failures>=2 then 'WEAK' else 'LEARNING' end end mastery,
 case when u.updated_at>=coalesce(g.problem_reviewed,'-infinity'::timestamptz) then u.consecutive_failures else coalesce(g.failures,0) end consecutive_failures,case when g.problem_reviewed>u.updated_at then 0 else coalesce(u.spaced_successes,0) end spaced_successes,
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

alter table public.active_recall_retrievals add column error_reason text check(error_reason is null or error_reason in ('didnt_know','forgot','misread','confused_options','overthought','silly_mistake','guess'));
grant update(error_reason) on public.active_recall_retrievals to authenticated;
create or replace function public.qbank_active_recall_detail(p_unit_key text)
returns jsonb language sql stable security invoker set search_path='' as $$
with item as(select unit from public.qbank_active_recall_rows() where unit_key=p_unit_key), ids as(select (jsonb_array_elements_text(unit->'encountered_question_ids'))::uuid id from item)
select jsonb_build_object('unit',(select unit from item),
 'confident_retrievals',(select count(*) from public.active_recall_retrievals where user_id=(select auth.uid()) and unit_key=p_unit_key and is_correct and strength='strong'),
 'questions',coalesce((select jsonb_agg(jsonb_build_object('question_id',q.id,'platform',p.name)) from ids join public.questions q on q.id=ids.id left join public.platforms p on p.id=q.platform_id),'[]'::jsonb),
 'mistakes',coalesce((select jsonb_agg(to_jsonb(m)) from (select coalesce(r.error_reason,a.error_reason) error_reason,a.answered_at from public.question_attempts a join ids on ids.id=a.question_id left join public.active_recall_retrievals r on r.user_id=a.user_id and r.event_id=a.client_event_id where a.user_id=(select auth.uid()) and coalesce(r.error_reason,a.error_reason) is not null order by a.answered_at desc limit 30)m),'[]'::jsonb));
$$;
