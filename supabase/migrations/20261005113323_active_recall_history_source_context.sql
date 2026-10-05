create or replace function public.qbank_session_history(p_limit integer default 20,p_offset integer default 0,p_include_unfinished boolean default false)
returns jsonb language sql stable security invoker set search_path='' as $$
with page as materialized (
 select t.* from public.test_sessions t where t.user_id=(select auth.uid()) and (p_include_unfinished or t.status<>'in_progress')
 order by t.updated_at desc,t.id limit least(greatest(p_limit,1),30) offset greatest(p_offset,0)
), context as (
 select p.id,string_agg(distinct s.name,', ' order by s.name) subjects,string_agg(distinct pl.name,', ' order by pl.name) platforms
 from page p left join public.test_session_questions sq on sq.session_id=p.id
 left join public.questions q on q.id=sq.question_id left join public.subjects s on s.id=q.subject_id left join public.platforms pl on pl.id=q.platform_id group by p.id
) select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('subjects',coalesce(c.subjects,'Subject unavailable'),'platforms',c.platforms,'modules',(select string_agg(t.title,' · ' order by t.sequence) from public.qbank_source_tests t where t.id::text in (select jsonb_array_elements_text(case when jsonb_typeof(p.filters->'source_tests')='array' then p.filters->'source_tests' else '[]'::jsonb end)))) order by p.updated_at desc,p.id),'[]'::jsonb) from page p join context c using(id);
$$;
