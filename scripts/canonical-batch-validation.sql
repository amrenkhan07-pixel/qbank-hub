-- Read-only acceptance checks for the one authorized 1,000-question batch.
with target_run as (
  select id,taxonomy_version_id,summary
  from public.canonical_classification_runs
  where scope_key='canonical-medical-v1-prepladder-batch-1000-01'
), run_questions as (
  select canonical_question_id from public.canonical_question_taxonomy_assignments
  where classification_run_id=(select id from target_run)
  union
  select canonical_question_id from public.canonical_assignment_review_evidence
  where classification_run_id=(select id from target_run)
), checks as (
  select 'batch.run_exists_once' check_name,abs(1-count(*)) failures,format('%s run rows',count(*)) detail
  from target_run
  union all select 'batch.exactly_1000_processed',abs(1000-count(*)),format('%s distinct batch identities',count(*)) from run_questions
  union all select 'batch.primary_assignments',abs(992-count(*)),format('%s primary paths',count(*))
    from public.canonical_question_taxonomy_assignments where classification_run_id=(select id from target_run) and is_primary
  union all select 'batch.secondary_paths_reviewed_only',abs(10-count(*))+count(*) filter(where ambiguity_state<>2 or not evidence_retained),format('%s reviewed secondary paths',count(*))
    from public.canonical_question_taxonomy_assignments where classification_run_id=(select id from target_run) and not is_primary
  union all select 'batch.primary_concepts',abs(136-count(*)),format('%s primary concepts',count(*))
    from public.canonical_question_concept_assignments where classification_run_id=(select id from target_run) and is_primary
  union all select 'batch.secondary_concepts',abs(10-count(*)),format('%s secondary concepts',count(*))
    from public.canonical_question_concept_assignments where classification_run_id=(select id from target_run) and not is_primary
  union all select 'batch.sparse_evidence',abs(260-count(*)),format('%s exception evidence rows',count(*))
    from public.canonical_assignment_review_evidence where classification_run_id=(select id from target_run)
  union all select 'batch.no_content_in_evidence',count(*),format('%s evidence rows copy content',count(*))
    from public.canonical_assignment_review_evidence
    where classification_run_id=(select id from target_run)
      and evidence ?| array['stem','stem_text','question_text','options','explanation','explanation_html','media']
  union all select 'batch.all_19_subjects',abs(19-count(distinct s.name)),format('%s subjects',count(distinct s.name))
    from run_questions rq join public.canonical_question_versions cv on cv.canonical_question_id=rq.canonical_question_id
    join public.questions q on q.id=cv.question_id join public.subjects s on s.id=q.subject_id
  union all select 'batch.total_versions_are_pilot_plus_1000',abs(1150-count(*)),format('%s canonical version links',count(*)) from public.canonical_question_versions
  union all select 'batch.total_primary_is_pilot_plus_batch',abs(1145-count(*)),format('%s total current primary paths',count(*))
    from public.canonical_question_taxonomy_assignments where is_current and is_primary
  union all select 'batch.no_duplicate_primary',count(*),format('%s duplicate current primaries',count(*)) from (
    select canonical_question_id,taxonomy_version_id from public.canonical_question_taxonomy_assignments
    where is_current and is_primary group by 1,2 having count(*)>1
  ) duplicate_primary
  union all select 'batch.compact_source_test_map_once',abs(1108-count(*)),format('%s mapped Source Tests',count(*))
    from public.canonical_source_test_topic_assignments where is_current and is_primary
  union all select 'source.questions_unchanged',abs(23262-count(*)),format('%s questions',count(*)) from public.questions
  union all select 'source.options_unchanged',abs(1672-count(*)),format('%s relational options',count(*)) from public.question_options
  union all select 'source.payloads_unchanged',abs(22844-count(*)),format('%s payload records',count(*)) from public.qbank_question_payloads
  union all select 'source.occurrences_unchanged',abs(23118-count(*)),format('%s occurrences',count(*)) from public.qbank_source_occurrences
  union all select 'learner.attempts_unchanged',abs(179-count(*)),format('%s attempts',count(*)) from public.question_attempts
  union all select 'learner.sessions_unchanged',abs(69-count(*)),format('%s sessions',count(*)) from public.test_sessions
  union all select 'learner.state_unchanged',abs(126-count(*)),format('%s state rows',count(*)) from public.user_question_state
  union all select 'taxonomy.version_unchanged',abs(1-count(*)),format('%s v1 draft versions',count(*))
    from public.canonical_taxonomy_versions where version_key='canonical-medical-v1' and status='draft'
  union all select 'taxonomy.nodes_unchanged',abs(931-count(*)),format('%s taxonomy nodes',count(*)) from public.canonical_taxonomy_nodes
  union all select 'relationships.still_inactive',abs(12-count(*)),format('%s review-only relationships',count(*)) from public.canonical_concept_relationships
)
select case when failures=0 then 'PASS' else 'FAIL' end status,check_name,detail
from checks order by status desc,check_name;
