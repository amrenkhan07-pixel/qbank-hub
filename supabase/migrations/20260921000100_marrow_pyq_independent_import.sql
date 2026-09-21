-- Independent Marrow PYQ import, rollback ownership, and bounded PYQ catalog.
-- Additive only. No learner, PrepLadder, taxonomy, or canonical rows are mutated.

begin;
set local lock_timeout = '8s';

create table if not exists public.qbank_import_batch_records (
  batch_id text not null,
  entity_type text not null check (entity_type in (
    'import_run','source_test','payload_object','question','question_payload','source_occurrence','review_metadata'
  )),
  entity_key text not null,
  import_run_id uuid references public.qbank_hybrid_import_runs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (batch_id, entity_type, entity_key)
);

create index if not exists qbank_import_batch_records_run_idx
  on public.qbank_import_batch_records(import_run_id) where import_run_id is not null;

create table if not exists public.qbank_import_review_metadata (
  batch_id text not null,
  question_id uuid not null references public.questions(id) on delete restrict,
  review_reason text not null,
  candidate_question_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (batch_id, question_id)
);
create index if not exists qbank_import_review_metadata_question_idx
  on public.qbank_import_review_metadata(question_id);

alter table public.qbank_import_batch_records enable row level security;
alter table public.qbank_import_review_metadata enable row level security;
revoke all on public.qbank_import_batch_records, public.qbank_import_review_metadata from public, anon, authenticated;
grant select, insert, delete on public.qbank_import_batch_records, public.qbank_import_review_metadata to service_role;

create or replace function public.qbank_begin_marrow_pyq_import(p_manifest jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_run_id uuid;
  v_batch constant text := 'marrow-pyq-v1-20260920';
  v_subject text := p_manifest->>'subject';
begin
  if current_user <> 'service_role' then raise exception 'trusted import role required'; end if;
  if p_manifest->>'batch_id' <> v_batch or p_manifest->>'platform' <> 'Marrow'
     or p_manifest->>'source_type' <> 'PYQ' then
    raise exception 'invalid Marrow PYQ import identity';
  end if;
  if not exists(select 1 from public.subjects where name=v_subject) then
    raise exception 'canonical subject not found: %', v_subject;
  end if;
  if coalesce((p_manifest->>'source_bytes')::bigint,0)<=0
     or coalesce(p_manifest->>'source_sha256','') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid source manifest';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_batch||':'||v_subject,0));
  insert into public.qbank_hybrid_import_runs(
    source_filename,source_sha256,source_bytes,platform,subject,parser_version,schema_version,
    source_test_count,occurrence_count,content_version_count,payload_object_count,payload_stored_bytes,status
  ) values (
    p_manifest->>'source_filename',p_manifest->>'source_sha256',(p_manifest->>'source_bytes')::bigint,
    'Marrow',v_subject,p_manifest->>'importer_version',(p_manifest->>'schema_version')::integer,
    (p_manifest->>'source_test_count')::integer,(p_manifest->>'occurrence_count')::integer,
    (p_manifest->>'content_version_count')::integer,(p_manifest->>'payload_object_count')::integer,
    (p_manifest->>'payload_stored_bytes')::bigint,'pending'
  ) on conflict(source_sha256,platform,subject,parser_version,schema_version)
    do update set error_detail=null
  returning id into v_run_id;
  insert into public.qbank_import_batch_records(batch_id,entity_type,entity_key,import_run_id)
  values(v_batch,'import_run',v_run_id::text,v_run_id) on conflict do nothing;
  return v_run_id;
end;
$function$;

create or replace function public.qbank_commit_marrow_pyq_import(p_manifest jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_batch constant text := 'marrow-pyq-v1-20260920';
  v_subject text := p_manifest->>'subject';
  v_run_id uuid; v_platform_id uuid; v_subject_id uuid;
  row jsonb; v_count integer; v_inserted integer := 0;
  questions_before bigint; attempts_before bigint; states_before bigint; bookmarks_before bigint;
begin
  if current_user <> 'service_role' then raise exception 'trusted import role required'; end if;
  if p_manifest->>'batch_id'<>v_batch or p_manifest->>'platform'<>'Marrow'
     or p_manifest->>'source_type'<>'PYQ' then raise exception 'invalid Marrow PYQ import identity'; end if;
  if jsonb_array_length(coalesce(p_manifest->'source_tests','[]'))<>(p_manifest->>'source_test_count')::integer
     or jsonb_array_length(coalesce(p_manifest->'versions','[]'))<>(p_manifest->>'content_version_count')::integer
     or jsonb_array_length(coalesce(p_manifest->'occurrences','[]'))<>(p_manifest->>'occurrence_count')::integer
     or jsonb_array_length(coalesce(p_manifest->'objects','[]'))<>(p_manifest->>'payload_object_count')::integer then
    raise exception 'manifest count mismatch';
  end if;
  if exists(select 1 from jsonb_array_elements(p_manifest->'source_tests') x where x->>'subject'<>v_subject)
     or exists(select 1 from jsonb_array_elements(p_manifest->'versions') x where x->>'subject'<>v_subject)
     or exists(select 1 from jsonb_array_elements(p_manifest->'occurrences') x where x->>'subject'<>v_subject) then
    raise exception 'subject batch isolation failed';
  end if;
  if exists(select 1 from jsonb_array_elements(p_manifest->'occurrences') x
            group by x->>'occurrence_key' having count(*)>1) then raise exception 'duplicate occurrence key in manifest'; end if;
  if exists(select 1 from jsonb_array_elements(p_manifest->'source_tests') x
            group by x->>'id' having count(*)>1) then raise exception 'duplicate source-test ID in manifest'; end if;
  if exists(select 1 from jsonb_array_elements(p_manifest->'versions') x
            group by x->>'question_id' having count(*)>1) then raise exception 'duplicate question ID in manifest'; end if;

  select id into v_platform_id from public.platforms where name='Marrow';
  select id into v_subject_id from public.subjects where name=v_subject;
  if v_platform_id is null or v_subject_id is null then raise exception 'platform or subject missing'; end if;
  if exists(select 1 from jsonb_array_elements(p_manifest->'source_tests') x
            join public.qbank_source_tests t on t.id=(x->>'id')::uuid
            where t.platform_id<>v_platform_id or t.subject_id<>v_subject_id or t.stable_key<>x->>'stable_key') then
    raise exception 'source-test ID conflict';
  end if;
  if exists(select 1 from jsonb_array_elements(p_manifest->'versions') x
            join public.questions q on q.id=(x->>'question_id')::uuid
            where q.platform_id<>v_platform_id or q.subject_id<>v_subject_id or q.source_type<>'PYQ') then
    raise exception 'question ID conflict';
  end if;
  if exists(select 1 from jsonb_array_elements(p_manifest->'occurrences') x
            join public.qbank_source_occurrences o on o.occurrence_key=x->>'occurrence_key'
            where o.question_id<>(x->>'question_id')::uuid or o.source_test_id<>(x->>'source_test_id')::uuid
               or o.question_position<>(x->>'question_position')::integer) then
    raise exception 'occurrence-key conflict';
  end if;
  if p_dry_run then
    return jsonb_build_object('status','dry_run','batch_id',v_batch,'subject',v_subject,
      'source_tests',jsonb_array_length(p_manifest->'source_tests'),'questions',jsonb_array_length(p_manifest->'versions'),
      'payload_objects',jsonb_array_length(p_manifest->'objects'),'occurrences',jsonb_array_length(p_manifest->'occurrences'),
      'review_versions',coalesce((select count(*) from jsonb_array_elements(p_manifest->'versions') x where nullif(x->>'review_reason','') is not null),0));
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_batch||':'||v_subject,0));
  select id into v_run_id from public.qbank_hybrid_import_runs
  where source_sha256=p_manifest->>'source_sha256' and platform='Marrow' and subject=v_subject
    and parser_version=p_manifest->>'importer_version' and schema_version=(p_manifest->>'schema_version')::integer;
  if v_run_id is null then raise exception 'pending import run not found'; end if;
  if (select status from public.qbank_hybrid_import_runs where id=v_run_id)='committed' then
    return jsonb_build_object('status','already_committed','run_id',v_run_id,'subject',v_subject);
  end if;
  select count(*) into questions_before from public.questions;
  select count(*) into attempts_before from public.question_attempts;
  select count(*) into states_before from public.user_question_state;
  select count(*) into bookmarks_before from public.bookmarks;

  insert into public.platform_subjects(platform_id,subject_id,native_label)
  values(v_platform_id,v_subject_id,v_subject) on conflict(platform_id,subject_id) do nothing;

  for row in select value from jsonb_array_elements(p_manifest->'source_tests') loop
    insert into public.qbank_source_tests(id,platform_id,subject_id,stable_key,source_test_id,title,sequence,
      declared_question_count,is_pyq,build_id,source_path)
    values((row->>'id')::uuid,v_platform_id,v_subject_id,row->>'stable_key',row->>'source_test_id',row->>'title',
      (row->>'sequence')::integer,(row->>'declared_question_count')::integer,true,v_batch,
      jsonb_build_array(v_subject,row->>'exam_family',(row->>'year')::integer))
    on conflict(id) do nothing;
    get diagnostics v_count=row_count;
    if v_count=1 then insert into public.qbank_import_batch_records values(v_batch,'source_test',row->>'id',v_run_id,now()); end if;
  end loop;

  for row in select value from jsonb_array_elements(p_manifest->'objects') loop
    insert into public.qbank_payload_objects(id,import_run_id,source_test_id,object_path,sha256,uncompressed_sha256,
      raw_bytes,stored_bytes,question_count,compression,status)
    values((row->>'id')::uuid,v_run_id,(row->>'source_test_id')::uuid,row->>'object_path',row->>'sha256',
      row->>'uncompressed_sha256',(row->>'raw_bytes')::bigint,(row->>'stored_bytes')::bigint,
      (row->>'question_count')::integer,row->>'compression','staged') on conflict(id) do nothing;
    get diagnostics v_count=row_count;
    if v_count=1 then insert into public.qbank_import_batch_records values(v_batch,'payload_object',row->>'id',v_run_id,now()); end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(p_manifest->'objects') x
    left join storage.objects s on s.bucket_id='qbank-payloads' and s.name=x->>'object_path'
    where s.id is null or coalesce((s.metadata->>'size')::bigint,-1)<>(x->>'stored_bytes')::bigint) then
    raise exception 'payload object missing or byte count differs';
  end if;

  for row in select value from jsonb_array_elements(p_manifest->'versions') loop
    insert into public.questions(id,platform_id,subject_id,source_question_id,question_text,options,correct_answer,
      explanation_html,question_images,explanation_images,video_url,audio_url,exam_tags,source_test_label,
      source_type,source_platform_id,is_pyq,is_neet_pg,is_inicet,exam_year,exam_shift,source_reference,
      status,content_origin,source_collection,is_usable)
    values((row->>'question_id')::uuid,v_platform_id,v_subject_id,
      (row->>'source_question_id')||'@'||left(row->>'content_sha256',12),row->>'stem_excerpt','[]',
      array_to_string(array(select jsonb_array_elements_text(row->'correct_option_keys')),','),null,'[]','[]',
      nullif(row->>'video_url',''),nullif(row->>'audio_url',''),
      case when row->>'exam_key'='aiims' then array['aiims'] else '{}'::text[] end,
      row->>'first_source_test_title','PYQ',v_platform_id,true,row->>'exam_key'='neet_pg',row->>'exam_key'='inicet',
      (row->>'exam_year')::integer,nullif(row->>'exam_session',''),'Marrow','published','imported','PYQ',true)
    on conflict(id) do nothing;
    get diagnostics v_count=row_count;
    if v_count=1 then insert into public.qbank_import_batch_records values(v_batch,'question',row->>'question_id',v_run_id,now()); end if;
    insert into public.qbank_question_payloads(question_id,platform_id,subject_id,content_sha256,source_question_id,
      payload_object_id,payload_index,correct_option_keys,option_count,is_multi_correct,media_status,
      has_question_media,has_explanation_media,has_audio,has_video)
    values((row->>'question_id')::uuid,v_platform_id,v_subject_id,row->>'content_sha256',row->>'source_question_id',
      (row->>'payload_object_id')::uuid,(row->>'payload_index')::integer,
      array(select jsonb_array_elements_text(row->'correct_option_keys')),(row->>'option_count')::integer,
      (row->>'is_multi_correct')::boolean,row->>'media_status',(row->>'has_question_media')::boolean,
      (row->>'has_explanation_media')::boolean,(row->>'has_audio')::boolean,(row->>'has_video')::boolean)
    on conflict(question_id) do nothing;
    get diagnostics v_count=row_count;
    if v_count=1 then insert into public.qbank_import_batch_records values(v_batch,'question_payload',row->>'question_id',v_run_id,now()); end if;
    if nullif(row->>'review_reason','') is not null then
      insert into public.qbank_import_review_metadata(batch_id,question_id,review_reason,candidate_question_ids)
      values(v_batch,(row->>'question_id')::uuid,row->>'review_reason',
        array(select value::uuid from jsonb_array_elements_text(coalesce(row->'candidate_question_ids','[]'))))
      on conflict do nothing;
      get diagnostics v_count=row_count;
      if v_count=1 then insert into public.qbank_import_batch_records values(v_batch,'review_metadata',row->>'question_id',v_run_id,now()); end if;
    end if;
  end loop;

  for row in select value from jsonb_array_elements(p_manifest->'occurrences') loop
    insert into public.qbank_source_occurrences(id,occurrence_key,import_run_id,source_test_id,question_id,
      source_question_id,question_position,content_sha256,is_pyq,exam_year,exam_session,exam_tags,is_current)
    values((row->>'id')::uuid,row->>'occurrence_key',v_run_id,(row->>'source_test_id')::uuid,
      (row->>'question_id')::uuid,row->>'source_question_id',(row->>'question_position')::integer,
      row->>'content_sha256',true,(row->>'exam_year')::integer,nullif(row->>'exam_session',''),
      array[row->>'exam_family'],true) on conflict(occurrence_key) do nothing;
    get diagnostics v_count=row_count;
    if v_count=1 then insert into public.qbank_import_batch_records values(v_batch,'source_occurrence',row->>'id',v_run_id,now()); end if;
  end loop;

  if exists(select 1 from jsonb_array_elements(p_manifest->'source_tests') x
    left join public.qbank_source_tests t on t.id=(x->>'id')::uuid
    where (select count(*) from public.qbank_source_occurrences o where o.source_test_id=t.id and o.is_current)
          <> (x->>'declared_question_count')::integer) then raise exception 'source-test occurrence count mismatch'; end if;
  if (select count(*) from public.question_attempts)<>attempts_before
     or (select count(*) from public.user_question_state)<>states_before
     or (select count(*) from public.bookmarks)<>bookmarks_before then raise exception 'learner data changed'; end if;
  update public.qbank_payload_objects set status='committed' where import_run_id=v_run_id;
  update public.qbank_hybrid_import_runs set status='committed',committed_at=now(),error_detail=null where id=v_run_id;
  return jsonb_build_object('status','committed','run_id',v_run_id,'subject',v_subject,
    'questions_before',questions_before,'questions_after',(select count(*) from public.questions));
end;
$function$;

create or replace function public.qbank_rollback_marrow_pyq_batch(p_batch_id text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_batch constant text := 'marrow-pyq-v1-20260920';
  v_deleted jsonb; v_skipped uuid[]; v_paths text[];
begin
  if current_user <> 'service_role' then raise exception 'trusted import role required'; end if;
  if p_batch_id<>v_batch then raise exception 'unexpected batch ID'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_batch,0));
  select coalesce(array_agg(entity_key::uuid),'{}') into v_skipped
  from public.qbank_import_batch_records r where r.batch_id=v_batch and r.entity_type='question'
    and (exists(select 1 from public.question_attempts a where a.question_id=r.entity_key::uuid)
      or exists(select 1 from public.user_question_state s where s.question_id=r.entity_key::uuid)
      or exists(select 1 from public.bookmarks b where b.question_id=r.entity_key::uuid)
      or exists(select 1 from public.test_session_questions t where t.question_id=r.entity_key::uuid));
  with d as (delete from public.qbank_import_review_metadata m where m.batch_id=v_batch and not(m.question_id=any(v_skipped)) returning 1)
  select jsonb_build_object('review_metadata',(select count(*) from d)) into v_deleted;
  with d as (delete from public.qbank_source_occurrences o using public.qbank_import_batch_records r
    where r.batch_id=v_batch and r.entity_type='source_occurrence' and r.entity_key=o.id::text
      and not(o.question_id=any(v_skipped)) returning 1)
  select v_deleted||jsonb_build_object('source_occurrences',(select count(*) from d)) into v_deleted;
  with d as (delete from public.qbank_question_payloads p using public.qbank_import_batch_records r
    where r.batch_id=v_batch and r.entity_type='question_payload' and r.entity_key=p.question_id::text
      and not(p.question_id=any(v_skipped)) returning 1)
  select v_deleted||jsonb_build_object('question_payloads',(select count(*) from d)) into v_deleted;
  with d as (delete from public.questions q using public.qbank_import_batch_records r
    where r.batch_id=v_batch and r.entity_type='question' and r.entity_key=q.id::text
      and not(q.id=any(v_skipped)) returning 1)
  select v_deleted||jsonb_build_object('questions',(select count(*) from d)) into v_deleted;
  with d as (delete from public.qbank_payload_objects p using public.qbank_import_batch_records r
    where r.batch_id=v_batch and r.entity_type='payload_object' and r.entity_key=p.id::text
      and not exists(select 1 from public.qbank_question_payloads qp where qp.payload_object_id=p.id) returning p.object_path)
  select v_deleted||jsonb_build_object('payload_objects',(select count(*) from d)),
    coalesce((select array_agg(object_path) from d),'{}') into v_deleted,v_paths;
  with d as (delete from public.qbank_source_tests t using public.qbank_import_batch_records r
    where r.batch_id=v_batch and r.entity_type='source_test' and r.entity_key=t.id::text
      and not exists(select 1 from public.qbank_source_occurrences o where o.source_test_id=t.id) returning 1)
  select v_deleted||jsonb_build_object('source_tests',(select count(*) from d)) into v_deleted;
  with d as (delete from public.qbank_hybrid_import_runs run using public.qbank_import_batch_records r
    where r.batch_id=v_batch and r.entity_type='import_run' and r.entity_key=run.id::text
      and not exists(select 1 from public.qbank_payload_objects p where p.import_run_id=run.id)
      and not exists(select 1 from public.qbank_source_occurrences o where o.import_run_id=run.id) returning 1)
  select v_deleted||jsonb_build_object('import_runs',(select count(*) from d)) into v_deleted;
  delete from public.qbank_import_batch_records r where r.batch_id=v_batch and (
    (r.entity_type='review_metadata' and not exists(select 1 from public.qbank_import_review_metadata m where m.batch_id=v_batch and m.question_id::text=r.entity_key))
    or (r.entity_type='source_occurrence' and not exists(select 1 from public.qbank_source_occurrences o where o.id::text=r.entity_key))
    or (r.entity_type='question_payload' and not exists(select 1 from public.qbank_question_payloads p where p.question_id::text=r.entity_key))
    or (r.entity_type='question' and not exists(select 1 from public.questions q where q.id::text=r.entity_key))
    or (r.entity_type='payload_object' and not exists(select 1 from public.qbank_payload_objects p where p.id::text=r.entity_key))
    or (r.entity_type='source_test' and not exists(select 1 from public.qbank_source_tests t where t.id::text=r.entity_key))
    or (r.entity_type='import_run' and not exists(select 1 from public.qbank_hybrid_import_runs i where i.id::text=r.entity_key))
  );
  return jsonb_build_object('batch_id',v_batch,'deleted',v_deleted,'skipped_question_ids',to_jsonb(v_skipped),
    'storage_object_paths',to_jsonb(v_paths));
end;
$function$;

create or replace function public.qbank_pyq_catalog()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'test_id',t.id,'subject_id',t.subject_id,'subject',s.name,'exam',x.exam,'year',x.exam_year,
    'title',t.title,'question_count',x.question_count,'platform',p.name
  ) order by s.name,x.exam,x.exam_year,t.sequence,t.id),'[]'::jsonb)
  from public.qbank_source_tests t
  join public.platforms p on p.id=t.platform_id
  join public.subjects s on s.id=t.subject_id
  join lateral (
    select min(coalesce(o.exam_tags[1],'PYQ')) exam,min(o.exam_year) exam_year,count(*) question_count
    from public.qbank_source_occurrences o where o.source_test_id=t.id and o.is_current
  ) x on true
  where t.is_pyq=true and x.question_count>0;
$function$;

revoke all on function public.qbank_begin_marrow_pyq_import(jsonb) from public;
revoke all on function public.qbank_commit_marrow_pyq_import(jsonb,boolean) from public;
revoke all on function public.qbank_rollback_marrow_pyq_batch(text) from public;
revoke all on function public.qbank_pyq_catalog() from public;
grant execute on function public.qbank_begin_marrow_pyq_import(jsonb) to service_role;
grant execute on function public.qbank_commit_marrow_pyq_import(jsonb,boolean) to service_role;
grant execute on function public.qbank_rollback_marrow_pyq_batch(text) to service_role;
grant execute on function public.qbank_pyq_catalog() to authenticated;

comment on function public.qbank_pyq_catalog() is 'Bounded Tests -> PYQs catalog. Returns metadata only; questions load only after a test is selected.';
commit;
