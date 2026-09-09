-- Concise read-only validation for the global canonical/taxonomy foundation.
with checks as (
  select 'canonical.tables_exist' as check_name,
    case when count(*) = 5 then 0 else 1 end as failures,
    format('%s/5 tables present', count(*)) as details
  from information_schema.tables
  where table_schema = 'public'
    and table_name in (
      'canonical_questions',
      'canonical_question_versions',
      'canonical_taxonomy_versions',
      'canonical_taxonomy_nodes',
      'canonical_question_taxonomy_assignments'
    )

  union all
  select 'canonical.tables_are_empty',
    (select count(*) from public.canonical_questions)
      + (select count(*) from public.canonical_question_versions)
      + (select count(*) from public.canonical_taxonomy_versions)
      + (select count(*) from public.canonical_taxonomy_nodes)
      + (select count(*) from public.canonical_question_taxonomy_assignments),
    'No source questions were automatically merged or classified'

  union all
  select 'canonical.rls_enabled',
    count(*) filter (where not c.relrowsecurity),
    format('%s/5 tables have RLS', count(*) filter (where c.relrowsecurity))
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'canonical_questions',
      'canonical_question_versions',
      'canonical_taxonomy_versions',
      'canonical_taxonomy_nodes',
      'canonical_question_taxonomy_assignments'
    )

  union all
  select 'canonical.client_roles_revoked',
    count(*),
    format('%s anon/authenticated grants remain', count(*))
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in (
      'canonical_questions',
      'canonical_question_versions',
      'canonical_taxonomy_versions',
      'canonical_taxonomy_nodes',
      'canonical_question_taxonomy_assignments'
    )
    and grantee in ('anon', 'authenticated')

  union all
  select 'canonical.hierarchy_trigger_installed',
    case when count(*) = 1 then 0 else 1 end,
    format('%s/1 hierarchy trigger present', count(*))
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'canonical_taxonomy_nodes'
    and t.tgname = 'canonical_taxonomy_nodes_validate_parent'
    and not t.tgisinternal

  union all
  select 'canonical.question_version_is_one_to_one',
    count(*) - count(distinct question_id),
    format('%s links, %s distinct source versions', count(*), count(distinct question_id))
  from public.canonical_question_versions

  union all
  select 'canonical.one_current_primary_path',
    count(*),
    format('%s duplicate current primary paths', count(*))
  from (
    select canonical_question_id, taxonomy_version_id
    from public.canonical_question_taxonomy_assignments
    where is_current and is_primary
    group by canonical_question_id, taxonomy_version_id
    having count(*) > 1
  ) conflicts

  union all
  select 'source.occurrence_order_preserved',
    count(*),
    format('%s duplicate current source-test positions', count(*))
  from (
    select source_test_id, question_position
    from public.qbank_source_occurrences
    where is_current
    group by source_test_id, question_position
    having count(*) > 1
  ) conflicts

  union all
  select 'source.occurrences_resolve_questions',
    count(*),
    format('%s orphaned source occurrences', count(*))
  from public.qbank_source_occurrences o
  left join public.questions q on q.id = o.question_id
  where q.id is null

  union all
  select 'source.tests_resolve_platform_subject',
    count(*),
    format('%s source tests have missing platform/subject', count(*))
  from public.qbank_source_tests st
  left join public.platforms p on p.id = st.platform_id
  left join public.subjects s on s.id = st.subject_id
  where p.id is null or s.id is null
)
select case when failures = 0 then 'PASS' else 'FAIL' end as status,
  check_name, failures, details
from checks
order by check_name;
