-- Read-only invariants for the exact 1,000-question intent-aware reclassification.
with target_run as (
  select id,taxonomy_version_id,summary from public.canonical_classification_runs
  where scope_key='canonical-medical-v1-prepladder-batch-1000-quality-v2'
), cohort as (
  select canonical_question_id,question_id,review_search from public.canonical_question_versions
  where link_method='classifier_batch'
), checks as (
  select 'quality.run_exists_once' check_name,abs(1-count(*)) failures,format('%s run rows',count(*)) detail from target_run
  union all select 'quality.exact_cohort_1000',abs(1000-count(*)),format('%s cohort versions',count(*)) from cohort
  union all select 'quality.search_index_all_1000',abs(1000-count(*) filter(where review_search is not null)),format('%s indexed rows',count(*) filter(where review_search is not null)) from cohort
  union all select 'quality.primary_paths_995',abs(995-count(*)),format('%s primary paths',count(*)) from public.canonical_question_taxonomy_assignments where classification_run_id=(select id from target_run) and is_primary
  union all select 'quality.secondary_paths_9',abs(9-count(*)),format('%s secondary paths',count(*)) from public.canonical_question_taxonomy_assignments where classification_run_id=(select id from target_run) and not is_primary
  union all select 'quality.primary_concepts_436',abs(436-count(*)),format('%s primary concepts',count(*)) from public.canonical_question_concept_assignments where classification_run_id=(select id from target_run) and is_primary
  union all select 'quality.secondary_concepts_9',abs(9-count(*)),format('%s secondary concepts',count(*)) from public.canonical_question_concept_assignments where classification_run_id=(select id from target_run) and not is_primary
  union all select 'quality.sparse_evidence_258',abs(258-count(*)),format('%s sparse evidence rows',count(*)) from public.canonical_assignment_review_evidence where classification_run_id=(select id from target_run)
  union all select 'quality.no_content_copied',count(*),format('%s copied content rows',count(*)) from public.canonical_assignment_review_evidence where classification_run_id=(select id from target_run) and evidence ?| array['stem','stem_text','question_text','options','explanation','explanation_html','media']
  union all select 'quality.intent_flag_valid',count(*),format('%s invalid intent flags',count(*)) from public.canonical_question_taxonomy_assignments where classification_run_id=(select id from target_run) and intent_state not in (0,1)
  union all select 'quality.evidence_flags_valid',count(*),format('%s invalid evidence flags',count(*)) from public.canonical_question_taxonomy_assignments where classification_run_id=(select id from target_run) and evidence_flags not between 0 and 63
  union all select 'quality.source_test_provenance',count(*),format('%s missing Source-Test IDs',count(*)) from public.canonical_question_taxonomy_assignments where classification_run_id=(select id from target_run) and source_test_id is null
  union all select 'quality.all_19_subjects',abs(19-count(distinct s.name)),format('%s subjects',count(distinct s.name)) from cohort c join public.questions q on q.id=c.question_id join public.subjects s on s.id=q.subject_id
  union all select 'quality.no_duplicate_current_primary',count(*),format('%s duplicate primaries',count(*)) from (select canonical_question_id,taxonomy_version_id from public.canonical_question_taxonomy_assignments where is_current and is_primary group by 1,2 having count(*)>1) d
  union all select 'quality.old_generation_preserved',abs(1002-count(*)),format('%s prior assignment rows preserved',count(*)) from public.canonical_question_taxonomy_assignments where classification_run_id=(select id from public.canonical_classification_runs where scope_key='canonical-medical-v1-prepladder-batch-1000-01')
  union all select 'quality.old_generation_not_current',count(*),format('%s stale old rows still current',count(*)) from public.canonical_question_taxonomy_assignments where classification_run_id=(select id from public.canonical_classification_runs where scope_key='canonical-medical-v1-prepladder-batch-1000-01') and is_current
  union all select 'source.questions_unchanged',abs(23262-count(*)),format('%s questions',count(*)) from public.questions
  union all select 'source.options_unchanged',abs(1672-count(*)),format('%s relational options',count(*)) from public.question_options
  union all select 'source.payloads_unchanged',abs(22844-count(*)),format('%s payload records',count(*)) from public.qbank_question_payloads
  union all select 'source.occurrences_unchanged',abs(23118-count(*)),format('%s occurrences',count(*)) from public.qbank_source_occurrences
  union all select 'learner.attempts_unchanged',abs(179-count(*)),format('%s attempts',count(*)) from public.question_attempts
  union all select 'learner.sessions_unchanged',abs(69-count(*)),format('%s sessions',count(*)) from public.test_sessions
  union all select 'learner.state_unchanged',abs(126-count(*)),format('%s state rows',count(*)) from public.user_question_state
  union all select 'taxonomy.nodes_unchanged',abs(931-count(*)),format('%s nodes',count(*)) from public.canonical_taxonomy_nodes
  union all select 'taxonomy.concepts_unchanged',abs(852-count(*)),format('%s concepts',count(*)) from public.canonical_medical_concepts
  union all select 'relationships.still_inactive',abs(12-count(*)),format('%s relationship rows',count(*)) from public.canonical_concept_relationships
)
select case when failures=0 then 'PASS' else 'FAIL' end status,check_name,detail from checks order by status desc,check_name;
