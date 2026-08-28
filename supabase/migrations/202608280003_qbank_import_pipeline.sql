-- Permanent QBank HTML import foundation.
-- Additive only. This file is intentionally NOT applied by the importer.
-- The public RPC is service-role-only and one invocation is one transaction.

select pg_advisory_xact_lock(hashtextextended('qbank:202608280003:import-pipeline', 0));

do $$
declare v_problem text;
begin
  with required(table_name, column_name) as (
    values
      ('platforms', 'id'), ('platforms', 'name'),
      ('subjects', 'id'), ('subjects', 'name'),
      ('platform_subjects', 'id'), ('platform_subjects', 'platform_id'), ('platform_subjects', 'subject_id'),
      ('questions', 'id'), ('questions', 'platform_id'), ('questions', 'subject_id'),
      ('questions', 'question_text'), ('questions', 'correct_answer'),
      ('question_options', 'question_id'), ('question_options', 'option_key'), ('question_options', 'option_text'),
      ('topics', 'id'), ('topics', 'platform_subject_id'),
      ('subtopics', 'id'), ('subtopics', 'topic_id'),
      ('question_topics', 'question_id'), ('question_topics', 'topic_id'),
      ('question_subtopics', 'question_id'), ('question_subtopics', 'subtopic_id')
  )
  select string_agg(format('%I.%I', r.table_name, r.column_name), ', ')
  into v_problem
  from required r
  left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = r.table_name and c.column_name = r.column_name
  where c.column_name is null;

  if v_problem is not null then
    raise exception 'QBank importer migration stopped; missing live columns: %', v_problem;
  end if;
end $$;

alter table public.questions
  add column if not exists source_identity text,
  add column if not exists source_fingerprint text,
  add column if not exists content_fingerprint text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.questions'::regclass
      and conname = 'questions_source_fingerprint_format'
  ) then
    alter table public.questions add constraint questions_source_fingerprint_format
      check (source_fingerprint is null or source_fingerprint ~ '^[0-9a-f]{64}$') not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.questions'::regclass
      and conname = 'questions_content_fingerprint_format'
  ) then
    alter table public.questions add constraint questions_content_fingerprint_format
      check (content_fingerprint is null or content_fingerprint ~ '^[0-9a-f]{64}$') not valid;
  end if;
end $$;

alter table public.questions validate constraint questions_source_fingerprint_format;
alter table public.questions validate constraint questions_content_fingerprint_format;

create unique index if not exists questions_source_fingerprint_uidx
  on public.questions (source_fingerprint)
  where source_fingerprint is not null;

create index if not exists questions_content_fingerprint_idx
  on public.questions (content_fingerprint)
  where content_fingerprint is not null;

create unique index if not exists question_options_question_key_uidx
  on public.question_options (question_id, option_key);

create table if not exists public.qbank_import_runs (
  id uuid primary key default gen_random_uuid(),
  imported_at timestamptz not null default now(),
  source_filename text not null check (char_length(btrim(source_filename)) between 1 and 1000),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  platform text,
  subject text,
  parsed_count integer not null check (parsed_count >= 0),
  inserted_count integer not null check (inserted_count >= 0),
  duplicate_count integer not null check (duplicate_count >= 0),
  possible_duplicate_count integer not null check (possible_duplicate_count >= 0),
  invalid_count integer not null check (invalid_count >= 0),
  conflict_count integer not null check (conflict_count >= 0),
  question_count_before bigint not null check (question_count_before >= 0),
  question_count_after bigint not null check (question_count_after >= question_count_before),
  option_count_before bigint not null check (option_count_before >= 0),
  option_count_after bigint not null check (option_count_after >= option_count_before),
  topics_created integer not null default 0 check (topics_created >= 0),
  topics_reused integer not null default 0 check (topics_reused >= 0),
  subtopics_created integer not null default 0 check (subtopics_created >= 0),
  subtopics_reused integer not null default 0 check (subtopics_reused >= 0),
  mappings_created integer not null default 0 check (mappings_created >= 0),
  validation_result text not null check (validation_result in ('PASS', 'FAIL')),
  validation_details jsonb not null default '{}'::jsonb,
  importer_version text not null,
  git_commit text,
  unique (source_sha256, imported_at)
);

alter table public.qbank_import_runs enable row level security;
revoke all on table public.qbank_import_runs from public, anon, authenticated;
grant select, insert on table public.qbank_import_runs to service_role;

create index if not exists qbank_import_runs_source_date_idx
  on public.qbank_import_runs (source_sha256, imported_at desc);

create or replace function public.qbank_import_batch(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_manifest jsonb := coalesce(p_payload -> 'manifest', '{}'::jsonb);
  v_rows jsonb := coalesce(p_payload -> 'questions', '[]'::jsonb);
  v_row jsonb;
  v_platform_id uuid;
  v_subject_id uuid;
  v_platform_subject_id uuid;
  v_system_id uuid;
  v_topic_id uuid;
  v_subtopic_id uuid;
  v_question_id uuid;
  v_existing record;
  v_option jsonb;
  v_ordinality bigint;
  v_questions_before bigint;
  v_options_before bigint;
  v_questions_after bigint;
  v_options_after bigint;
  v_inserted integer := 0;
  v_inserted_options integer := 0;
  v_skipped integer := 0;
  v_topics_created integer := 0;
  v_topics_reused integer := 0;
  v_subtopics_created integer := 0;
  v_subtopics_reused integer := 0;
  v_mappings_created integer := 0;
  v_protected_before jsonb;
  v_protected_after jsonb;
  v_run_id uuid;
  v_normalized text;
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'qbank_import_batch is restricted to trusted import operators';
  end if;
  if jsonb_typeof(v_rows) <> 'array' then
    raise exception 'questions must be a JSON array';
  end if;
  if coalesce((v_manifest ->> 'possible_duplicate_count')::integer, 0) <> 0
     or coalesce((v_manifest ->> 'invalid_count')::integer, 0) <> 0
     or coalesce((v_manifest ->> 'conflict_count')::integer, 0) <> 0 then
    raise exception 'import refused: possible duplicates, invalid rows, or conflicts remain';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('qbank:html-import', 0));
  set constraints all immediate;

  select count(*) into v_questions_before from public.questions;
  select count(*) into v_options_before from public.question_options;
  select jsonb_build_object(
    'attempts', (select count(*) from public.question_attempts),
    'bookmarks', (select count(*) from public.user_question_state where bookmarked),
    'marked', (select count(*) from public.user_question_state where marked_for_review),
    'learning_rows', (select count(*) from public.user_question_state),
    'sessions', (select count(*) from public.test_sessions),
    'session_questions', (select count(*) from public.test_session_questions)
  ) into v_protected_before;

  for v_row in select value from jsonb_array_elements(v_rows)
  loop
    if nullif(btrim(v_row ->> 'source_fingerprint'), '') is null
       or (v_row ->> 'source_fingerprint') !~ '^[0-9a-f]{64}$'
       or nullif(btrim(v_row ->> 'content_fingerprint'), '') is null
       or (v_row ->> 'content_fingerprint') !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid source/content fingerprint at source identity %', v_row ->> 'source_identity';
    end if;
    if nullif(btrim(v_row ->> 'question_text'), '') is null then
      raise exception 'empty question stem at source identity %', v_row ->> 'source_identity';
    end if;
    if jsonb_typeof(v_row -> 'options') <> 'array'
       or jsonb_array_length(v_row -> 'options') not between 2 and 8 then
      raise exception 'invalid option count at source identity %', v_row ->> 'source_identity';
    end if;
    if not exists (
      select 1 from jsonb_array_elements(v_row -> 'options') o
      where upper(o ->> 'key') = upper(v_row ->> 'correct_answer')
    ) then
      raise exception 'correct answer has no option at source identity %', v_row ->> 'source_identity';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_row -> 'options') o
      group by upper(o ->> 'key') having count(*) <> 1
    ) then
      raise exception 'duplicate option key at source identity %', v_row ->> 'source_identity';
    end if;
    if nullif(btrim(v_row ->> 'subtopic'), '') is not null
       and nullif(btrim(v_row ->> 'topic'), '') is null then
      raise exception 'subtopic without topic at source identity %', v_row ->> 'source_identity';
    end if;

    select q.id, q.content_fingerprint into v_existing
    from public.questions q
    where q.source_fingerprint = v_row ->> 'source_fingerprint';
    if found then
      if v_existing.content_fingerprint is distinct from (v_row ->> 'content_fingerprint') then
        raise exception 'identity conflict appeared during import for %', v_row ->> 'source_identity';
      end if;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_normalized := lower(regexp_replace(v_row ->> 'platform', '[^[:alnum:]]', '', 'g'));
    select (array_agg(p.id order by p.id))[1], count(*)
      into v_platform_id, v_ordinality
    from public.platforms p
    where lower(regexp_replace(p.name, '[^[:alnum:]]', '', 'g')) = v_normalized;
    if v_ordinality <> 1 then
      raise exception 'platform must resolve exactly once: %', v_row ->> 'platform';
    end if;

    v_normalized := lower(regexp_replace(v_row ->> 'subject', '[^[:alnum:]]', '', 'g'));
    select (array_agg(s.id order by s.id))[1], count(*)
      into v_subject_id, v_ordinality
    from public.subjects s
    where lower(regexp_replace(s.name, '[^[:alnum:]]', '', 'g')) = v_normalized;
    if v_ordinality <> 1 then
      raise exception 'subject must resolve exactly once: %', v_row ->> 'subject';
    end if;

    select ps.id into strict v_platform_subject_id
    from public.platform_subjects ps
    where ps.platform_id = v_platform_id and ps.subject_id = v_subject_id;

    v_system_id := null;
    if nullif(btrim(v_row ->> 'system'), '') is not null then
      v_normalized := lower(regexp_replace(v_row ->> 'system', '[^[:alnum:]]', '', 'g'));
      select (array_agg(s.id order by s.created_at, s.id))[1] into v_system_id
      from public.systems s
      where s.platform_subject_id = v_platform_subject_id
        and lower(regexp_replace(s.name, '[^[:alnum:]]', '', 'g')) = v_normalized;
      if v_system_id is null then
        insert into public.systems (platform_subject_id, name)
        values (v_platform_subject_id, btrim(v_row ->> 'system')) returning id into v_system_id;
      end if;
    end if;

    v_topic_id := null;
    if nullif(btrim(v_row ->> 'topic'), '') is not null then
      v_normalized := lower(regexp_replace(v_row ->> 'topic', '[^[:alnum:]]', '', 'g'));
      select (array_agg(t.id order by t.created_at, t.id))[1] into v_topic_id
      from public.topics t
      where t.platform_subject_id = v_platform_subject_id
        and t.system_id is not distinct from v_system_id
        and lower(regexp_replace(t.name, '[^[:alnum:]]', '', 'g')) = v_normalized;
      if v_topic_id is null then
        insert into public.topics (platform_subject_id, system_id, name)
        values (v_platform_subject_id, v_system_id, btrim(v_row ->> 'topic')) returning id into v_topic_id;
        v_topics_created := v_topics_created + 1;
      else
        v_topics_reused := v_topics_reused + 1;
      end if;
    end if;

    v_subtopic_id := null;
    if nullif(btrim(v_row ->> 'subtopic'), '') is not null then
      v_normalized := lower(regexp_replace(v_row ->> 'subtopic', '[^[:alnum:]]', '', 'g'));
      select (array_agg(st.id order by st.created_at, st.id))[1] into v_subtopic_id
      from public.subtopics st
      where st.topic_id = v_topic_id
        and lower(regexp_replace(st.name, '[^[:alnum:]]', '', 'g')) = v_normalized;
      if v_subtopic_id is null then
        insert into public.subtopics (topic_id, name)
        values (v_topic_id, btrim(v_row ->> 'subtopic')) returning id into v_subtopic_id;
        v_subtopics_created := v_subtopics_created + 1;
      else
        v_subtopics_reused := v_subtopics_reused + 1;
      end if;
    end if;

    insert into public.questions (
      platform_id, subject_id, system_id, topic_id,
      source_question_id, source_reference, source_collection,
      source_test_label, source_subtopic_label,
      source_identity, source_fingerprint, content_fingerprint,
      question_text, options, correct_answer, explanation_html,
      question_images, exam_year, exam_shift, is_pyq,
      content_origin, status
    ) values (
      v_platform_id, v_subject_id, v_system_id, v_topic_id,
      nullif(btrim(v_row ->> 'source_question_id'), ''), nullif(btrim(v_row ->> 'source_reference'), ''), nullif(btrim(v_row ->> 'source_collection'), ''),
      nullif(btrim(v_row ->> 'source_test_label'), ''), nullif(btrim(v_row ->> 'subtopic'), ''),
      v_row ->> 'source_identity', v_row ->> 'source_fingerprint', v_row ->> 'content_fingerprint',
      v_row ->> 'question_text', v_row -> 'options', upper(v_row ->> 'correct_answer'), v_row ->> 'explanation_html',
      coalesce(v_row -> 'question_images', '[]'::jsonb), nullif(v_row ->> 'exam_year', '')::integer,
      nullif(btrim(v_row ->> 'exam_shift'), ''), coalesce((v_row ->> 'is_pyq')::boolean, false),
      'imported', 'published'
    ) returning id into v_question_id;

    for v_option, v_ordinality in
      select value, ordinality from jsonb_array_elements(v_row -> 'options') with ordinality
    loop
      insert into public.question_options (question_id, option_key, option_text, is_correct, sort_order)
      values (
        v_question_id, upper(v_option ->> 'key'), coalesce(nullif(v_option ->> 'html', ''), v_option ->> 'text'),
        upper(v_option ->> 'key') = upper(v_row ->> 'correct_answer'), (v_ordinality - 1)::integer
      );
      v_inserted_options := v_inserted_options + 1;
    end loop;

    if v_topic_id is not null then
      insert into public.question_topics (question_id, topic_id)
      values (v_question_id, v_topic_id) on conflict do nothing;
      v_mappings_created := v_mappings_created + 1;
    end if;
    if v_subtopic_id is not null then
      insert into public.question_subtopics (question_id, subtopic_id)
      values (v_question_id, v_subtopic_id) on conflict do nothing;
      v_mappings_created := v_mappings_created + 1;
    end if;
    v_inserted := v_inserted + 1;
  end loop;

  select count(*) into v_questions_after from public.questions;
  select count(*) into v_options_after from public.question_options;
  if v_questions_after <> v_questions_before + v_inserted then
    raise exception 'question count invariant failed: % + % <> %', v_questions_before, v_inserted, v_questions_after;
  end if;
  if v_options_after <> v_options_before + v_inserted_options then
    raise exception 'option count invariant failed: % + % <> %', v_options_before, v_inserted_options, v_options_after;
  end if;

  if exists (
    select 1
    from public.questions q
    left join public.question_options o on o.question_id = q.id
    where q.source_fingerprint in (select value ->> 'source_fingerprint' from jsonb_array_elements(v_rows))
    group by q.id
    having nullif(btrim(max(q.question_text)), '') is null
       or count(o.id) not between 2 and 8
       or count(*) filter (where o.is_correct) <> 1
       or bool_or(upper(o.option_key) = upper(q.correct_answer)) is not true
  ) then
    raise exception 'post-import question/option structural validation failed';
  end if;

  if exists (
    select 1
    from public.questions q
    join public.question_subtopics qs on qs.question_id = q.id
    join public.subtopics st on st.id = qs.subtopic_id
    where q.source_fingerprint in (select value ->> 'source_fingerprint' from jsonb_array_elements(v_rows))
      and not exists (
        select 1 from public.question_topics qt
        where qt.question_id = q.id and qt.topic_id = st.topic_id
      )
  ) then
    raise exception 'post-import topic/subtopic mapping validation failed';
  end if;

  select jsonb_build_object(
    'attempts', (select count(*) from public.question_attempts),
    'bookmarks', (select count(*) from public.user_question_state where bookmarked),
    'marked', (select count(*) from public.user_question_state where marked_for_review),
    'learning_rows', (select count(*) from public.user_question_state),
    'sessions', (select count(*) from public.test_sessions),
    'session_questions', (select count(*) from public.test_session_questions)
  ) into v_protected_after;
  if v_protected_after is distinct from v_protected_before then
    raise exception 'protected learner state changed during import';
  end if;

  insert into public.qbank_import_runs (
    source_filename, source_sha256, platform, subject,
    parsed_count, inserted_count, duplicate_count, possible_duplicate_count, invalid_count, conflict_count,
    question_count_before, question_count_after, option_count_before, option_count_after,
    topics_created, topics_reused, subtopics_created, subtopics_reused, mappings_created,
    validation_result, validation_details, importer_version, git_commit
  ) values (
    v_manifest ->> 'source_filename', v_manifest ->> 'source_sha256', v_manifest ->> 'platform', v_manifest ->> 'subject',
    coalesce((v_manifest ->> 'parsed_count')::integer, jsonb_array_length(v_rows)), v_inserted,
    coalesce((v_manifest ->> 'duplicate_count')::integer, 0) + v_skipped,
    coalesce((v_manifest ->> 'possible_duplicate_count')::integer, 0),
    coalesce((v_manifest ->> 'invalid_count')::integer, 0), coalesce((v_manifest ->> 'conflict_count')::integer, 0),
    v_questions_before, v_questions_after, v_options_before, v_options_after,
    v_topics_created, v_topics_reused, v_subtopics_created, v_subtopics_reused, v_mappings_created,
    'PASS', jsonb_build_object('database_integrity', 'PASS', 'taxonomy', 'PASS', 'protected_study_state', 'PASS'),
    coalesce(v_manifest ->> 'importer_version', 'unknown'), v_manifest ->> 'git_commit'
  ) returning id into v_run_id;

  return jsonb_build_object(
    'status', 'PASS', 'import_run_id', v_run_id,
    'questions_before', v_questions_before, 'questions_after', v_questions_after,
    'options_before', v_options_before, 'options_after', v_options_after,
    'inserted', v_inserted, 'existing_skipped', v_skipped,
    'topics_created', v_topics_created, 'topics_reused', v_topics_reused,
    'subtopics_created', v_subtopics_created, 'subtopics_reused', v_subtopics_reused,
    'mappings_created', v_mappings_created
  );
end;
$$;

revoke all on function public.qbank_import_batch(jsonb) from public, anon, authenticated;
grant execute on function public.qbank_import_batch(jsonb) to service_role;
