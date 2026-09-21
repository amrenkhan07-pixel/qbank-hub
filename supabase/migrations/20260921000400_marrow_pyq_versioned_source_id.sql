-- A Marrow source question ID can legitimately have multiple content versions.
-- Keep the raw source ID in payload/occurrence metadata while satisfying the
-- existing questions(platform_id, source_question_id) version-key constraint.
do $migration$
declare
  definition text;
  old_fragment constant text :=
    'values((row->>''question_id'')::uuid,v_platform_id,v_subject_id,row->>''source_question_id'',row->>''stem_excerpt'',''[]'',';
  new_fragment constant text :=
    'values((row->>''question_id'')::uuid,v_platform_id,v_subject_id,(row->>''source_question_id'')||''@''||left(row->>''content_sha256'',12),row->>''stem_excerpt'',''[]'',';
begin
  select pg_get_functiondef('public.qbank_commit_marrow_pyq_import(jsonb,boolean)'::regprocedure)
  into definition;
  if position(old_fragment in definition)=0 then
    raise exception 'Marrow commit RPC source-ID fragment was not found';
  end if;
  execute replace(definition,old_fragment,new_fragment);
end
$migration$;
