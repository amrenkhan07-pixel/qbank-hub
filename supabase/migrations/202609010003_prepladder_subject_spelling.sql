-- Reconcile the source spelling "Anaesthesia" with the existing live "Anesthesia" subject.
do $migration$
declare definition text;
begin
  select pg_get_functiondef('public.qbank_commit_prepladder_import(jsonb)'::regprocedure) into definition;
  if position('where lower(btrim(s.name))=''anaesthesia'';' in definition) > 0 then
    definition := replace(
      definition,
      'where lower(btrim(s.name))=''anaesthesia'';',
      'where lower(btrim(s.name)) in (''anaesthesia'',''anesthesia'') order by case when lower(btrim(s.name))=''anesthesia'' then 0 else 1 end limit 1;'
    );
    execute definition;
  end if;
end
$migration$;
