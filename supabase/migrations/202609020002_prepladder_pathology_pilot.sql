-- Extend the proven hybrid importer to the Pathology pilot only.
-- Existing Anaesthesia content and all study-state tables remain untouched.

create unique index if not exists subjects_one_pathology_alias
  on public.subjects ((case when lower(btrim(name))='pathology' then true end));

create or replace function public.qbank_begin_prepladder_import(p_manifest jsonb)
returns uuid
language plpgsql
security invoker
set search_path=public,pg_temp
as $function$
declare run_id uuid;
begin
  if current_user <> 'service_role' then
    raise exception 'trusted import role required';
  end if;
  if p_manifest->>'platform' <> 'PrepLadder'
     or p_manifest->>'subject' not in ('Anaesthesia','Pathology') then
    raise exception 'pilot scope is restricted to PrepLadder Anaesthesia or Pathology';
  end if;
  if coalesce((p_manifest->>'source_bytes')::bigint,0) <= 0
     or coalesce(p_manifest->>'source_sha256','') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid source manifest';
  end if;
  insert into public.qbank_hybrid_import_runs(
    source_filename,source_sha256,source_bytes,platform,subject,
    parser_version,schema_version,source_test_count,occurrence_count,
    content_version_count,payload_object_count,payload_stored_bytes,status
  ) values (
    p_manifest->>'source_filename',p_manifest->>'source_sha256',(p_manifest->>'source_bytes')::bigint,
    p_manifest->>'platform',p_manifest->>'subject',p_manifest->>'importer_version',
    (p_manifest->>'schema_version')::integer,(p_manifest->>'source_test_count')::integer,
    (p_manifest->>'occurrence_count')::integer,(p_manifest->>'content_version_count')::integer,
    (p_manifest->>'payload_object_count')::integer,(p_manifest->>'payload_stored_bytes')::bigint,'pending'
  )
  on conflict(source_sha256,platform,subject,parser_version,schema_version)
  do update set error_detail=null
  returning id into run_id;
  return run_id;
end
$function$;

create or replace function public.qbank_commit_prepladder_import(p_manifest jsonb)
returns jsonb
language plpgsql
security invoker
set search_path=public,pg_temp
as $function$
declare
  v_run_id uuid; v_platform_id uuid; v_subject_id uuid; v_platform_subject_id uuid;
  v_subject text := p_manifest->>'subject';
  row jsonb; existing jsonb; questions_before bigint; options_before bigint;
  attempts_before bigint; sessions_before bigint; state_before bigint;
begin
  if current_user <> 'service_role' then raise exception 'trusted import role required'; end if;
  if p_manifest->>'platform' <> 'PrepLadder' or v_subject not in ('Anaesthesia','Pathology') then
    raise exception 'pilot scope is restricted to PrepLadder Anaesthesia or Pathology';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('prepladder-import:' || v_subject,0));

  select r.id into v_run_id from public.qbank_hybrid_import_runs r
  where source_sha256=p_manifest->>'source_sha256' and platform='PrepLadder' and subject=v_subject
    and parser_version=p_manifest->>'importer_version' and schema_version=(p_manifest->>'schema_version')::integer;
  if v_run_id is null then raise exception 'pending import run not found'; end if;
  if (select status from public.qbank_hybrid_import_runs where id=v_run_id)='committed' then
    return jsonb_build_object('status','already_committed','run_id',v_run_id);
  end if;
  if jsonb_array_length(p_manifest->'source_tests') <> (p_manifest->>'source_test_count')::integer
    or jsonb_array_length(p_manifest->'versions') <> (p_manifest->>'content_version_count')::integer
    or jsonb_array_length(p_manifest->'occurrences') <> (p_manifest->>'occurrence_count')::integer
    or jsonb_array_length(p_manifest->'objects') <> (p_manifest->>'payload_object_count')::integer then
    raise exception 'manifest count mismatch';
  end if;

  select count(*) into questions_before from public.questions;
  select count(*) into options_before from public.question_options;
  select count(*) into attempts_before from public.question_attempts;
  select count(*) into sessions_before from public.test_sessions;
  select count(*) into state_before from public.user_question_state;

  select p.id into v_platform_id from public.platforms p where lower(btrim(p.name))='prepladder';
  if v_platform_id is null then
    insert into public.platforms(name,code) values('PrepLadder','PREP') returning id into v_platform_id;
  end if;

  if v_subject='Anaesthesia' then
    select s.id into v_subject_id from public.subjects s
    where lower(btrim(s.name)) in ('anaesthesia','anesthesia','anaesthesiology','anesthesiology','anasthesia')
    order by case when lower(btrim(s.name))='anaesthesia' then 0 else 1 end limit 1;
    if v_subject_id is null then raise exception 'existing Anaesthesia subject not found'; end if;
  else
    select s.id into v_subject_id from public.subjects s where lower(btrim(s.name))='pathology' limit 1;
    if v_subject_id is null then
      insert into public.subjects(name) values('Pathology') returning id into v_subject_id;
    end if;
  end if;

  select ps.id into v_platform_subject_id from public.platform_subjects ps
  where ps.platform_id=v_platform_id and ps.subject_id=v_subject_id;
  if v_platform_subject_id is null then
    insert into public.platform_subjects(platform_id,subject_id,native_label)
    values(v_platform_id,v_subject_id,v_subject) returning id into v_platform_subject_id;
  end if;

  for row in select value from jsonb_array_elements(p_manifest->'source_tests') loop
    if coalesce(row->'source_path'->>0,'') <> v_subject then
      raise exception 'source test subject isolation failed: %',row->>'source_test_id';
    end if;
    select to_jsonb(t) into existing from public.qbank_source_tests t where t.stable_key=row->>'stable_key';
    if existing is not null and (
      existing->>'source_test_id' <> row->>'source_test_id'
      or existing->>'title' <> row->>'title'
      or existing->>'subject_id' <> v_subject_id::text
    ) then
      raise exception 'source test identity conflict: %',row->>'source_test_id';
    end if;
    insert into public.qbank_source_tests(
      id,platform_id,subject_id,stable_key,source_test_id,title,sequence,numeric_prefix,
      declared_question_count,total_marks,duration_minutes,time_per_question_seconds,is_pyq,build_id,source_path
    ) values (
      (row->>'id')::uuid,v_platform_id,v_subject_id,row->>'stable_key',row->>'source_test_id',row->>'title',
      (row->>'sequence')::integer,nullif(row->>'numeric_prefix','')::integer,(row->>'declared_question_count')::integer,
      nullif(row->>'total_marks','')::numeric,nullif(row->>'duration_minutes','')::numeric,
      nullif(row->>'time_per_question_seconds','')::numeric,coalesce((row->>'is_pyq')::boolean,false),
      nullif(row->>'build_id',''),coalesce(row->'source_path','[]'::jsonb)
    ) on conflict(stable_key) do nothing;
  end loop;

  for row in select value from jsonb_array_elements(p_manifest->'objects') loop
    insert into public.qbank_payload_objects(
      id,import_run_id,source_test_id,object_path,sha256,uncompressed_sha256,
      raw_bytes,stored_bytes,question_count,compression,status
    ) values (
      (row->>'id')::uuid,v_run_id,(row->>'source_test_id')::uuid,row->>'object_path',row->>'sha256',
      row->>'uncompressed_sha256',(row->>'raw_bytes')::bigint,(row->>'stored_bytes')::bigint,
      (row->>'question_count')::integer,row->>'compression','staged'
    ) on conflict(object_path) do nothing;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(p_manifest->'objects') manifest_object
    left join storage.objects stored on stored.bucket_id='qbank-payloads'
      and stored.name=manifest_object->>'object_path'
    where stored.id is null
       or coalesce((stored.metadata->>'size')::bigint,-1)<>(manifest_object->>'stored_bytes')::bigint
  ) then raise exception 'payload object is missing or its stored byte count differs from the manifest'; end if;

  for row in select value from jsonb_array_elements(p_manifest->'versions') loop
    insert into public.questions(
      id,platform_id,subject_id,source_question_id,question_text,options,correct_answer,
      explanation_html,question_images,explanation_images,source_test_label,
      source_collection,source_type,is_pyq,content_origin,status,is_usable,unusable_reason
    ) values (
      (row->>'question_id')::uuid,v_platform_id,v_subject_id,
      (row->>'source_question_id') || '@' || left(row->>'content_sha256',12),row->>'stem_excerpt',
      '[]'::jsonb,array_to_string(array(select jsonb_array_elements_text(row->'correct_option_keys')),','),
      null,'[]'::jsonb,'[]'::jsonb,row->>'first_source_test_title','PrepLadder ' || v_subject,
      'prepladder_hybrid',coalesce((row->>'is_pyq')::boolean,false),'imported','published',
      coalesce((row->>'is_usable')::boolean,true),nullif(row->>'unusable_reason','')
    ) on conflict(id) do nothing;
    insert into public.qbank_question_payloads(
      question_id,platform_id,subject_id,content_sha256,source_question_id,payload_object_id,payload_index,
      correct_option_keys,option_count,is_multi_correct,media_status,has_question_media,
      has_explanation_media,has_audio,has_video
    ) values (
      (row->>'question_id')::uuid,v_platform_id,v_subject_id,row->>'content_sha256',row->>'source_question_id',
      (row->>'payload_object_id')::uuid,(row->>'payload_index')::integer,
      array(select jsonb_array_elements_text(row->'correct_option_keys')),(row->>'option_count')::integer,
      (row->>'is_multi_correct')::boolean,row->>'media_status',(row->>'has_question_media')::boolean,
      (row->>'has_explanation_media')::boolean,(row->>'has_audio')::boolean,(row->>'has_video')::boolean
    ) on conflict(question_id) do nothing;
    update public.questions set is_pyq=is_pyq or coalesce((row->>'is_pyq')::boolean,false)
      where id=(row->>'question_id')::uuid;
  end loop;

  for row in select value from jsonb_array_elements(p_manifest->'occurrences') loop
    update public.qbank_source_occurrences set is_current=false
      where source_test_id=(row->>'source_test_id')::uuid
        and question_position=(row->>'question_position')::integer
        and content_sha256<>(row->>'content_sha256') and is_current;
    insert into public.qbank_source_occurrences(
      id,occurrence_key,import_run_id,source_test_id,question_id,source_question_id,
      question_position,content_sha256,is_pyq,is_current
    ) values (
      (row->>'id')::uuid,row->>'occurrence_key',v_run_id,(row->>'source_test_id')::uuid,
      (row->>'question_id')::uuid,row->>'source_question_id',(row->>'question_position')::integer,
      row->>'content_sha256',coalesce((row->>'is_pyq')::boolean,false),true
    ) on conflict(occurrence_key) do update set is_current=true;
  end loop;

  if exists (
    select 1 from public.qbank_source_tests t
    where t.platform_id=v_platform_id and t.subject_id=v_subject_id
      and (select count(*) from public.qbank_source_occurrences o where o.source_test_id=t.id and o.is_current) <> t.declared_question_count
  ) then raise exception 'source-test occurrence count invariant failed'; end if;
  if exists (
    select 1 from public.qbank_question_payloads p
    left join public.qbank_payload_objects o on o.id=p.payload_object_id
    where p.platform_id=v_platform_id and p.subject_id=v_subject_id and o.id is null
  ) then raise exception 'payload relationship invariant failed'; end if;
  if (select count(*) from public.question_options) <> options_before
    or (select count(*) from public.question_attempts) <> attempts_before
    or (select count(*) from public.test_sessions) <> sessions_before
    or (select count(*) from public.user_question_state) <> state_before then
    raise exception 'protected existing data changed during import';
  end if;

  update public.qbank_payload_objects set status='committed' where import_run_id=v_run_id;
  update public.qbank_hybrid_import_runs set status='committed',committed_at=now(),error_detail=null where id=v_run_id;
  return jsonb_build_object(
    'status','committed','run_id',v_run_id,'questions_before',questions_before,
    'questions_after',(select count(*) from public.questions),'options_before',options_before,
    'options_after',(select count(*) from public.question_options),
    'versions',(select count(*) from public.qbank_question_payloads p where p.platform_id=v_platform_id and p.subject_id=v_subject_id),
    'usable_versions',(select count(*) from public.qbank_question_payloads p join public.questions q on q.id=p.question_id where p.platform_id=v_platform_id and p.subject_id=v_subject_id and q.is_usable),
    'quarantined_versions',(select count(*) from public.qbank_question_payloads p join public.questions q on q.id=p.question_id where p.platform_id=v_platform_id and p.subject_id=v_subject_id and not q.is_usable),
    'occurrences',(select count(*) from public.qbank_source_occurrences o join public.qbank_source_tests t on t.id=o.source_test_id where t.platform_id=v_platform_id and t.subject_id=v_subject_id and o.is_current)
  );
end
$function$;

revoke all on function public.qbank_begin_prepladder_import(jsonb) from public,anon,authenticated;
revoke all on function public.qbank_commit_prepladder_import(jsonb) from public,anon,authenticated;
grant execute on function public.qbank_begin_prepladder_import(jsonb) to service_role;
grant execute on function public.qbank_commit_prepladder_import(jsonb) to service_role;
