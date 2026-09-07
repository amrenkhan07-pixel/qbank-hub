-- Server-side population resolution for large QBank datasets.
-- Additive only: no question, option, attempt, session, bookmark or learning-state rows are changed.

create or replace function public.qbank_resolved_question_ids(p_filters jsonb default '{}'::jsonb)
returns table(question_id uuid)
language sql
stable
security invoker
set search_path = ''
as $function$
  select q.id
  from public.questions q
  where q.is_usable = true
    and (jsonb_array_length(coalesce(p_filters -> 'question_ids', '[]'::jsonb)) = 0 or q.id::text in (select jsonb_array_elements_text(coalesce(p_filters -> 'question_ids', '[]'::jsonb))))
    and (jsonb_array_length(coalesce(p_filters -> 'platforms', '[]'::jsonb)) = 0 or q.platform_id::text in (select jsonb_array_elements_text(coalesce(p_filters -> 'platforms', '[]'::jsonb))))
    and (jsonb_array_length(coalesce(p_filters -> 'subjects', '[]'::jsonb)) = 0 or q.subject_id::text in (select jsonb_array_elements_text(coalesce(p_filters -> 'subjects', '[]'::jsonb))))
    and (jsonb_array_length(coalesce(p_filters -> 'systems', '[]'::jsonb)) = 0 or q.system_id::text in (select jsonb_array_elements_text(coalesce(p_filters -> 'systems', '[]'::jsonb))))
    and (
      jsonb_array_length(coalesce(p_filters -> 'topics', '[]'::jsonb)) = 0
      or exists (
        select 1 from public.question_topics qt
        where qt.question_id = q.id
          and qt.topic_id::text in (select jsonb_array_elements_text(coalesce(p_filters -> 'topics', '[]'::jsonb)))
      )
    )
    and (
      jsonb_array_length(coalesce(p_filters -> 'subtopics', '[]'::jsonb)) = 0
      or exists (
        select 1 from public.question_subtopics qs
        where qs.question_id = q.id
          and qs.subtopic_id::text in (select jsonb_array_elements_text(coalesce(p_filters -> 'subtopics', '[]'::jsonb)))
      )
    )
    and (
      jsonb_array_length(coalesce(p_filters -> 'source_tests', '[]'::jsonb)) = 0
      or exists (
        select 1 from public.qbank_source_occurrences occurrence
        where occurrence.question_id=q.id and occurrence.is_current=true
          and occurrence.source_test_id::text in (select jsonb_array_elements_text(coalesce(p_filters -> 'source_tests', '[]'::jsonb)))
      )
    )
    and (
      coalesce(p_filters ->> 'pyq', '') = ''
      or (
        coalesce(p_filters ->> 'pyq', '') = 'yes'
        and (
          q.is_pyq = true
          or exists (
            select 1
            from public.qbank_source_occurrences occurrence
            join public.qbank_source_tests st on st.id = occurrence.source_test_id
            where occurrence.question_id = q.id and occurrence.is_current = true
              and (occurrence.is_pyq = true or st.is_pyq = true)
          )
        )
      )
      or (
        coalesce(p_filters ->> 'pyq', '') = 'no'
        and q.is_pyq is not true
        and not exists (
          select 1
          from public.qbank_source_occurrences occurrence
          join public.qbank_source_tests st on st.id = occurrence.source_test_id
          where occurrence.question_id = q.id and occurrence.is_current = true
            and (occurrence.is_pyq = true or st.is_pyq = true)
        )
      )
    )
    and (coalesce(p_filters ->> 'year', '') = '' or q.exam_year = (p_filters ->> 'year')::integer)
    and (jsonb_array_length(coalesce(p_filters -> 'years', '[]'::jsonb)) = 0 or q.exam_year::text in (select jsonb_array_elements_text(coalesce(p_filters -> 'years', '[]'::jsonb))))
    and (jsonb_array_length(coalesce(p_filters -> 'sessions', '[]'::jsonb)) = 0 or q.exam_shift in (select jsonb_array_elements_text(coalesce(p_filters -> 'sessions', '[]'::jsonb))))
    and (
      jsonb_array_length(coalesce(p_filters -> 'exams', '[]'::jsonb)) = 0
      or ('inicet' in (select jsonb_array_elements_text(coalesce(p_filters -> 'exams', '[]'::jsonb))) and q.is_inicet = true)
      or ('neet_pg' in (select jsonb_array_elements_text(coalesce(p_filters -> 'exams', '[]'::jsonb))) and q.is_neet_pg = true)
      or exists (
        select 1 from unnest(coalesce(q.exam_tags, '{}'::text[])) tag
        where tag in (select jsonb_array_elements_text(coalesce(p_filters -> 'exams', '[]'::jsonb)))
      )
    )
    and (coalesce(p_filters ->> 'search', '') = '' or q.question_text ilike '%' || (p_filters ->> 'search') || '%')
    and (coalesce(p_filters ->> 'source', '') = '' or coalesce(q.source_reference, '') ilike '%' || (p_filters ->> 'source') || '%')
    and (
      jsonb_array_length(coalesce(p_filters -> 'statuses', '[]'::jsonb)) = 0
      or 'all' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb)))
      or ('my_content' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb))) and q.created_by = auth.uid() and q.content_origin = 'user')
      or ('new' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb))) and not exists (select 1 from public.question_attempts qa where qa.user_id = auth.uid() and qa.question_id = q.id))
      or ('attempted' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb))) and exists (select 1 from public.question_attempts qa where qa.user_id = auth.uid() and qa.question_id = q.id))
      or ('bookmarked' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb))) and exists (select 1 from public.user_question_state uqs where uqs.user_id = auth.uid() and uqs.question_id = q.id and uqs.bookmarked = true))
      or ('marked' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb))) and exists (select 1 from public.user_question_state uqs where uqs.user_id = auth.uid() and uqs.question_id = q.id and (uqs.marked_for_review = true or uqs.revision = true)))
      or ('incorrect' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb))) and exists (select 1 from public.user_question_state uqs where uqs.user_id = auth.uid() and uqs.question_id = q.id and (uqs.last_is_correct = false or uqs.wrong = true)))
      or ('correct' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb))) and exists (select 1 from public.user_question_state uqs where uqs.user_id = auth.uid() and uqs.question_id = q.id and uqs.last_is_correct = true))
      or ('recall_due' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb))) and exists (select 1 from public.user_question_state uqs where uqs.user_id = auth.uid() and uqs.question_id = q.id and uqs.srm_active = true and uqs.srm_due_at <= now()))
      or ('difficult' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb))) and exists (select 1 from public.user_question_state uqs where uqs.user_id = auth.uid() and uqs.question_id = q.id and uqs.personally_difficult = true))
      or ('confident_wrong' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb))) and exists (select 1 from public.user_question_state uqs where uqs.user_id = auth.uid() and uqs.question_id = q.id and uqs.last_is_correct = false and uqs.last_confidence = 'sure'))
      or ('slow' in (select jsonb_array_elements_text(coalesce(p_filters -> 'statuses', '[]'::jsonb))) and exists (select 1 from public.user_question_state uqs where uqs.user_id = auth.uid() and uqs.question_id = q.id and uqs.last_time_seconds > 50))
    );
$function$;

create or replace function public.qbank_resolve_population(
  p_filters jsonb default '{}'::jsonb,
  p_include_ids boolean default false,
  p_limit integer default null,
  p_offset integer default 0,
  p_order text default 'canonical'
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with matched as materialized (
    select * from public.qbank_resolved_question_ids(coalesce(p_filters, '{}'::jsonb))
  ), ordered as (
    select matched.question_id, source_order.sequence, source_order.question_position
    from matched
    left join lateral (
      select st.sequence, occurrence.question_position
      from public.qbank_source_occurrences occurrence
      join public.qbank_source_tests st on st.id=occurrence.source_test_id
      where occurrence.question_id=matched.question_id and occurrence.is_current=true
        and (jsonb_array_length(coalesce(p_filters->'source_tests','[]'::jsonb))=0 or occurrence.source_test_id::text in (select jsonb_array_elements_text(coalesce(p_filters->'source_tests','[]'::jsonb))))
      order by st.sequence, occurrence.question_position, occurrence.id limit 1
    ) source_order on p_order='source'
  ), selected as (
    select question_id from ordered
    order by
      case when p_order = 'source' then sequence end,
      case when p_order = 'source' then question_position end,
      case when p_order = 'sample' then md5(question_id::text || coalesce(p_filters ->> 'sample_seed', 'qbank')) end,
      question_id
    offset greatest(coalesce(p_offset, 0), 0)
    limit case when p_include_ids then p_limit else 0 end
  )
  select jsonb_build_object(
    'count', (select count(*) from matched),
    'question_ids', case when p_include_ids then coalesce((select jsonb_agg(question_id) from selected), '[]'::jsonb) else '[]'::jsonb end
  );
$function$;

create or replace function public.qbank_filter_facets(p_filters jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with
  platform_population as materialized (
    select question_id from public.qbank_resolved_question_ids(coalesce(p_filters, '{}'::jsonb) - array['platforms','subjects','systems','topics','subtopics','source_tests'])
  ),
  subject_population as materialized (
    select question_id from public.qbank_resolved_question_ids(coalesce(p_filters, '{}'::jsonb) - array['subjects','systems','topics','subtopics','source_tests'])
  ),
  system_population as materialized (
    select question_id from public.qbank_resolved_question_ids(coalesce(p_filters, '{}'::jsonb) - array['systems','topics','subtopics','source_tests'])
  ),
  topic_population as materialized (
    select question_id from public.qbank_resolved_question_ids(coalesce(p_filters, '{}'::jsonb) - array['topics','subtopics','source_tests'])
  ),
  subtopic_population as materialized (
    select question_id from public.qbank_resolved_question_ids(coalesce(p_filters, '{}'::jsonb) - array['subtopics','source_tests'])
  ),
  source_population as materialized (
    select question_id from public.qbank_resolved_question_ids(coalesce(p_filters, '{}'::jsonb) - 'source_tests')
  ),
  full_population as materialized (
    select question_id from public.qbank_resolved_question_ids(coalesce(p_filters, '{}'::jsonb))
  )
  select jsonb_build_object(
    'count', (select count(*) from full_population),
    'platforms', coalesce((select jsonb_agg(distinct q.platform_id) filter (where q.platform_id is not null) from platform_population p join public.questions q on q.id=p.question_id), '[]'::jsonb),
    'subjects', coalesce((select jsonb_agg(distinct q.subject_id) filter (where q.subject_id is not null) from subject_population p join public.questions q on q.id=p.question_id), '[]'::jsonb),
    'systems', coalesce((select jsonb_agg(distinct q.system_id) filter (where q.system_id is not null) from system_population p join public.questions q on q.id=p.question_id), '[]'::jsonb),
    'topics', coalesce((select jsonb_agg(distinct qt.topic_id) from topic_population p join public.question_topics qt on qt.question_id=p.question_id), '[]'::jsonb),
    'subtopics', coalesce((select jsonb_agg(distinct qs.subtopic_id) from subtopic_population p join public.question_subtopics qs on qs.question_id=p.question_id), '[]'::jsonb),
    'source_tests', coalesce((select jsonb_agg(distinct occurrence.source_test_id) from source_population p join public.qbank_source_occurrences occurrence on occurrence.question_id=p.question_id and occurrence.is_current=true), '[]'::jsonb),
    'exams', coalesce((select jsonb_agg(distinct value) from full_population p join public.questions q on q.id=p.question_id cross join lateral unnest((case when q.is_inicet then array['inicet'] else '{}'::text[] end) || (case when q.is_neet_pg then array['neet_pg'] else '{}'::text[] end) || coalesce(q.exam_tags, '{}'::text[])) value), '[]'::jsonb),
    'years', coalesce((select jsonb_agg(distinct q.exam_year order by q.exam_year) filter (where q.exam_year is not null) from full_population p join public.questions q on q.id=p.question_id), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(distinct q.exam_shift order by q.exam_shift) filter (where q.exam_shift is not null and q.exam_shift <> '') from full_population p join public.questions q on q.id=p.question_id), '[]'::jsonb)
  );
$function$;

create or replace function public.qbank_population_groups(p_filters jsonb, p_dimension text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  result jsonb;
begin
  if p_dimension not in ('platform','subject','system','topic','subtopic','source_test','pyq','exam','year_session') then
    raise exception 'Unsupported QBank population dimension: %', p_dimension;
  end if;

  with population as materialized (
    select question_id from public.qbank_resolved_question_ids(coalesce(p_filters, '{}'::jsonb))
  ), memberships as (
    select q.platform_id::text id, platform.name, p.question_id from population p join public.questions q on q.id=p.question_id join public.platforms platform on platform.id=q.platform_id where p_dimension='platform'
    union all select q.subject_id::text, subject.name, p.question_id from population p join public.questions q on q.id=p.question_id join public.subjects subject on subject.id=q.subject_id where p_dimension='subject'
    union all select q.system_id::text, system.name, p.question_id from population p join public.questions q on q.id=p.question_id join public.systems system on system.id=q.system_id where p_dimension='system'
    union all select qt.topic_id::text, topic.name, p.question_id from population p join public.question_topics qt on qt.question_id=p.question_id join public.topics topic on topic.id=qt.topic_id where p_dimension='topic'
    union all select qs.subtopic_id::text, subtopic.name, p.question_id from population p join public.question_subtopics qs on qs.question_id=p.question_id join public.subtopics subtopic on subtopic.id=qs.subtopic_id where p_dimension='subtopic'
    union all select occurrence.source_test_id::text, st.title, p.question_id from population p join public.qbank_source_occurrences occurrence on occurrence.question_id=p.question_id and occurrence.is_current=true join public.qbank_source_tests st on st.id=occurrence.source_test_id where p_dimension='source_test'
    union all select case when q.is_pyq=true or exists(select 1 from public.qbank_source_occurrences occurrence join public.qbank_source_tests st on st.id=occurrence.source_test_id where occurrence.question_id=q.id and occurrence.is_current=true and (occurrence.is_pyq=true or st.is_pyq=true)) then 'yes' else 'no' end, case when q.is_pyq=true or exists(select 1 from public.qbank_source_occurrences occurrence join public.qbank_source_tests st on st.id=occurrence.source_test_id where occurrence.question_id=q.id and occurrence.is_current=true and (occurrence.is_pyq=true or st.is_pyq=true)) then 'PYQ' else 'Non-PYQ' end, p.question_id from population p join public.questions q on q.id=p.question_id where p_dimension='pyq'
    union all select exam.id, exam.name, p.question_id from population p join public.questions q on q.id=p.question_id cross join lateral (select 'inicet', 'INI-CET' where q.is_inicet union all select 'neet_pg', 'NEET PG' where q.is_neet_pg union all select tag, initcap(replace(tag,'_',' ')) from unnest(coalesce(q.exam_tags,'{}'::text[])) tag) exam(id,name) where p_dimension='exam'
    union all select coalesce(q.exam_year::text,'Unknown year') || case when coalesce(q.exam_shift,'')<>'' then ' · '||q.exam_shift else '' end, coalesce(q.exam_year::text,'Unknown year') || case when coalesce(q.exam_shift,'')<>'' then ' · '||q.exam_shift else '' end, p.question_id from population p join public.questions q on q.id=p.question_id where p_dimension='year_session' and (q.exam_year is not null or coalesce(q.exam_shift,'')<>'')
  ), grouped as (
    select id, min(name) name, array_agg(distinct question_id order by question_id) question_ids
    from memberships where id is not null group by id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'question_ids',question_ids) order by name), '[]'::jsonb) into result from grouped;
  return result;
end;
$function$;

revoke all on function public.qbank_resolved_question_ids(jsonb) from public;
revoke all on function public.qbank_resolve_population(jsonb, boolean, integer, integer, text) from public;
revoke all on function public.qbank_filter_facets(jsonb) from public;
revoke all on function public.qbank_population_groups(jsonb, text) from public;
grant execute on function public.qbank_resolved_question_ids(jsonb) to authenticated;
grant execute on function public.qbank_resolve_population(jsonb, boolean, integer, integer, text) to authenticated;
grant execute on function public.qbank_filter_facets(jsonb) to authenticated;
grant execute on function public.qbank_population_groups(jsonb, text) to authenticated;

comment on function public.qbank_resolve_population(jsonb, boolean, integer, integer, text) is 'Canonical authenticated usable-question population resolver shared by QBank and Analytics.';
comment on function public.qbank_filter_facets(jsonb) is 'Returns count and valid downstream filter IDs without sending the question corpus to the browser.';
comment on function public.qbank_population_groups(jsonb, text) is 'Returns lazy analytics group memberships for one requested dimension.';
