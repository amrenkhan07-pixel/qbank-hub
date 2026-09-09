-- Concise, read-only validation for Canonical Taxonomy v1 DRAFT.
with v as (
  select id,status from public.canonical_taxonomy_versions where version_key='canonical-medical-v1'
), checks as (
  select 'taxonomy.version_is_draft' check_name,
    case when (select count(*) from v where status='draft')=1 then 0 else 1 end failures,
    'Exactly one Canonical Taxonomy v1 draft version' details
  union all select 'taxonomy.19_subjects',abs(19-(select count(*) from public.canonical_taxonomy_nodes n join v on v.id=n.taxonomy_version_id where n.node_type='subject')),'All 19 MBBS/NEET-PG subjects'
  union all select 'taxonomy.no_orphans',count(*),format('%s orphan nodes',count(*)) from public.canonical_taxonomy_nodes n join v on v.id=n.taxonomy_version_id left join public.canonical_taxonomy_nodes p on p.id=n.parent_id where n.node_type<>'subject' and p.id is null
  union all select 'taxonomy.valid_optional_system_hierarchy',count(*),format('%s invalid parent relationships',count(*)) from public.canonical_taxonomy_nodes n join v on v.id=n.taxonomy_version_id left join public.canonical_taxonomy_nodes p on p.id=n.parent_id where (n.node_type='subject' and n.parent_id is not null) or (n.node_type='system' and p.node_type<>'subject') or (n.node_type='topic' and p.node_type not in ('subject','system')) or (n.node_type='subtopic' and p.node_type<>'topic')
  union all select 'taxonomy.no_duplicate_codes',count(*),format('%s duplicate stable codes',count(*)) from (select stable_code from public.canonical_taxonomy_nodes n join v on v.id=n.taxonomy_version_id group by stable_code having count(*)>1) d
  union all select 'taxonomy.no_question_assignments',count(*),format('%s assignments exist',count(*)) from public.canonical_question_taxonomy_assignments a join v on v.id=a.taxonomy_version_id
  union all select 'taxonomy.no_canonical_question_links',count(*),format('%s canonical question/version rows exist',count(*)) from (select id from public.canonical_questions union all select id from public.canonical_question_versions) x
  union all select 'taxonomy.dry_run_is_bounded',case when count(*) between 300 and 500 then 0 else 1 end,format('%s deterministic sample rows',count(*)) from public.qbank_taxonomy_classification_dry_run('canonical-medical-v1',380)
  union all select 'taxonomy.dry_run_subject_coverage',abs(19-count(distinct existing_subject)),format('%s/19 subjects sampled',count(distinct existing_subject)) from public.qbank_taxonomy_classification_dry_run('canonical-medical-v1',380)
  union all select 'taxonomy.dry_run_no_invalid_paths',count(*),format('%s classified rows lack a canonical path',count(*)) from public.qbank_taxonomy_classification_dry_run('canonical-medical-v1',380) where classifier_confidence>0 and proposed_path is null
  union all select 'taxonomy.review_sample_is_bounded',case when count(*) between 300 and 500 then 0 else 1 end,format('%s materialized draft rows',count(*)) from public.canonical_taxonomy_draft_sample s join v on v.id=s.taxonomy_version_id
  union all select 'taxonomy.review_sample_subject_coverage',abs(19-count(distinct existing_subject)),format('%s/19 subjects in draft review sample',count(distinct existing_subject)) from public.canonical_taxonomy_draft_sample s join v on v.id=s.taxonomy_version_id
  union all select 'taxonomy.review_page_is_25',case when jsonb_array_length(public.qbank_taxonomy_review_page('canonical-medical-v1',1,25,null,null,null,null,null)->'items')=25 then 0 else 1 end,'Initial review page contains 25 metadata rows'
  union all select 'taxonomy.review_page_clamps_to_50',case when jsonb_array_length(public.qbank_taxonomy_review_page('canonical-medical-v1',1,500,null,null,null,null,null)->'items')=50 then 0 else 1 end,'Review page cannot exceed 50 rows'
  union all select 'taxonomy.review_metadata_payload_bounded',case when pg_column_size(public.qbank_taxonomy_review_overview('canonical-medical-v1'))+pg_column_size(public.qbank_taxonomy_review_page('canonical-medical-v1',1,25,null,null,null,null,null))<100000 then 0 else 1 end,'Initial database JSON payload remains below 100 KB'
  union all select 'taxonomy.review_does_not_publish',count(*),format('%s production assignments exist',count(*)) from public.canonical_question_taxonomy_assignments a join v on v.id=a.taxonomy_version_id
  union all select 'taxonomy.global_evidence_empty',count(*),format('%s evidence rows exist before scoring phase',count(*)) from public.canonical_global_evidence
  union all select 'taxonomy.source_counts_preserved',abs(23262-(select count(*) from public.questions)),format('%s questions', (select count(*) from public.questions))
  union all select 'taxonomy.source_occurrences_preserved',abs(23118-(select count(*) from public.qbank_source_occurrences)),format('%s source occurrences',(select count(*) from public.qbank_source_occurrences))
)
select case when failures=0 then 'PASS' else 'FAIL' end status,check_name,details from checks order by status desc,check_name;
