-- Marrow-only, insert-only, atomic chunks. No taxonomy or search writes.
create or replace function public.qbank_commit_marrow_qbank_chunk(p jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_platform uuid := '1a5c5236-9319-4396-a98a-0b743d7380ca'; runid uuid := (p#>>'{run,id}')::uuid; n integer := jsonb_array_length(p->'questions'); no integer := jsonb_array_length(p->'occurrences'); expected text := md5(p::text); prior text;
begin
 if p->>'source_sha256' is distinct from 'ccca4d0c95e20538469b1b438e0cfa51ffbd4c9a902ed25968b40626081faec8' or n not between 1 and 500 or p#>>'{run,platform}' is distinct from 'Marrow' then raise exception 'Invalid Marrow manifest'; end if;
 perform pg_advisory_xact_lock(hashtext('marrow_qbank-full-v1'));
 select error_detail into prior from qbank_hybrid_import_runs where id=runid;
 if found then
  if prior is distinct from 'manifest-md5:'||expected or (select count(*) from qbank_source_occurrences where import_run_id=runid)<>no then raise exception 'Existing chunk does not match'; end if;
  return jsonb_build_object('status','already_committed','questions',n,'occurrences',no,'run_id',runid);
 end if;
 if exists(select 1 from jsonb_array_elements(p->'questions') r where (r->>'platform_id')::uuid<>v_platform or r->>'source_type' is distinct from 'marrow_qbank_v1') or exists(select 1 from jsonb_array_elements(p->'tests') r where (r->>'platform_id')::uuid<>v_platform) or exists(select 1 from jsonb_array_elements(p->'payloads') r where (r->>'platform_id')::uuid<>v_platform) then raise exception 'Out of scope platform'; end if;
 if jsonb_array_length(p->'payloads')<>n or no < n or no > 500 or exists(select 1 from jsonb_array_elements(p->'occurrences') r where (r->>'import_run_id')::uuid<>runid or (not exists(select 1 from jsonb_array_elements(p->'questions') q where q->>'id'=r->>'question_id') and not exists(select 1 from questions q where q.id=(r->>'question_id')::uuid and q.source_type='marrow_qbank_v1')) or not exists(select 1 from jsonb_array_elements(p->'tests') t where t->>'id'=r->>'source_test_id')) then raise exception 'Invalid occurrence binding'; end if;
 if not exists(select 1 from storage.objects where bucket_id='qbank-payloads' and name=p#>>'{object,object_path}' and (metadata->>'size')::bigint=(p#>>'{object,stored_bytes}')::bigint) or p#>>'{object,object_path}' not like 'marrow/qbank-v1/ccca4d0c95e2/%' then raise exception 'Missing or invalid uploaded object'; end if;
 insert into qbank_hybrid_import_runs(id,source_filename,source_sha256,source_bytes,platform,subject,parser_version,schema_version,source_test_count,occurrence_count,content_version_count,payload_object_count,payload_stored_bytes,status,error_detail,committed_at)
 select id,source_filename,source_sha256,source_bytes,platform,subject,parser_version,schema_version,source_test_count,occurrence_count,content_version_count,payload_object_count,payload_stored_bytes,'committed','manifest-md5:'||expected,now() from jsonb_populate_record(null::qbank_hybrid_import_runs,p->'run');
 insert into qbank_source_tests(id,platform_id,subject_id,stable_key,source_test_id,title,sequence,numeric_prefix,declared_question_count,total_marks,duration_minutes,time_per_question_seconds,is_pyq,build_id,source_path)
 select id,platform_id,subject_id,stable_key,source_test_id,title,sequence,numeric_prefix,declared_question_count,total_marks,duration_minutes,time_per_question_seconds,is_pyq,build_id,source_path from jsonb_populate_recordset(null::qbank_source_tests,p->'tests');
 insert into qbank_payload_objects(id,import_run_id,source_test_id,object_path,sha256,uncompressed_sha256,raw_bytes,stored_bytes,question_count,compression,status)
 select id,import_run_id,source_test_id,object_path,sha256,uncompressed_sha256,raw_bytes,stored_bytes,question_count,compression,status from jsonb_populate_record(null::qbank_payload_objects,p->'object');
 insert into questions(id,platform_id,subject_id,topic_id,source_question_id,question_text,options,correct_answer,source_test_label,source_subtopic_label,source_collection,source_type,is_pyq,is_grand_test,content_origin,status,is_usable,unusable_reason)
 select id,platform_id,subject_id,topic_id,source_question_id,question_text,'[]'::jsonb,correct_answer,source_test_label,source_subtopic_label,source_collection,source_type,is_pyq,is_grand_test,content_origin,status,is_usable,unusable_reason from jsonb_populate_recordset(null::questions,p->'questions');
 insert into qbank_question_payloads(question_id,platform_id,subject_id,content_sha256,source_question_id,payload_object_id,payload_index,correct_option_keys,option_count,is_multi_correct,media_status,has_question_media,has_explanation_media,has_audio,has_video)
 select question_id,platform_id,subject_id,content_sha256,source_question_id,payload_object_id,payload_index,correct_option_keys,option_count,is_multi_correct,media_status,has_question_media,has_explanation_media,has_audio,has_video from jsonb_populate_recordset(null::qbank_question_payloads,p->'payloads');
 insert into qbank_source_occurrences(id,occurrence_key,import_run_id,source_test_id,question_id,source_question_id,question_position,content_sha256,is_pyq,is_current)
 select id,occurrence_key,import_run_id,source_test_id,question_id,source_question_id,question_position,content_sha256,is_pyq,is_current from jsonb_populate_recordset(null::qbank_source_occurrences,p->'occurrences');
 if exists(select 1 from qbank_source_tests t join jsonb_array_elements(p->'tests') r on t.id=(r->>'id')::uuid where t.declared_question_count<>(select count(*) from qbank_source_occurrences o where o.source_test_id=t.id and o.is_current)) then raise exception 'Module count mismatch'; end if;
 return jsonb_build_object('status','committed','questions',n,'occurrences',no,'run_id',runid);
end $$;
revoke all on function public.qbank_commit_marrow_qbank_chunk(jsonb) from public,anon,authenticated;
grant execute on function public.qbank_commit_marrow_qbank_chunk(jsonb) to service_role;
