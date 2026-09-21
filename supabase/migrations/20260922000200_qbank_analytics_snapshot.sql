-- Lightweight Analytics landing snapshot.
-- Additive/read-only: no content or learner rows are changed.

create or replace function public.qbank_analytics_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with attempt_stats as (
    select
      a.question_id,
      count(*)::integer attempts,
      count(*) filter (where a.is_correct)::integer correct_attempts,
      count(*) filter (where not a.is_correct)::integer wrong_attempts,
      (array_agg(a.is_correct order by a.answered_at desc, a.id desc))[1] latest_correct,
      sum(a.time_spent_seconds) filter (where a.time_spent_seconds is not null)::bigint timed_seconds,
      count(a.time_spent_seconds)::integer timed_attempts
    from public.question_attempts a
    where a.user_id = auth.uid()
    group by a.question_id
  ), population as materialized (
    select
      q.id,
      q.subject_id,
      coalesce(q.is_pyq,false) or exists (
        select 1
        from public.qbank_source_occurrences o
        join public.qbank_source_tests t on t.id=o.source_test_id
        where o.question_id=q.id and o.is_current and (o.is_pyq or t.is_pyq)
      ) is_pyq,
      coalesce(a.attempts,0) attempts,
      coalesce(a.correct_attempts,0) correct_attempts,
      coalesce(a.wrong_attempts,0) wrong_attempts,
      a.latest_correct,
      coalesce(a.timed_seconds,0) timed_seconds,
      coalesce(a.timed_attempts,0) timed_attempts,
      coalesce(s.bookmarked,false) bookmarked,
      coalesce(s.marked_for_review,false) or coalesce(s.revision,false) marked,
      coalesce(s.srm_active,false) and s.srm_due_at <= now() recall_due,
      coalesce(a.latest_correct,s.last_is_correct) latest_result,
      coalesce(a.timed_seconds,0) > 0 and coalesce(s.last_time_seconds,0) < 30 fast,
      coalesce(s.last_time_seconds,0) > 75 slow,
      coalesce(s.last_time_seconds,0) > 100 very_slow
    from public.questions q
    left join attempt_stats a on a.question_id=q.id
    left join public.user_question_state s on s.user_id=auth.uid() and s.question_id=q.id
    where q.is_usable=true
  ), grouped as (
    select
      subject_id,
      is_pyq,
      count(*)::integer available,
      count(*) filter (where attempts>0)::integer attempted,
      count(*) filter (where attempts>0 and latest_result=true)::integer latest_correct,
      count(*) filter (where attempts>0 and latest_result=false)::integer latest_incorrect,
      sum(attempts)::bigint total_attempts,
      sum(correct_attempts)::bigint attempt_correct,
      sum(timed_seconds)::bigint timed_seconds,
      sum(timed_attempts)::bigint timed_attempts,
      count(*) filter (where bookmarked)::integer bookmarked,
      count(*) filter (where marked)::integer marked,
      count(*) filter (where recall_due)::integer recall_due,
      count(*) filter (where wrong_attempts>=2)::integer repeated_incorrect,
      count(*) filter (where wrong_attempts>=3)::integer wrong_three,
      count(*) filter (where attempts>0 and latest_result=true and wrong_attempts>0)::integer recovered,
      count(*) filter (where attempts>0 and latest_result=false and fast)::integer fast_wrong,
      count(*) filter (where attempts>0 and latest_result=false and slow)::integer slow_wrong,
      count(*) filter (where attempts>0 and very_slow)::integer very_slow
    from population
    group by grouping sets ((subject_id,is_pyq),(subject_id),(is_pyq),())
  ), overall as (
    select * from grouped where subject_id is null and is_pyq is null
  ), pyq as (
    select * from grouped where subject_id is null and is_pyq=true
  ), subjects as (
    select g.*,s.name
    from grouped g join public.subjects s on s.id=g.subject_id
    where g.subject_id is not null and g.is_pyq is null
  )
  select jsonb_build_object(
    'overall',(select to_jsonb(o)-'subject_id'-'is_pyq' from overall o),
    'pyq',(select to_jsonb(p)-'subject_id'-'is_pyq' from pyq p),
    'subjects',coalesce((select jsonb_agg(to_jsonb(s)-'is_pyq' order by s.name) from subjects s),'[]'::jsonb)
  );
$function$;

revoke all on function public.qbank_analytics_snapshot() from public;
grant execute on function public.qbank_analytics_snapshot() to authenticated;

comment on function public.qbank_analytics_snapshot() is
  'Returns compact learner Analytics summary counts without question bodies or full-corpus question ID arrays.';
