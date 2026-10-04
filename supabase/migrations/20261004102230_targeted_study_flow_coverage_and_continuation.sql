-- Compact learner state only. No question, taxonomy, occurrence or score writes.
create table public.smart_recall_concept_coverage (
 user_id uuid not null references auth.users(id) on delete cascade,
 exam_focus text not null default 'All' check(exam_focus in ('All','NEET-PG','INI-CET','AIIMS')),
 subject text not null, concept_id text not null,
 last_exposed_at timestamptz not null default now(),
 covered_at timestamptz,
 primary key(user_id,exam_focus,subject,concept_id),
 foreign key(subject,concept_id) references public.pyq_concept_importance(subject,concept_id)
);
alter table public.smart_recall_concept_coverage enable row level security;
create policy smart_coverage_owner on public.smart_recall_concept_coverage for all to authenticated
 using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
grant select,insert,update on public.smart_recall_concept_coverage to authenticated;
grant all on public.smart_recall_concept_coverage to service_role;

create function public.smart_recall_track_coverage() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s public.test_sessions; focus text; successful boolean := false;
begin
 select * into s from public.test_sessions where id=new.session_id;
 if s.user_id is null or (auth.uid() is not null and s.user_id<>auth.uid()) or
    not (s.preset='smart-recall' or (s.mode='recall' and s.filters ? 'importance_concept')) then return new; end if;
 focus:=coalesce(s.filters#>>'{smart_recall,exam_focus}',s.filters#>>'{importance_concept,exam_focus}','All');
 if focus not in ('All','NEET-PG','INI-CET','AIIMS') then focus:='All'; end if;
 if tg_table_name='test_answers' then
  -- client_event_id is assigned only when an answer is submitted, including multi-select.
  if new.client_event_id is null or new.selected_option is null then return new; end if;
  if tg_op='UPDATE' and old.client_event_id is not distinct from new.client_event_id and old.is_correct is not distinct from new.is_correct then return new; end if;
  successful:=new.is_correct is true;
 end if;
 insert into public.smart_recall_concept_coverage(user_id,exam_focus,subject,concept_id,last_exposed_at,covered_at)
 select s.user_id,focus,c.subject,c.concept_id,now(),case when successful then now() end
 from public.pyq_concept_importance c where new.question_id=any(c.question_ids)
 on conflict(user_id,exam_focus,subject,concept_id) do update set
 last_exposed_at=greatest(smart_recall_concept_coverage.last_exposed_at,excluded.last_exposed_at),
 covered_at=coalesce(excluded.covered_at,smart_recall_concept_coverage.covered_at);
 return new;
end $$;
revoke all on function public.smart_recall_track_coverage() from public,anon;
create trigger smart_recall_exposure after insert on public.test_session_questions for each row execute function public.smart_recall_track_coverage();
create trigger smart_recall_completion after insert or update on public.test_answers for each row execute function public.smart_recall_track_coverage();

-- One-time reconstruction from saved Smart Recall sessions; no attempt history is rewritten.
insert into public.smart_recall_concept_coverage(user_id,exam_focus,subject,concept_id,last_exposed_at,covered_at)
select s.user_id,'All',c.subject,c.concept_id,max(coalesce(a.answered_at,s.started_at)),
 max(a.answered_at) filter(where a.is_correct and a.client_event_id is not null)
from public.test_sessions s join public.test_session_questions q on q.session_id=s.id
join public.pyq_concept_importance c on q.question_id=any(c.question_ids)
left join public.test_answers a on a.session_id=s.id and a.question_id=q.question_id
where s.preset='smart-recall' or (s.mode='recall' and s.filters ? 'importance_concept')
group by s.user_id,c.subject,c.concept_id
on conflict do nothing;

create function public.smart_recall_importance_candidates(p_subjects text[] default null,p_exam_focus text default 'All',p_limit_per_subject integer default 50)
returns table(subject text,concept_id text,primary_concept text,global_importance_tier text,global_importance_score numeric,latest_exam_year integer,total_pyq_occurrences integer,question_ids uuid[])
language sql stable security invoker set search_path=pg_catalog,public as $$
 with candidates as (
 select c.*,v.covered_at,v.last_exposed_at,
 case c.global_importance_tier when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end tier,
 q.ids as eligible_questions
 from public.pyq_concept_importance c
 left join public.smart_recall_concept_coverage v on v.user_id=(select auth.uid()) and v.exam_focus=p_exam_focus and v.subject=c.subject and v.concept_id=c.concept_id
 join lateral (
 select array_agg(q.id order by u.last_attempted_at nulls first,md5(q.id::text||current_date::text)) ids from unnest(c.question_ids) ids(id) join public.questions q on q.id=ids.id
 left join public.user_question_state u on u.user_id=(select auth.uid()) and u.question_id=q.id
 where q.is_usable and not coalesce(q.is_grand_test,false) and q.id<>'4c7dc09f-5a20-5bf5-a4f6-febc9ef48842'::uuid
 having count(*)>0
 ) q on true
 where auth.uid() is not null and (p_subjects is null or c.subject=any(p_subjects))
 and (p_exam_focus='All' or p_exam_focus=any(c.distinct_exam_types_present))
 ), frontier as (
 select *,min(tier) filter(where covered_at is null) over(partition by subject) as open_tier from candidates
 ), ranked as (
 select *,row_number() over(partition by subject order by
 tier,last_exposed_at nulls first,covered_at nulls first,
 md5(concept_id||(select auth.uid())::text||current_date::text)) n
 from frontier where (open_tier is not null and covered_at is null and tier=open_tier) or open_tier is null
 )
 select subject,concept_id,primary_concept,global_importance_tier,global_importance_score,latest_exam_year,total_pyq_occurrences,eligible_questions
 from ranked where n<=greatest(1,least(p_limit_per_subject,100))
 order by tier,n,md5(subject||current_date::text);
$$;
revoke all on function public.smart_recall_importance_candidates(text[],text,integer) from public,anon;
grant execute on function public.smart_recall_importance_candidates(text[],text,integer) to authenticated;

create function public.qbank_continue_learning() returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 with last_session as (
 select * from public.test_sessions s where s.user_id=(select auth.uid()) and s.status='completed'
 and s.mode in ('practice','test') and s.preset in ('qbank','custom')
 and not (s.filters ? 'importance_concept')
 order by s.updated_at desc limit 1
 ), session_modules as (
 select t.id from last_session s join public.qbank_source_tests t on
 (jsonb_array_length(coalesce(s.filters->'source_tests','[]'))=1 and t.id::text=s.filters#>>'{source_tests,0}')
 or (jsonb_array_length(coalesce(s.filters->'source_tests','[]'))=0 and exists(select 1 from public.test_session_questions q where q.session_id=s.id)
 and not exists(select 1 from public.test_session_questions q where q.session_id=s.id and not exists(select 1 from public.qbank_source_occurrences o where o.question_id=q.question_id and o.source_test_id=t.id and o.is_current)))
 ), module as (
 select t.* from last_session s cross join public.qbank_source_tests t
 where t.id in(select id from session_modules) and (select count(*) from session_modules)=1 and t.sequence is not null and not coalesce(t.is_pyq,false)
 -- Do not advance past an incomplete/partially sampled module.
 and not exists(select 1 from public.qbank_source_occurrences o join public.questions q on q.id=o.question_id
 where o.source_test_id=t.id and o.is_current and q.is_usable and not exists(
 select 1 from public.test_answers a where a.session_id=s.id and a.question_id=q.id and a.selected_option is not null))
 ), next_modules as (
 select n.* from module m join public.qbank_source_tests n on n.platform_id=m.platform_id and n.subject_id=m.subject_id
 and n.source_path=m.source_path and n.sequence>m.sequence and not coalesce(n.is_pyq,false)
 where exists(select 1 from public.qbank_source_occurrences o join public.questions q on q.id=o.question_id where o.source_test_id=n.id and o.is_current and q.is_usable and not coalesce(q.is_grand_test,false))
 ), next_sequence as(select * from next_modules where sequence=(select min(sequence) from next_modules))
 select case when (select count(*) from next_sequence)=1 then
 (select jsonb_build_object('source_test_id',n.id,'title',n.title,'platform_id',n.platform_id,'subject_id',n.subject_id,'source_path',n.source_path,'subject',s.name,'platform',p.name) from next_sequence n join public.subjects s on s.id=n.subject_id join public.platforms p on p.id=n.platform_id)
 else null end;
$$;
revoke all on function public.qbank_continue_learning() from public,anon;
grant execute on function public.qbank_continue_learning() to authenticated;
