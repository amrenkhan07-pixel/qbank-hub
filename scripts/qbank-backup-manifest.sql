-- Read-only checkpoint manifest to run beside every logical database backup.
-- It contains counts and hashes only; it does not export or mutate data.
select jsonb_build_object(
  'generated_at', now(),
  'database_bytes', pg_database_size(current_database()),
  'source', jsonb_build_object(
    'questions', (select count(*) from public.questions),
    'source_tests', (select count(*) from public.qbank_source_tests),
    'source_occurrences', (select count(*) from public.qbank_source_occurrences),
    'payload_records', (select count(*) from public.qbank_question_payloads),
    'payload_objects', (select count(*) from public.qbank_payload_objects),
    'payload_stored_bytes', (select coalesce(sum(stored_bytes), 0) from public.qbank_payload_objects),
    'payload_manifest_md5', (select md5(coalesce(string_agg(object_path || ':' || sha256 || ':' || stored_bytes, '|' order by object_path), '')) from public.qbank_payload_objects)
  ),
  'learner', jsonb_build_object(
    'attempts', (select count(*) from public.question_attempts),
    'sessions', (select count(*) from public.test_sessions),
    'session_questions', (select count(*) from public.test_session_questions),
    'test_answers', (select count(*) from public.test_answers),
    'question_state', (select count(*) from public.user_question_state),
    'srm_events', (select count(*) from public.qbank_srm_events),
    'notes', (select count(*) from public.question_notes),
    'bookmarks_legacy', (select count(*) from public.bookmarks)
  ),
  'canonical', jsonb_build_object(
    'versions', (select count(*) from public.canonical_taxonomy_versions),
    'nodes', (select count(*) from public.canonical_taxonomy_nodes),
    'concepts', (select count(*) from public.canonical_medical_concepts),
    'relationships', (select count(*) from public.canonical_concept_relationships),
    'canonical_questions', (select count(*) from public.canonical_questions),
    'content_links', (select count(*) from public.canonical_question_versions),
    'taxonomy_assignments', (select count(*) from public.canonical_question_taxonomy_assignments),
    'concept_assignments', (select count(*) from public.canonical_question_concept_assignments),
    'source_test_proposals', (select count(*) from public.canonical_source_test_topic_proposals),
    'source_test_reviews', (select count(*) from public.canonical_source_test_topic_reviews),
    'draft_reviews', (select count(*) from public.canonical_taxonomy_draft_reviews)
  )
) as backup_manifest;
