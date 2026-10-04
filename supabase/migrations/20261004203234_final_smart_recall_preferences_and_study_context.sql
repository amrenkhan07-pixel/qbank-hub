alter table public.user_srm_settings add column smart_recall_preferences jsonb,
 add column smart_recall_revision integer not null default 0,
 add column smart_recall_notice jsonb not null default '[]';

create function public.smart_recall_save_preferences(p_preferences jsonb,p_expected_revision integer,p_notice jsonb default '[]') returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare saved public.user_srm_settings;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if jsonb_typeof(p_preferences)<>'object' or octet_length(p_preferences::text)>16000 or jsonb_typeof(p_notice)<>'array' then raise exception 'Invalid Recall preferences'; end if;
 insert into public.user_srm_settings(user_id) values(auth.uid()) on conflict do nothing;
 select * into saved from public.user_srm_settings where user_id=auth.uid() for update;
 if saved.smart_recall_revision<>p_expected_revision then raise exception 'Recall preferences changed on another device. Reload before saving.'; end if;
 update public.user_srm_settings set smart_recall_preferences=p_preferences,smart_recall_notice=p_notice,
 smart_recall_revision=smart_recall_revision+1,updated_at=now() where user_id=auth.uid() returning * into saved;
 return jsonb_build_object('preferences',saved.smart_recall_preferences,'revision',saved.smart_recall_revision,'notice',saved.smart_recall_notice);
end $$;
revoke all on function public.smart_recall_save_preferences(jsonb,integer,jsonb) from public,anon;
grant execute on function public.smart_recall_save_preferences(jsonb,integer,jsonb) to authenticated;

create function public.smart_recall_coverage_summary(p_exam_focus text default 'All') returns table(subject text,high_total bigint,high_covered bigint,medium_total bigint,medium_covered bigint,low_total bigint,low_covered bigint,last_exposed_at timestamptz)
language sql stable security invoker set search_path=pg_catalog,public as $$
 select c.subject,count(*) filter(where c.global_importance_tier='HIGH'),count(*) filter(where c.global_importance_tier='HIGH' and v.covered_at is not null),
 count(*) filter(where c.global_importance_tier='MEDIUM'),count(*) filter(where c.global_importance_tier='MEDIUM' and v.covered_at is not null),
 count(*) filter(where c.global_importance_tier='LOW'),count(*) filter(where c.global_importance_tier='LOW' and v.covered_at is not null),max(v.last_exposed_at)
 from public.pyq_concept_importance c left join public.smart_recall_concept_coverage v on v.user_id=(select auth.uid()) and v.exam_focus=p_exam_focus and v.subject=c.subject and v.concept_id=c.concept_id
 where auth.uid() is not null and (p_exam_focus='All' or p_exam_focus=any(c.distinct_exam_types_present))
 and exists(select 1 from unnest(c.question_ids) ids(id) join public.questions q on q.id=ids.id where q.is_usable and not coalesce(q.is_grand_test,false) and q.id<>'4c7dc09f-5a20-5bf5-a4f6-febc9ef48842'::uuid)
 group by c.subject;
$$;
revoke all on function public.smart_recall_coverage_summary(text) from public,anon;
grant execute on function public.smart_recall_coverage_summary(text) to authenticated;

-- Bounded personal candidate windows from universal aggregate state, never raw attempt history.
create function public.smart_recall_personal_candidates(p_subject text default null,p_limit integer default 90) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 with gi as materialized (
 select unnest(c.question_ids) question_id,c.subject,c.concept_id,c.primary_concept,c.global_importance_tier tier,c.global_importance_score score from public.pyq_concept_importance c
 ), ids as (
 select question_id from public.user_question_state where user_id=(select auth.uid())
 union select question_id from public.bookmarks where user_id=(select auth.uid())
 ), personal as materialized (
 select q.id question_id,coalesce(g.subject,s.name) subject,g.concept_id,g.primary_concept,g.tier,coalesce(g.score,0) score,
 coalesce(u.attempts,0) attempts,coalesce(u.wrong,false) or u.last_is_correct=false incorrect,
 coalesce(u.srm_consecutive_incorrect,0) repeated,
 coalesce(u.bookmarked,false) or exists(select 1 from public.bookmarks b where b.user_id=(select auth.uid()) and b.question_id=q.id) bookmarked,
 coalesce(u.marked_for_review,false) or coalesce(u.revision,false) marked_for_review,
 u.last_attempted_at,case when u.srm_active then u.srm_due_at else u.recall_due_at end due_at
 from ids join public.questions q on q.id=ids.question_id join public.subjects s on s.id=q.subject_id
 left join public.user_question_state u on u.user_id=(select auth.uid()) and u.question_id=q.id
 left join gi g on g.question_id=q.id
 where q.is_usable and not coalesce(q.is_grand_test,false) and q.id<>'4c7dc09f-5a20-5bf5-a4f6-febc9ef48842'::uuid
 and (p_subject is null or coalesce(g.subject,case when s.name='ENT' then 'Otorhinolaryngology' else s.name end)=p_subject)
 ), mistakes as (
 select * from personal where incorrect or repeated>0
 order by (tier='HIGH' and repeated>1) desc nulls last,repeated desc,score desc,last_attempted_at nulls first limit greatest(1,least(p_limit,100))
 ), saved as (
 select * from personal where bookmarked or marked_for_review
 order by (due_at<=now()) desc nulls last,last_attempted_at nulls first,question_id limit greatest(1,least(p_limit,100))
 ), due as (
 select * from personal where due_at<=now() or (due_at is null and attempts>0 and last_attempted_at<now()-interval '7 days')
 order by due_at nulls last,last_attempted_at nulls first,question_id limit greatest(1,least(p_limit,100))
 )
 select jsonb_build_object('mistakes',coalesce((select jsonb_agg(to_jsonb(m)) from mistakes m),'[]'),
 'bookmarks',coalesce((select jsonb_agg(to_jsonb(b)) from saved b),'[]'),'due',coalesce((select jsonb_agg(to_jsonb(d)) from due d),'[]'));
$$;
revoke all on function public.smart_recall_personal_candidates(text,integer) from public,anon;
grant execute on function public.smart_recall_personal_candidates(text,integer) to authenticated;

create function public.qbank_study_continuation() returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 with next_module as materialized (select public.qbank_continue_learning() as value)
 select coalesce((select jsonb_build_object('kind','resume','session',to_jsonb(s)) from public.test_sessions s
 where s.user_id=(select auth.uid()) and s.status='in_progress' and s.mode in ('practice','test') and s.preset in ('qbank','custom')
 and not (s.filters ? 'importance_concept') order by s.updated_at desc limit 1),
 (select case when value is not null then jsonb_build_object('kind','next','module',value) else null end from next_module));
$$;
revoke all on function public.qbank_study_continuation() from public,anon;
grant execute on function public.qbank_study_continuation() to authenticated;

create function public.smart_recall_importance_pool(p_subjects text[] default null,p_exam_focus text default 'All',p_limit_per_subject integer default 50) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('coverage_state',case when v.covered_at is not null then 'COVERED' when v.last_exposed_at is not null then 'WEAK' else 'UNSEEN' end) order by c.ordinality),'[]')
 from public.smart_recall_importance_candidates(p_subjects,p_exam_focus,p_limit_per_subject) with ordinality c
 left join public.smart_recall_concept_coverage v on v.user_id=(select auth.uid()) and v.exam_focus=p_exam_focus and v.subject=c.subject and v.concept_id=c.concept_id;
$$;
revoke all on function public.smart_recall_importance_pool(text[],text,integer) from public,anon;
grant execute on function public.smart_recall_importance_pool(text[],text,integer) to authenticated;
