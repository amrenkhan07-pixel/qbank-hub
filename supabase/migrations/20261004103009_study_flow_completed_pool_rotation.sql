create or replace function public.smart_recall_importance_candidates(p_subjects text[] default null,p_exam_focus text default 'All',p_limit_per_subject integer default 50)
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
 select *,case when open_tier is null then 3 else tier end as exposure_tier,
 row_number() over(partition by subject order by
 case when open_tier is null then last_exposed_at end nulls first,
 tier,last_exposed_at nulls first,covered_at nulls first,
 md5(concept_id||(select auth.uid())::text||current_date::text)) n
 from frontier where (open_tier is not null and covered_at is null and tier=open_tier) or open_tier is null
 )
 select subject,concept_id,primary_concept,global_importance_tier,global_importance_score,latest_exam_year,total_pyq_occurrences,eligible_questions
 from ranked where n<=greatest(1,least(p_limit_per_subject,100))
 order by exposure_tier,n,md5(subject||current_date::text);
$$;
revoke all on function public.smart_recall_importance_candidates(text[],text,integer) from public,anon;
grant execute on function public.smart_recall_importance_candidates(text[],text,integer) to authenticated;

