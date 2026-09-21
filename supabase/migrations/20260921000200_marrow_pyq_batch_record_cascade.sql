-- Keep rollback ownership records until their import run can be removed.
alter table public.qbank_import_batch_records
  drop constraint if exists qbank_import_batch_records_import_run_id_fkey;
alter table public.qbank_import_batch_records
  add constraint qbank_import_batch_records_import_run_id_fkey
  foreign key (import_run_id) references public.qbank_hybrid_import_runs(id) on delete cascade;

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
    where r.batch_id=v_batch and r.entity_type='source_occurrence' and r.entity_key=o.id::text and not(o.question_id=any(v_skipped)) returning 1)
  select v_deleted||jsonb_build_object('source_occurrences',(select count(*) from d)) into v_deleted;
  with d as (delete from public.qbank_question_payloads p using public.qbank_import_batch_records r
    where r.batch_id=v_batch and r.entity_type='question_payload' and r.entity_key=p.question_id::text and not(p.question_id=any(v_skipped)) returning 1)
  select v_deleted||jsonb_build_object('question_payloads',(select count(*) from d)) into v_deleted;
  with d as (delete from public.questions q using public.qbank_import_batch_records r
    where r.batch_id=v_batch and r.entity_type='question' and r.entity_key=q.id::text and not(q.id=any(v_skipped)) returning 1)
  select v_deleted||jsonb_build_object('questions',(select count(*) from d)) into v_deleted;
  with d as (delete from public.qbank_payload_objects p using public.qbank_import_batch_records r
    where r.batch_id=v_batch and r.entity_type='payload_object' and r.entity_key=p.id::text
      and not exists(select 1 from public.qbank_question_payloads qp where qp.payload_object_id=p.id) returning p.object_path)
  select v_deleted||jsonb_build_object('payload_objects',(select count(*) from d)),coalesce((select array_agg(object_path) from d),'{}') into v_deleted,v_paths;
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
  return jsonb_build_object('batch_id',v_batch,'deleted',v_deleted,'skipped_question_ids',to_jsonb(v_skipped),'storage_object_paths',to_jsonb(v_paths));
end;
$function$;

revoke all on function public.qbank_rollback_marrow_pyq_batch(text) from public;
grant execute on function public.qbank_rollback_marrow_pyq_batch(text) to service_role;
