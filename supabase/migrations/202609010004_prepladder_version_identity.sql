-- Preserve the original source ID in hybrid metadata while satisfying the
-- existing platform/source-question uniqueness constraint for changed versions.
do $migration$
declare definition text;
begin
  select pg_get_functiondef('public.qbank_commit_prepladder_import(jsonb)'::regprocedure) into definition;
  if position('row->>''source_question_id'',row->>''stem_excerpt''' in definition) > 0 then
    definition := replace(
      definition,
      'row->>''source_question_id'',row->>''stem_excerpt''',
      '(row->>''source_question_id'') || ''@'' || left(row->>''content_sha256'',12),row->>''stem_excerpt'''
    );
    execute definition;
  end if;
end
$migration$;
