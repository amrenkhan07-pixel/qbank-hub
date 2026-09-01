-- PrepLadder hybrid import foundation.
-- Additive: preserves existing questions, options, study state and taxonomy.

begin;
set local lock_timeout = '8s';

do $guard$
declare missing text;
begin
  with required(table_name, column_name) as (
    values
      ('questions','id'),('questions','platform_id'),('questions','subject_id'),
      ('questions','question_text'),('questions','options'),('questions','correct_answer'),
      ('questions','source_question_id'),('questions','source_test_label'),
      ('questions','source_collection'),('questions','source_type'),('questions','is_pyq'),
      ('platforms','id'),('platforms','name'),('platforms','code'),
      ('subjects','id'),('subjects','name'),
      ('platform_subjects','id'),('platform_subjects','platform_id'),('platform_subjects','subject_id')
  )
  select string_agg(format('%I.%I', r.table_name, r.column_name), ', ')
  into missing
  from required r
  left join information_schema.columns c
    on c.table_schema='public' and c.table_name=r.table_name and c.column_name=r.column_name
  where c.column_name is null;
  if missing is not null then
    raise exception 'PrepLadder migration stopped; missing live columns: %', missing;
  end if;
end
$guard$;

create table if not exists public.qbank_hybrid_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_filename text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_bytes bigint not null check (source_bytes > 0),
  original_source_uploaded boolean not null default false check (not original_source_uploaded),
  platform text not null,
  subject text not null,
  parser_version text not null,
  schema_version integer not null check (schema_version > 0),
  source_test_count integer not null default 0 check (source_test_count >= 0),
  occurrence_count integer not null default 0 check (occurrence_count >= 0),
  content_version_count integer not null default 0 check (content_version_count >= 0),
  payload_object_count integer not null default 0 check (payload_object_count >= 0),
  payload_stored_bytes bigint not null default 0 check (payload_stored_bytes >= 0),
  status text not null default 'pending' check (status in ('pending','uploaded','committed','failed','reconciled')),
  error_detail text,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  unique (source_sha256, platform, subject, parser_version, schema_version)
);

create table if not exists public.qbank_source_tests (
  id uuid primary key,
  platform_id uuid not null references public.platforms(id),
  subject_id uuid not null references public.subjects(id),
  stable_key text not null unique check (stable_key ~ '^[0-9a-f]{64}$'),
  source_test_id text not null,
  title text not null check (char_length(btrim(title)) > 0),
  sequence integer not null check (sequence > 0),
  numeric_prefix integer,
  declared_question_count integer not null check (declared_question_count >= 0),
  total_marks numeric,
  duration_minutes numeric,
  time_per_question_seconds numeric,
  is_pyq boolean not null default false,
  build_id text,
  source_path jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (platform_id, subject_id, source_test_id)
);

create table if not exists public.qbank_payload_objects (
  id uuid primary key,
  import_run_id uuid not null references public.qbank_hybrid_import_runs(id),
  source_test_id uuid not null references public.qbank_source_tests(id),
  bucket_id text not null default 'qbank-payloads' check (bucket_id='qbank-payloads'),
  object_path text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uncompressed_sha256 text not null check (uncompressed_sha256 ~ '^[0-9a-f]{64}$'),
  raw_bytes bigint not null check (raw_bytes >= 0),
  stored_bytes bigint not null check (stored_bytes >= 0),
  question_count integer not null check (question_count >= 0),
  compression text not null check (compression in ('gzip','none')),
  status text not null default 'staged' check (status in ('staged','committed','orphaned')),
  created_at timestamptz not null default now(),
  unique (sha256, object_path)
);

create table if not exists public.qbank_question_payloads (
  question_id uuid primary key references public.questions(id) on delete restrict,
  platform_id uuid not null references public.platforms(id),
  subject_id uuid not null references public.subjects(id),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_question_id text not null,
  payload_object_id uuid not null references public.qbank_payload_objects(id),
  payload_index integer not null check (payload_index >= 0),
  correct_option_keys text[] not null check (cardinality(correct_option_keys) >= 1),
  option_count integer not null check (option_count between 2 and 8),
  is_multi_correct boolean not null,
  media_status text not null check (media_status in ('NO_MEDIA','MEDIA_REFERENCED','QUESTION_IMAGE_UNAVAILABLE','EXPLANATION_IMAGE_UNAVAILABLE','IMAGE_DEPENDENT')),
  has_question_media boolean not null default false,
  has_explanation_media boolean not null default false,
  has_audio boolean not null default false,
  has_video boolean not null default false,
  created_at timestamptz not null default now(),
  unique (platform_id, subject_id, content_sha256),
  unique (payload_object_id, payload_index),
  check (is_multi_correct = (cardinality(correct_option_keys) > 1))
);

create table if not exists public.qbank_source_occurrences (
  id uuid primary key,
  occurrence_key text not null unique check (occurrence_key ~ '^[0-9a-f]{64}$'),
  import_run_id uuid not null references public.qbank_hybrid_import_runs(id),
  source_test_id uuid not null references public.qbank_source_tests(id),
  question_id uuid not null references public.questions(id) on delete restrict,
  source_question_id text not null,
  question_position integer not null check (question_position > 0),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  is_pyq boolean not null default false,
  exam_year integer check (exam_year is null or exam_year between 1950 and 2100),
  exam_session text,
  exam_tags text[] not null default '{}',
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  unique (source_test_id, question_position, content_sha256)
);

create unique index if not exists qbank_source_occurrences_current_position_uidx
  on public.qbank_source_occurrences(source_test_id, question_position) where is_current;
create index if not exists qbank_source_tests_scope_order_idx
  on public.qbank_source_tests(platform_id, subject_id, sequence);
create index if not exists qbank_source_tests_pyq_idx
  on public.qbank_source_tests(platform_id, subject_id, is_pyq) where is_pyq;
create index if not exists qbank_source_occurrences_test_order_idx
  on public.qbank_source_occurrences(source_test_id, is_current, question_position);
create index if not exists qbank_source_occurrences_question_idx
  on public.qbank_source_occurrences(question_id) where is_current;
create index if not exists qbank_question_payloads_scope_idx
  on public.qbank_question_payloads(platform_id, subject_id);

alter table public.qbank_hybrid_import_runs enable row level security;
alter table public.qbank_source_tests enable row level security;
alter table public.qbank_payload_objects enable row level security;
alter table public.qbank_question_payloads enable row level security;
alter table public.qbank_source_occurrences enable row level security;

revoke all on public.qbank_hybrid_import_runs, public.qbank_source_tests,
  public.qbank_payload_objects, public.qbank_question_payloads,
  public.qbank_source_occurrences from public, anon, authenticated;
grant select on public.qbank_source_tests, public.qbank_payload_objects,
  public.qbank_question_payloads, public.qbank_source_occurrences to authenticated;
grant select, insert, update on public.qbank_hybrid_import_runs, public.qbank_source_tests,
  public.qbank_payload_objects, public.qbank_question_payloads,
  public.qbank_source_occurrences to service_role;

drop policy if exists "qbank learners read source tests" on public.qbank_source_tests;
create policy "qbank learners read source tests" on public.qbank_source_tests
  for select to authenticated using (true);
drop policy if exists "qbank learners read payload metadata" on public.qbank_payload_objects;
create policy "qbank learners read payload metadata" on public.qbank_payload_objects
  for select to authenticated using (status='committed');
drop policy if exists "qbank learners read question payload index" on public.qbank_question_payloads;
create policy "qbank learners read question payload index" on public.qbank_question_payloads
  for select to authenticated using (true);
drop policy if exists "qbank learners read source occurrences" on public.qbank_source_occurrences;
create policy "qbank learners read source occurrences" on public.qbank_source_occurrences
  for select to authenticated using (is_current);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('qbank-payloads','qbank-payloads',false,10485760,array['application/gzip','application/json'])
on conflict (id) do update set public=false, file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "qbank learners read committed payloads" on storage.objects;
create policy "qbank learners read committed payloads" on storage.objects
for select to authenticated
using (
  bucket_id='qbank-payloads'
  and exists (
    select 1 from public.qbank_payload_objects p
    where p.bucket_id=storage.objects.bucket_id
      and p.object_path=storage.objects.name
      and p.status='committed'
  )
);

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
  if p_manifest->>'platform' <> 'PrepLadder' or p_manifest->>'subject' <> 'Anaesthesia' then
    raise exception 'pilot scope is restricted to PrepLadder Anaesthesia';
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
  row jsonb; existing jsonb; questions_before bigint; options_before bigint;
  attempts_before bigint; sessions_before bigint; state_before bigint;
begin
  if current_user <> 'service_role' then raise exception 'trusted import role required'; end if;
  if p_manifest->>'platform' <> 'PrepLadder' or p_manifest->>'subject' <> 'Anaesthesia' then
    raise exception 'pilot scope is restricted to PrepLadder Anaesthesia';
  end if;
  select r.id into v_run_id from public.qbank_hybrid_import_runs r
  where source_sha256=p_manifest->>'source_sha256' and platform='PrepLadder' and subject='Anaesthesia'
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
  select s.id into v_subject_id from public.subjects s where lower(btrim(s.name)) in ('anaesthesia','anesthesia')
  order by case when lower(btrim(s.name))='anesthesia' then 0 else 1 end limit 1;
  if v_subject_id is null then raise exception 'existing Anaesthesia subject not found'; end if;
  select ps.id into v_platform_subject_id from public.platform_subjects ps where ps.platform_id=v_platform_id and ps.subject_id=v_subject_id;
  if v_platform_subject_id is null then
    insert into public.platform_subjects(platform_id,subject_id,native_label)
    values(v_platform_id,v_subject_id,'Anaesthesia') returning id into v_platform_subject_id;
  end if;

  for row in select value from jsonb_array_elements(p_manifest->'source_tests') loop
    select to_jsonb(t) into existing from public.qbank_source_tests t where t.stable_key=row->>'stable_key';
    if existing is not null and (existing->>'source_test_id' <> row->>'source_test_id' or existing->>'title' <> row->>'title') then
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
    select 1
    from jsonb_array_elements(p_manifest->'objects') manifest_object
    left join storage.objects stored
      on stored.bucket_id='qbank-payloads'
     and stored.name=manifest_object->>'object_path'
    where stored.id is null
       or coalesce((stored.metadata->>'size')::bigint,-1)<>(manifest_object->>'stored_bytes')::bigint
  ) then
    raise exception 'payload object is missing or its stored byte count differs from the manifest';
  end if;

  for row in select value from jsonb_array_elements(p_manifest->'versions') loop
    insert into public.questions(
      id,platform_id,subject_id,source_question_id,question_text,options,correct_answer,
      explanation_html,question_images,explanation_images,source_test_label,
      source_collection,source_type,is_pyq,content_origin,status
    ) values (
      (row->>'question_id')::uuid,v_platform_id,v_subject_id,(row->>'source_question_id') || '@' || left(row->>'content_sha256',12),row->>'stem_excerpt',
      '[]'::jsonb,array_to_string(array(select jsonb_array_elements_text(row->'correct_option_keys')),','),
      null,'[]'::jsonb,'[]'::jsonb,row->>'first_source_test_title','PrepLadder Anaesthesia',
      'prepladder_hybrid',coalesce((row->>'is_pyq')::boolean,false),'imported','published'
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
    'occurrences',(select count(*) from public.qbank_source_occurrences o join public.qbank_source_tests t on t.id=o.source_test_id where t.platform_id=v_platform_id and t.subject_id=v_subject_id and o.is_current)
  );
end
$function$;

revoke all on function public.qbank_begin_prepladder_import(jsonb) from public,anon,authenticated;
revoke all on function public.qbank_commit_prepladder_import(jsonb) from public,anon,authenticated;
grant execute on function public.qbank_begin_prepladder_import(jsonb) to service_role;
grant execute on function public.qbank_commit_prepladder_import(jsonb) to service_role;

commit;
