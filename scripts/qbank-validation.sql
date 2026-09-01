-- QBank Hub fail-safe validation report.
-- Read-only, aggregate-first, deterministic, and safe for large imports.
-- Run with: psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -P pager=off -f scripts/qbank-validation.sql

with
question_option_stats as (
  select q.id,
         (p.question_id is not null) as is_hybrid,
         count(o.id) as option_count,
         count(distinct upper(btrim(o.option_key))) filter (where nullif(btrim(o.option_key), '') is not null) as distinct_keys,
         count(*) filter (where o.id is not null and nullif(btrim(o.option_text), '') is null) as blank_options,
         count(*) filter (where o.is_correct) as correct_options
  from public.questions q
  left join public.question_options o on o.question_id = q.id
  left join public.qbank_question_payloads p on p.question_id = q.id
  group by q.id, p.question_id
),
latest_attempt as (
  select distinct on (user_id, question_id)
         user_id, question_id, is_correct, time_spent_seconds, answered_at
  from public.question_attempts
  order by user_id, question_id, answered_at desc, id desc
),
session_rollup as (
  select s.id, s.user_id, s.status, s.total_questions,
         count(sq.question_id) as stored_count,
         count(distinct sq.question_id) as distinct_count,
         min(sq.position) as min_position,
         max(sq.position) as max_position
  from public.test_sessions s
  left join public.test_session_questions sq on sq.session_id = s.id
  group by s.id
),
session_filter_violations as (
  select count(*) as failures
  from public.test_sessions s
  join public.test_session_questions sq on sq.session_id = s.id
  join public.questions q on q.id = sq.question_id
  where
    (coalesce(jsonb_array_length(s.filters -> 'platforms'), 0) > 0 and not ((s.filters -> 'platforms') ? q.platform_id::text))
    or (coalesce(jsonb_array_length(s.filters -> 'subjects'), 0) > 0 and not ((s.filters -> 'subjects') ? q.subject_id::text))
    or (coalesce(jsonb_array_length(s.filters -> 'systems'), 0) > 0 and not ((s.filters -> 'systems') ? coalesce(q.system_id::text, '')))
    or (coalesce(jsonb_array_length(s.filters -> 'topics'), 0) > 0 and not exists (
      select 1 from public.question_topics qt
      where qt.question_id = q.id and (s.filters -> 'topics') ? qt.topic_id::text
    ))
    or (coalesce(jsonb_array_length(s.filters -> 'subtopics'), 0) > 0 and not exists (
      select 1 from public.question_subtopics qs
      where qs.question_id = q.id and (s.filters -> 'subtopics') ? qs.subtopic_id::text
    ))
    or (coalesce(s.filters ->> 'pyq', '') = 'yes' and not q.is_pyq)
    or (nullif(s.filters ->> 'year', '') is not null and q.exam_year is distinct from (s.filters ->> 'year')::integer)
    or (nullif(s.filters ->> 'search', '') is not null and q.question_text not ilike '%' || (s.filters ->> 'search') || '%')
    or (nullif(s.filters ->> 'source', '') is not null and coalesce(q.source_reference, '') not ilike '%' || (s.filters ->> 'source') || '%')
    -- Status membership is intentionally not re-evaluated for historical
    -- sessions: incorrect/bookmarked/marked/recall state can legitimately
    -- change after the immutable session snapshot was created.
),
cerebellum_platform as (
  select id from public.platforms where lower(btrim(name)) = 'cerebellum'
),
anesthesia_subject as (
  select id from public.subjects where lower(btrim(name)) = 'anesthesia'
),
anatomy_subject as (
  select id from public.subjects where lower(btrim(name)) = 'anatomy'
),
cerebellum_anesthesia_topics as (
  select distinct qt.topic_id
  from public.questions q
  join public.question_topics qt on qt.question_id = q.id
  where q.platform_id in (select id from cerebellum_platform)
    and q.subject_id in (select id from anesthesia_subject)
),
cerebellum_anatomy_topics as (
  select distinct qt.topic_id
  from public.questions q
  join public.question_topics qt on qt.question_id = q.id
  where q.platform_id in (select id from cerebellum_platform)
    and q.subject_id in (select id from anatomy_subject)
),
cerebellum_anesthesia_subtopics as (
  select distinct qs.subtopic_id
  from public.questions q
  join public.question_subtopics qs on qs.question_id = q.id
  where q.platform_id in (select id from cerebellum_platform)
    and q.subject_id in (select id from anesthesia_subject)
),
cerebellum_anatomy_subtopics as (
  select distinct qs.subtopic_id
  from public.questions q
  join public.question_subtopics qs on qs.question_id = q.id
  where q.platform_id in (select id from cerebellum_platform)
    and q.subject_id in (select id from anatomy_subject)
),
checks(check_name, failures, detail) as (
  select 'content.imported_question_floor',
         greatest(805 - count(*) filter (where content_origin = 'imported'), 0)::bigint,
         format('%s imported; baseline 805 after verified PrepLadder Anaesthesia pilot', count(*) filter (where content_origin = 'imported'))
  from public.questions

  union all select 'content.usable_question_stems', count(*), format('%s blank stems', count(*))
  from public.questions where nullif(btrim(regexp_replace(question_text, '<[^>]+>', ' ', 'g')), '') is null

  union all select 'options.no_orphans', count(*), format('%s orphan options', count(*))
  from public.question_options o left join public.questions q on q.id = o.question_id where q.id is null

  union all select 'options.expected_structure', count(*), format('%s malformed question option sets', count(*))
  from question_option_stats where not is_hybrid and (option_count < 2 or option_count <> distinct_keys or blank_options > 0 or correct_options <> 1)

  union all select 'options.correct_answer_matches_option', count(*), format('%s answer-key mismatches', count(*))
  from public.questions q where not exists (select 1 from public.qbank_question_payloads p where p.question_id=q.id) and not exists (
    select 1 from public.question_options o
    where o.question_id = q.id
      and upper(btrim(o.option_key)) = upper(left(btrim(coalesce(q.correct_answer, '')), 1))
      and o.is_correct
  )

  union all select 'hybrid.payload_option_structure', count(*), format('%s malformed hybrid payload option sets', count(*))
  from public.qbank_question_payloads p
  where p.option_count < 2 or p.option_count > 8
     or cardinality(p.correct_option_keys) < 1
     or cardinality(p.correct_option_keys) > p.option_count
     or p.is_multi_correct <> (cardinality(p.correct_option_keys) > 1)

  union all select 'hybrid.payload_relationships', count(*), format('%s broken question/payload/object relationships', count(*))
  from public.qbank_question_payloads p
  left join public.questions q on q.id=p.question_id
  left join public.qbank_payload_objects o on o.id=p.payload_object_id
  where q.id is null or o.id is null or o.status <> 'committed'
     or q.platform_id <> p.platform_id or q.subject_id <> p.subject_id

  union all select 'hybrid.source_test_counts', count(*), format('%s source tests differ from declared occurrence counts', count(*))
  from public.qbank_source_tests t
  where t.declared_question_count <> (
    select count(*) from public.qbank_source_occurrences o where o.source_test_id=t.id and o.is_current
  )

  union all select 'hybrid.current_occurrence_positions_unique', count(*), format('%s duplicate current source-test positions', count(*))
  from (
    select source_test_id,question_position from public.qbank_source_occurrences
    where is_current group by source_test_id,question_position having count(*) > 1
  ) duplicates

  union all select 'hybrid.storage_objects_present', count(*), format('%s committed payload records lack matching Storage objects', count(*))
  from public.qbank_payload_objects p
  left join storage.objects o on o.bucket_id=p.bucket_id and o.name=p.object_path
  where p.status='committed' and (o.id is null or coalesce((o.metadata->>'size')::bigint,-1) <> p.stored_bytes)

  union all select 'taxonomy.question_topic_scope', count(*), format('%s platform/subject mismatches', count(*))
  from public.question_topics qt
  join public.questions q on q.id = qt.question_id
  join public.topics t on t.id = qt.topic_id
  join public.platform_subjects ps on ps.id = t.platform_subject_id
  where q.platform_id <> ps.platform_id or q.subject_id <> ps.subject_id

  union all select 'taxonomy.direct_topic_is_linked', count(*), format('%s missing question_topics links', count(*))
  from public.questions q
  where q.topic_id is not null and not exists (
    select 1 from public.question_topics qt where qt.question_id = q.id and qt.topic_id = q.topic_id
  )

  union all select 'taxonomy.subtopic_scope', count(*), format('%s invalid question/subtopic scopes', count(*))
  from public.question_subtopics qs
  join public.questions q on q.id = qs.question_id
  join public.subtopics st on st.id = qs.subtopic_id
  join public.topics t on t.id = st.topic_id
  join public.platform_subjects ps on ps.id = t.platform_subject_id
  where q.platform_id <> ps.platform_id or q.subject_id <> ps.subject_id

  union all select 'taxonomy.subtopic_parent_is_linked', count(*), format('%s subtopic links lack their parent topic link', count(*))
  from public.question_subtopics qs
  join public.subtopics st on st.id = qs.subtopic_id
  where not exists (
    select 1 from public.question_topics qt
    where qt.question_id = qs.question_id and qt.topic_id = st.topic_id
  )

  union all select 'taxonomy.source_subtopics_are_mapped', count(*), format('%s labeled questions lack subtopic links', count(*))
  from public.questions q
  where nullif(btrim(q.source_subtopic_label), '') is not null
    and not exists (select 1 from public.question_subtopics qs where qs.question_id = q.id)

  union all select 'taxonomy.source_label_matches_subtopic', count(*), format('%s labeled questions leak into unrelated subtopics', count(*))
  from public.questions q
  join public.question_subtopics qs on qs.question_id = q.id
  join public.subtopics st on st.id = qs.subtopic_id
  where nullif(btrim(q.source_subtopic_label), '') is not null
    and lower(regexp_replace(st.name, '[^[:alnum:]]', '', 'g'))
        <> lower(regexp_replace(q.source_subtopic_label, '[^[:alnum:]]', '', 'g'))

  union all select 'taxonomy.subtopic_names_unique_per_topic', count(*), format('%s normalized duplicate subtopic names', count(*))
  from (
    select topic_id, lower(regexp_replace(name, '[^[:alnum:]]', '', 'g')) normalized_name
    from public.subtopics group by topic_id, normalized_name having count(*) > 1
  ) duplicates

  union all select 'permutations.cross_subject_subtopic_is_zero', count(*), format('%s questions leak across subject subtopics', count(*))
  from (
    select qs.question_id
    from public.question_subtopics qs
    join public.subtopics st on st.id = qs.subtopic_id
    join public.topics t on t.id = st.topic_id
    join public.platform_subjects ps on ps.id = t.platform_subject_id
    group by qs.question_id having count(distinct ps.subject_id) > 1
  ) leaked

  union all select 'permutations.subtopic_count_consistency', count(*), format('%s subtopic counts disagree with distinct mappings', count(*))
  from (
    select st.id,
      count(qs.question_id) stored_count,
      count(distinct qs.question_id) distinct_count
    from public.subtopics st left join public.question_subtopics qs on qs.subtopic_id = st.id
    group by st.id
  ) counts where stored_count <> distinct_count

  union all select 'regression.cerebellum_subject_context_exists',
    case when (select count(*) from cerebellum_platform) = 1
           and (select count(*) from anesthesia_subject) = 1
           and (select count(*) from anatomy_subject) = 1 then 0 else 1 end,
    'requires one Cerebellum platform and one Anatomy/Anesthesia subject'

  union all select 'regression.cerebellum_anesthesia_anatomy_topic_isolation', count(*), format('%s topic IDs are shared across the two subject populations', count(*))
  from cerebellum_anesthesia_topics anesthesia
  join cerebellum_anatomy_topics anatomy using (topic_id)

  union all select 'regression.cerebellum_anesthesia_anatomy_subtopic_isolation', count(*), format('%s subtopic IDs are shared across the two subject populations', count(*))
  from cerebellum_anesthesia_subtopics anesthesia
  join cerebellum_anatomy_subtopics anatomy using (subtopic_id)

  union all select 'sessions.filter_invariants', failures, format('%s stored questions violate session filters', failures)
  from session_filter_violations

  union all select 'sessions.no_duplicate_questions', count(*), format('%s sessions contain duplicate question IDs', count(*))
  from session_rollup where stored_count <> distinct_count

  union all select 'sessions.contiguous_order', count(*), format('%s sessions have non-contiguous positions', count(*))
  from session_rollup where stored_count > 0 and max_position - min_position + 1 <> stored_count

  union all select 'sessions.count_matches_snapshot', count(*), format('%s session totals differ from stored rows', count(*))
  from session_rollup where total_questions <> stored_count

  union all select 'sessions.usable_snapshots', count(*), format('%s unusable snapshots', count(*))
  from public.test_session_questions sq
  where nullif(btrim(regexp_replace(coalesce(sq.question_snapshot ->> 'question_text', ''), '<[^>]+>', ' ', 'g')), '') is null
     or jsonb_typeof(sq.question_snapshot -> 'options') <> 'array'
     or jsonb_array_length(sq.question_snapshot -> 'options') < 2

  union all select 'sessions.answers_belong_to_snapshot', count(*), format('%s answers are outside their session question set', count(*))
  from public.test_answers a where not exists (
    select 1 from public.test_session_questions sq where sq.session_id = a.session_id and sq.question_id = a.question_id
  )

  union all select 'review.incorrect_population', count(*), format('%s incorrect-state rows disagree with latest attempt', count(*))
  from public.user_question_state u
  join latest_attempt a using (user_id, question_id)
  where u.last_is_correct is not null and u.last_is_correct is distinct from a.is_correct

  union all select 'review.bookmarked_population', count(*), format('%s canonical bookmarks reference missing questions', count(*))
  from public.user_question_state u
  left join public.questions q on q.id = u.question_id
  where u.bookmarked and q.id is null

  union all select 'review.marked_population', count(*), format('%s legacy/current marked flags disagree', count(*))
  from public.user_question_state where revision is distinct from marked_for_review

  union all select 'review.slow_population_over_50s', count(*), format('%s latest timing values disagree', count(*))
  from public.user_question_state u
  join latest_attempt a using (user_id, question_id)
  where a.time_spent_seconds is not null and u.last_time_seconds is distinct from a.time_spent_seconds

  union all select 'analytics.attempt_population_has_questions', count(*), format('%s attempts reference missing questions', count(*))
  from public.question_attempts a left join public.questions q on q.id = a.question_id where q.id is null

  union all select 'analytics.drilldown_population_reproducible', count(*), format('%s aggregate groups fail population reproduction', count(*))
  from (
    select q.platform_id, q.subject_id, count(*) as metric_population,
           (select count(*)
            from public.question_attempts drilldown
            join public.questions dq on dq.id = drilldown.question_id
            where dq.platform_id = q.platform_id and dq.subject_id = q.subject_id) as drilldown_population
    from public.question_attempts a
    join public.questions q on q.id = a.question_id
    group by q.platform_id, q.subject_id
  ) populations
  where metric_population <> drilldown_population

  union all select 'analytics.unique_attempted_reconciles',
    case when (select count(*) from latest_attempt) = (select count(*) from (select distinct user_id, question_id from public.question_attempts) x) then 0 else 1 end,
    format('%s latest rows; %s unique attempted', (select count(*) from latest_attempt), (select count(*) from (select distinct user_id, question_id from public.question_attempts) x))

  union all select 'analytics.total_attempts_reconciles',
    case when (select count(*) from public.question_attempts) = (select coalesce(sum(attempts), 0) from (select count(*) attempts from public.question_attempts group by user_id, question_id) x) then 0 else 1 end,
    format('%s total attempts', (select count(*) from public.question_attempts))

  union all select 'analytics.latest_correct_incorrect_partition', count(*), format('%s latest answers are neither correct nor incorrect', count(*))
  from latest_attempt where is_correct is null

  union all select 'analytics.platform_breakdown_reconciles',
    case when (select count(*) from public.questions where platform_id is not null) = (select coalesce(sum(question_count), 0) from (select platform_id, count(*) question_count from public.questions where platform_id is not null group by platform_id) x) then 0 else 1 end,
    'platform group counts must partition the mapped question population'

  union all select 'analytics.subject_breakdown_reconciles',
    case when (select count(*) from public.questions where subject_id is not null) = (select coalesce(sum(question_count), 0) from (select subject_id, count(*) question_count from public.questions where subject_id is not null group by subject_id) x) then 0 else 1 end,
    'subject group counts must partition the mapped question population'

  union all select 'analytics.topic_breakdown_reconciles',
    case when (select count(*) from public.question_topics) = (select coalesce(sum(question_count), 0) from (select topic_id, count(distinct question_id) question_count from public.question_topics group by topic_id) x) then 0 else 1 end,
    'topic group counts must reproduce distinct question-topic mappings'

  union all select 'analytics.subtopic_breakdown_reconciles',
    case when (select count(*) from public.question_subtopics) = (select coalesce(sum(question_count), 0) from (select subtopic_id, count(distinct question_id) question_count from public.question_subtopics group by subtopic_id) x) then 0 else 1 end,
    'subtopic group counts must reproduce distinct question-subtopic mappings'

  union all select 'personal.content_separation', count(*), format('%s personal/import ownership violations', count(*))
  from public.questions q
  where (q.content_origin = 'user' and q.created_by is null)
     or (q.content_origin = 'imported' and q.created_by is not null)

  union all select 'schema.canonical_learning_state',
    case when to_regclass('public.user_question_state') is not null and to_regclass('public.question_learning_state') is null then 0 else 1 end,
    'user_question_state must be canonical'

  union all select 'schema.frontend_session_contract', count(*),
    format('%s expected live columns missing', count(*))
  from (values ('total_questions'), ('total_correct'), ('total_time_seconds')) expected(column_name)
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'test_sessions' and c.column_name = expected.column_name
  )
)
select case when failures = 0 then 'PASS' else 'FAIL' end as status,
       check_name,
       detail
from checks
order by status desc, check_name;
