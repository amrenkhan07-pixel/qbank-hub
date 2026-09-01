#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { analyticsMetadataCapabilities, analyticsTopicSubtopicRedundant, buildTaxonomyIndex, deriveAnalyticsPopulations, filterAnalyticsPopulation, resolveTaxonomyCascade, validateAnalyticsDrilldown, validateGeneratedQuestionSet, validateQuestionSetLifecycle, validateQuestionStateBindings, validateResumeSnapshot } from '../app/validation.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const rows = [];
const check = (name, passed, detail = '') => rows.push({ name, status: passed ? 'PASS' : 'FAIL', detail });
const question = (overrides = {}) => ({
  id: 'q-1', platform_id: 'p-1', subject_id: 's-1', system_id: null,
  question_text: 'Usable stem?', correct_answer: 'A', content_origin: 'imported',
  options: [
    { option_key: 'A', option_text: 'First option' },
    { option_key: 'B', option_text: 'Second option' },
  ],
  ...overrides,
});
const filters = { platforms: ['p-1'], subjects: ['s-1'], systems: [], topics: [], subtopics: [], statuses: ['all'], pyq: '', year: '', search: '', source: '' };

const valid = validateGeneratedQuestionSet({ questions: [question()], filters, requested: 1, matchingCount: 1 });
check('fixture.generated_valid_set', valid.status === 'PASS');
const zero = validateGeneratedQuestionSet({ questions: [], filters, requested: 10, matchingCount: 0 });
check('fixture.zero_result_never_substitutes', zero.status === 'PASS');
const wrongPlatform = validateGeneratedQuestionSet({ questions: [question({ platform_id: 'p-2' })], filters, requested: 1, matchingCount: 1 });
check('fixture.platform_violation_detected', wrongPlatform.status === 'FAIL');
const wrongSubtopic = validateGeneratedQuestionSet({ questions: [question()], filters: { ...filters, subtopics: ['st-1'] }, requested: 1, matchingCount: 1, subtopicQuestionIds: [] });
check('fixture.subtopic_violation_detected', wrongSubtopic.status === 'FAIL');
const multiSubtopic = validateGeneratedQuestionSet({ questions: [question(), question({ id: 'q-2' })], filters: { ...filters, subjects: [], subtopics: ['st-1', 'st-2'] }, requested: 2, matchingCount: 2, subtopicQuestionIds: ['q-1', 'q-2'] });
check('fixture.multi_subtopic_union_preserved', multiSubtopic.status === 'PASS');
const crossSubjectZero = validateGeneratedQuestionSet({ questions: [], filters: { ...filters, subjects: ['s-1', 's-2'], subtopics: ['st-1', 'st-2'] }, requested: 10, matchingCount: 0, subtopicQuestionIds: [] });
check('fixture.cross_subject_zero_result_preserved', crossSubjectZero.status === 'PASS');
const duplicate = validateGeneratedQuestionSet({ questions: [question(), question()], filters, requested: 2, matchingCount: 2 });
check('fixture.duplicate_question_detected', duplicate.status === 'FAIL');
const brokenOptions = validateGeneratedQuestionSet({ questions: [question({ options: [{ option_key: 'A', option_text: '' }] })], filters, requested: 1, matchingCount: 1 });
check('fixture.option_structure_violation_detected', brokenOptions.status === 'FAIL');
const bleed = validateQuestionStateBindings({ questions: [question()], answers: { 'q-2': { selected_option: 'A' } }, bookmarks: new Set(), marked: new Set() });
check('fixture.adjacent_question_state_bleed_detected', bleed.status === 'FAIL');
const storedRows = [{ question_id: 'q-1', position: 1, question_snapshot: question() }];
const validResume = validateResumeSnapshot({ session: { total_questions: 1 }, storedRows, questions: [question()], answers: [] });
check('fixture.exact_resume_order', validResume.status === 'PASS');
const wrongResume = validateResumeSnapshot({ session: { total_questions: 1 }, storedRows, questions: [question({ id: 'q-2' })], answers: [] });
check('fixture.resume_order_violation_detected', wrongResume.status === 'FAIL');

const lifecycleIds = ['q-1', 'q-2', 'q-3'];
const lifecycle = validateQuestionSetLifecycle({ sourceQuestionIds: lifecycleIds, browseQuestionIds: lifecycleIds, previewQuestionIds: lifecycleIds, sessionQuestionIds: lifecycleIds, targetSeconds: 150 });
check('lifecycle.browse_preview_start_exact_ids', lifecycle.status === 'PASS');
const prematurePreview = validateQuestionSetLifecycle({ sourceQuestionIds: lifecycleIds, browseQuestionIds: lifecycleIds, previewQuestionIds: lifecycleIds, sessionQuestionIds: lifecycleIds, previewSessionWrites: 1, previewTimerCount: 1, targetSeconds: 150 });
check('lifecycle.premature_preview_side_effect_detected', prematurePreview.status === 'FAIL');
const browseSideEffect = validateQuestionSetLifecycle({ sourceQuestionIds: lifecycleIds, browseQuestionIds: lifecycleIds, previewQuestionIds: lifecycleIds, sessionQuestionIds: lifecycleIds, browseAttemptWrites: 1, browseTimerCount: 1, targetSeconds: 150 });
check('lifecycle.browse_side_effect_detected', browseSideEffect.status === 'FAIL');
const analyticsFixtureAttempts = [
  { question_id: 'q-1', is_correct: false, answered_at: '2026-01-03T00:00:00Z' },
  { question_id: 'q-1', is_correct: true, answered_at: '2026-01-01T00:00:00Z' },
  { question_id: 'q-2', is_correct: true, answered_at: '2026-01-02T00:00:00Z' },
];
const analyticsFixtureLearning = [{ question_id: 'q-1', marked_for_review: true }, { question_id: 'q-3', bookmarked: true, recall_due_at: '2020-01-01T00:00:00Z' }];
const analyticsFixturePopulations = { all: ['q-1', 'q-2', 'q-3'], attempted: ['q-1', 'q-2'], correct: ['q-2'], incorrect: ['q-1'], bookmarked: ['q-3'], marked: ['q-1'], recall_due: ['q-3'] };
const analyticsPopulation = validateAnalyticsDrilldown({ questionIds: ['q-1', 'q-2', 'q-3'], attempts: analyticsFixtureAttempts, learning: analyticsFixtureLearning, populations: analyticsFixturePopulations, breakdowns: { platform: { 'p-1': ['q-1', 'q-2', 'q-3'] }, subject: { 's-1': ['q-1', 'q-2', 'q-3'] } } });
check('analytics.exact_contributing_populations', analyticsPopulation.status === 'PASS');
const analyticsLeak = validateAnalyticsDrilldown({ questionIds: ['q-1'], attempts: [{ question_id: 'q-1', is_correct: false }], populations: { all: ['q-1'], attempted: ['q-1'], correct: [], incorrect: ['q-1', 'q-2'], bookmarked: [], marked: [], recall_due: [] } });
check('analytics.unrelated_question_detected', analyticsLeak.status === 'FAIL');
const derivedAnalytics = deriveAnalyticsPopulations({ questionIds: ['q-1', 'q-2', 'q-3'], attempts: analyticsFixtureAttempts, learning: analyticsFixtureLearning });
check('analytics.latest_answer_not_attempt_accuracy', derivedAnalytics.incorrect.join() === 'q-1' && derivedAnalytics.correct.join() === 'q-2' && derivedAnalytics.totalAttempts === 3);
const redundantTaxonomy = [
  { id: 'q-1', topic_ids: ['topic-local'], subtopic_ids: ['subtopic-local'] },
  { id: 'q-2', topic_ids: ['topic-regional'], subtopic_ids: ['subtopic-regional'] },
];
check('analytics.redundant_topic_subtopic_detected', analyticsTopicSubtopicRedundant({
  questionIndex: redundantTaxonomy, questionIds: ['q-1', 'q-2'],
  topics: [{ id: 'topic-local', name: 'Local Anesthetics' }, { id: 'topic-regional', name: 'Regional Anesthesia' }],
  subtopics: [{ id: 'subtopic-local', name: 'Local Anesthetics' }, { id: 'subtopic-regional', name: 'Regional Anesthesia' }],
}));
check('analytics.genuine_subtopic_breakdown_preserved', !analyticsTopicSubtopicRedundant({
  questionIndex: [
    { id: 'q-1', topic_ids: ['topic-limb'], subtopic_ids: ['subtopic-upper'] },
    { id: 'q-2', topic_ids: ['topic-limb'], subtopic_ids: ['subtopic-lower'] },
  ], questionIds: ['q-1', 'q-2'], topics: [{ id: 'topic-limb', name: 'Limbs' }],
  subtopics: [{ id: 'subtopic-upper', name: 'Upper Limb' }, { id: 'subtopic-lower', name: 'Lower Limb' }],
}));
const pyqTaxonomy = buildTaxonomyIndex([
  { id: 'pyq-i-path', platform_id: 'prepladder', subject_id: 'pathology', is_pyq: true, is_inicet: true, exam_year: 2025, exam_shift: 'May', question_topics: [{ topic_id: 'path-topic' }], question_subtopics: [{ subtopic_id: 'path-subtopic' }] },
  { id: 'pyq-n-path', platform_id: 'cerebellum', subject_id: 'pathology', is_pyq: true, is_neet_pg: true, exam_year: 2024, exam_shift: 'August', question_topics: [{ topic_id: 'path-topic' }], question_subtopics: [{ subtopic_id: 'path-subtopic' }] },
  { id: 'pyq-i-anes', platform_id: 'cerebellum', subject_id: 'anesthesia', is_pyq: true, is_inicet: true, exam_year: 2024, exam_shift: 'May', question_topics: [{ topic_id: 'local-topic' }], question_subtopics: [{ subtopic_id: 'local-subtopic' }] },
  { id: 'non-pyq', platform_id: 'cerebellum', subject_id: 'anesthesia', is_pyq: false, question_topics: [{ topic_id: 'regional-topic' }], question_subtopics: [{ subtopic_id: 'regional-subtopic' }] },
]);
const sameIds = (actual, expected) => [...actual].sort().join('|') === [...expected].sort().join('|');
check('analytics.pyq_only', sameIds(filterAnalyticsPopulation(pyqTaxonomy, { pyq: 'yes' }), ['pyq-i-path', 'pyq-n-path', 'pyq-i-anes']));
check('analytics.non_pyq_only', sameIds(filterAnalyticsPopulation(pyqTaxonomy, { pyq: 'no' }), ['non-pyq']));
check('analytics.inicet_only', sameIds(filterAnalyticsPopulation(pyqTaxonomy, { exams: ['inicet'] }), ['pyq-i-path', 'pyq-i-anes']));
check('analytics.neet_pg_only', sameIds(filterAnalyticsPopulation(pyqTaxonomy, { exams: ['neet_pg'] }), ['pyq-n-path']));
check('analytics.multiple_exam_union', sameIds(filterAnalyticsPopulation(pyqTaxonomy, { exams: ['inicet', 'neet_pg'] }), ['pyq-i-path', 'pyq-n-path', 'pyq-i-anes']));
const pathologyPopulation = resolveTaxonomyCascade(pyqTaxonomy, { subjects: ['pathology'] }).matchingQuestionIds;
check('analytics.exam_plus_subject', sameIds(filterAnalyticsPopulation(pyqTaxonomy.filter((row) => pathologyPopulation.includes(row.id)), { exams: ['inicet'] }), ['pyq-i-path']));
const localPopulation = resolveTaxonomyCascade(pyqTaxonomy, { topics: ['local-topic'], subtopics: ['local-subtopic'] }).matchingQuestionIds;
check('analytics.exam_plus_topic_subtopic', sameIds(filterAnalyticsPopulation(pyqTaxonomy.filter((row) => localPopulation.includes(row.id)), { exams: ['inicet'] }), ['pyq-i-anes']));
check('analytics.year_filter', sameIds(filterAnalyticsPopulation(pyqTaxonomy, { years: ['2024'] }), ['pyq-n-path', 'pyq-i-anes']));
check('analytics.session_filter', sameIds(filterAnalyticsPopulation(pyqTaxonomy, { sessions: ['May'] }), ['pyq-i-path', 'pyq-i-anes']));
const pyqCapabilities = analyticsMetadataCapabilities(pyqTaxonomy);
check('analytics.exam_year_session_capabilities', sameIds(pyqCapabilities.exams, ['inicet', 'neet_pg']) && sameIds(pyqCapabilities.years, ['2024', '2025']) && sameIds(pyqCapabilities.sessions, ['August', 'May']));
check('analytics.zero_population_has_no_metadata_leakage', analyticsMetadataCapabilities(pyqTaxonomy, []).exams.length === 0);
const pyqState = deriveAnalyticsPopulations({ questionIds: ['pyq-i-path', 'pyq-i-anes'], attempts: [{ question_id: 'pyq-i-path', is_correct: false, answered_at: '2026-01-01' }], learning: [{ question_id: 'pyq-i-anes', bookmarked: true }] });
check('analytics.exam_plus_incorrect', sameIds(pyqState.incorrect, ['pyq-i-path']));
check('analytics.exam_plus_bookmark', sameIds(pyqState.bookmarked, ['pyq-i-anes']));

const prepSourceTaxonomy = buildTaxonomyIndex([
  { id: 'prep-pyq-1', platform_id: 'prep', subject_id: 'anaesthesia', source_test_ids: ['test-pyq'], pyq_source_test_ids: ['test-pyq'], non_pyq_source_test_ids: [], is_pyq: true },
  { id: 'prep-pyq-2', platform_id: 'prep', subject_id: 'anaesthesia', source_test_ids: ['test-pyq-2'], pyq_source_test_ids: ['test-pyq-2'], non_pyq_source_test_ids: [], is_pyq: true },
  { id: 'prep-standard', platform_id: 'prep', subject_id: 'anaesthesia', source_test_ids: ['test-standard'], pyq_source_test_ids: [], non_pyq_source_test_ids: ['test-standard'], is_pyq: false },
  { id: 'quarantined', platform_id: 'prep', subject_id: 'anaesthesia', source_test_ids: ['test-standard'], is_usable: false },
]);
check('prepladder.source_test_single_isolation', sameIds(filterAnalyticsPopulation(prepSourceTaxonomy, { source_tests: ['test-pyq'] }), ['prep-pyq-1']));
check('prepladder.source_test_multiselect_union', sameIds(filterAnalyticsPopulation(prepSourceTaxonomy, { source_tests: ['test-pyq', 'test-standard'] }), ['prep-pyq-1', 'prep-standard']));
check('prepladder.pyq_with_source_test_intersection', sameIds(filterAnalyticsPopulation(prepSourceTaxonomy, { source_tests: ['test-pyq'], pyq: 'yes' }), ['prep-pyq-1']));
check('prepladder.non_pyq_excludes_pyq_source_tests', sameIds(filterAnalyticsPopulation(prepSourceTaxonomy, { pyq: 'no' }), ['prep-standard']));
check('prepladder.unusable_excluded_from_all_populations', !prepSourceTaxonomy.some((row) => row.id === 'quarantined'));
const qbankIdsForFixture = filterAnalyticsPopulation(prepSourceTaxonomy, { source_tests: ['test-pyq', 'test-standard'], pyq: 'yes' });
const analyticsIdsForFixture = filterAnalyticsPopulation(prepSourceTaxonomy, { source_tests: ['test-pyq', 'test-standard'], pyq: 'yes' });
check('analytics.qbank_exact_question_set_equality', sameIds(qbankIdsForFixture, analyticsIdsForFixture));

const taxonomy = buildTaxonomyIndex([
  { id: 'qa-1', platform_id: 'cerebellum', subject_id: 'anatomy', system_id: 'anatomy-system', question_topics: [{ topic_id: 'anatomy-topic' }], question_subtopics: [{ subtopic_id: 'anatomy-subtopic' }] },
  { id: 'qn-1', platform_id: 'cerebellum', subject_id: 'anesthesia', system_id: 'anesthesia-system', question_topics: [{ topic_id: 'anesthesia-topic' }], question_subtopics: [{ subtopic_id: 'anesthesia-subtopic' }] },
  { id: 'qn-2', platform_id: 'cerebellum', subject_id: 'anesthesia', system_id: '', question_topics: [{ topic_id: 'anesthesia-topic-2' }], question_subtopics: [{ subtopic_id: 'anesthesia-subtopic-2' }] },
  { id: 'qa-2', platform_id: 'other-platform', subject_id: 'anatomy', system_id: 'other-anatomy-system', question_topics: [{ topic_id: 'other-anatomy-topic' }], question_subtopics: [{ subtopic_id: 'other-anatomy-subtopic' }] },
  { id: 'qn-3', platform_id: 'other-platform', subject_id: 'anesthesia', system_id: 'other-anesthesia-system', question_topics: [{ topic_id: 'other-anesthesia-topic' }], question_subtopics: [{ subtopic_id: 'other-anesthesia-subtopic' }] },
]);
const cascade = (selection) => resolveTaxonomyCascade(taxonomy, selection);
const equals = (actual, expected) => [...actual].sort().join('|') === [...expected].sort().join('|');

let cascadeResult = cascade({ platforms: ['cerebellum'], subjects: ['anesthesia'] });
check('cascade.one_platform_one_subject', equals(cascadeResult.valid.topics, ['anesthesia-topic', 'anesthesia-topic-2']));
cascadeResult = cascade({ platforms: ['cerebellum'], subjects: ['anatomy', 'anesthesia'] });
check('cascade.one_platform_multiple_subjects_union', equals(cascadeResult.valid.topics, ['anatomy-topic', 'anesthesia-topic', 'anesthesia-topic-2']));
cascadeResult = cascade({ platforms: ['cerebellum', 'other-platform'], subjects: ['anesthesia'] });
check('cascade.multiple_platforms_one_subject_union', equals(cascadeResult.valid.topics, ['anesthesia-topic', 'anesthesia-topic-2', 'other-anesthesia-topic']));
cascadeResult = cascade({ platforms: ['cerebellum', 'other-platform'], subjects: ['anatomy', 'anesthesia'] });
check('cascade.multiple_platforms_multiple_subjects_union', cascadeResult.matchingQuestionIds.length === 5);
cascadeResult = cascade({ platforms: ['cerebellum'], subjects: ['anesthesia'], topics: ['anesthesia-topic'] });
check('cascade.platform_subject_topic_narrows_subtopics', equals(cascadeResult.valid.subtopics, ['anesthesia-subtopic']));
cascadeResult = cascade({ platforms: ['cerebellum'], subjects: ['anesthesia'], subtopics: ['anesthesia-subtopic-2'] });
check('cascade.platform_subject_subtopic', equals(cascadeResult.matchingQuestionIds, ['qn-2']));
cascadeResult = cascade({ platforms: ['cerebellum'], subjects: ['anesthesia'], systems: ['anesthesia-system'], topics: ['anesthesia-topic'], subtopics: ['anesthesia-subtopic'] });
check('cascade.full_system_topic_subtopic_path', equals(cascadeResult.matchingQuestionIds, ['qn-1']));
cascadeResult = cascade({ platforms: ['cerebellum'], subjects: ['anesthesia'], systems: ['anatomy-system'], topics: ['anatomy-topic'], subtopics: ['anatomy-subtopic'] });
check('cascade.upstream_change_prunes_invalid_downstream', !cascadeResult.selected.systems.length && !cascadeResult.selected.topics.length && !cascadeResult.selected.subtopics.length && !cascadeResult.valid.topics.has('anatomy-topic'));
cascadeResult = cascade({});
check('cascade.clearing_filters_restores_all_valid_choices', cascadeResult.matchingQuestionIds.length === 5 && cascadeResult.valid.platforms.size === 2 && cascadeResult.valid.subjects.size === 2);
check('cascade.zero_mapping_taxonomy_hidden', !cascadeResult.valid.topics.has('orphan-topic') && !cascadeResult.valid.subtopics.has('orphan-subtopic'));
cascadeResult = cascade({ platforms: ['cerebellum'], subjects: ['anesthesia'] });
check('regression.cerebellum_anesthesia_excludes_anatomy', !cascadeResult.valid.topics.has('anatomy-topic') && !cascadeResult.valid.subtopics.has('anatomy-subtopic'));
cascadeResult = cascade({ platforms: ['cerebellum'], subjects: ['anatomy'] });
check('regression.cerebellum_anatomy_excludes_anesthesia', !cascadeResult.valid.topics.has('anesthesia-topic') && !cascadeResult.valid.subtopics.has('anesthesia-subtopic'));
check('analytics.filter_platform_only', equals(cascade({ platforms: ['cerebellum'] }).matchingQuestionIds, ['qa-1', 'qn-1', 'qn-2']));
check('analytics.filter_subject_only', equals(cascade({ subjects: ['anatomy'] }).matchingQuestionIds, ['qa-1', 'qa-2']));
check('analytics.filter_topic_only', equals(cascade({ topics: ['anesthesia-topic'] }).matchingQuestionIds, ['qn-1']));
check('analytics.filter_multiple_topics_union', equals(cascade({ topics: ['anatomy-topic', 'anesthesia-topic'] }).matchingQuestionIds, ['qa-1', 'qn-1']));
check('analytics.filter_subtopic_only', equals(cascade({ subtopics: ['anesthesia-subtopic-2'] }).matchingQuestionIds, ['qn-2']));
check('analytics.filter_multiple_subtopics_union', equals(cascade({ subtopics: ['anatomy-subtopic', 'anesthesia-subtopic'] }).matchingQuestionIds, ['qa-1', 'qn-1']));
check('analytics.invalid_child_pruned_without_leakage', cascade({ platforms: ['cerebellum'], subjects: ['anatomy'], topics: ['anesthesia-topic'] }).matchingQuestionIds.length === 1 && cascade({ platforms: ['cerebellum'], subjects: ['anatomy'], topics: ['anesthesia-topic'] }).selected.topics.length === 0);
check('analytics.zero_status_result_preserved', deriveAnalyticsPopulations({ questionIds: ['qa-1'], attempts: [], learning: [] }).bookmarked.length === 0);
for (const [caseName, selection] of Object.entries({ platform: { platforms: ['cerebellum'] }, subject: { subjects: ['anesthesia'] }, topic: { topics: ['anesthesia-topic'] }, subtopic: { subtopics: ['anesthesia-subtopic'] } })) {
  const selectedIds = cascade(selection).matchingQuestionIds;
  const fixture = deriveAnalyticsPopulations({ questionIds: selectedIds, attempts: selectedIds.map((id, index) => ({ question_id: id, is_correct: index % 2 === 0, answered_at: `2026-01-0${index + 1}T00:00:00Z` })), learning: selectedIds.map((id, index) => ({ question_id: id, bookmarked: index === 0, marked_for_review: index === 1, recall_due_at: index === 0 ? '2020-01-01T00:00:00Z' : null })) });
  for (const status of ['all', 'attempted', 'incorrect', 'correct', 'bookmarked', 'marked', 'recall_due']) check(`analytics.status_${status}_within_${caseName}`, fixture[status].every((id) => selectedIds.includes(id)));
}
const largeTaxonomy = buildTaxonomyIndex(Array.from({ length: 60000 }, (_, index) => ({
  id: `large-${index}`, platform_id: `p-${index % 3}`, subject_id: `s-${index % 19}`,
  system_id: `sys-${index % 7}`, question_topics: [{ topic_id: `topic-${index % 200}` }],
  question_subtopics: [{ subtopic_id: `subtopic-${index % 1000}` }],
})));
const largeCascade = resolveTaxonomyCascade(largeTaxonomy, { platforms: ['p-1'], subjects: ['s-1', 's-2'] });
const largeById = new Map(largeTaxonomy.map((item) => [item.id, item]));
check('cascade.sixty_thousand_mapping_rows', largeCascade.matchingQuestionIds.length > 0 && largeCascade.matchingQuestionIds.every((id) => {
  const item = largeById.get(id); return item.platform_id === 'p-1' && ['s-1', 's-2'].includes(item.subject_id);
}));

const appSource = readFileSync(resolve(root, 'app/app.js'), 'utf8');
const stylesSource = readFileSync(resolve(root, 'app/styles.css'), 'utf8');
const domRegressionSource = readFileSync(resolve(root, 'app/taxonomy-dom-regression.js'), 'utf8');
const importerSource = readFileSync(resolve(root, 'scripts/qbank_import.py'), 'utf8');
const importerMigration = readFileSync(resolve(root, 'supabase/migrations/202608280003_qbank_import_pipeline.sql'), 'utf8');
const prepImporterSource = readFileSync(resolve(root, 'scripts/prepladder_import.py'), 'utf8');
const prepImporterMigration = readFileSync(resolve(root, 'supabase/migrations/202609010001_prepladder_hybrid_import.sql'), 'utf8');
const pilotCorrectionMigration = readFileSync(resolve(root, 'supabase/migrations/202609020001_prepladder_pilot_analytics_correction.sql'), 'utf8');
check('frontend.canonical_learning_state_table', !appSource.includes("from('question_learning_state')"), 'expected user_question_state');
check('frontend.live_session_total_columns', !/\bquestion_count\b|\bcorrect_count\b/.test(appSource), 'expected total_questions/total_correct');
check('frontend.generated_set_guard_installed', appSource.includes('validateGeneratedQuestionSet'));
check('frontend.resume_guard_installed', appSource.includes('validateResumeSnapshot'));
check('frontend.ui_count_uses_database_count', /updateMatchCount[\s\S]*matchingCount\(readFilters\(form\)\)/.test(appSource));
check('frontend.stale_filter_counts_cannot_overwrite_current_count', appSource.includes('filterCountRequests.get(form) !== requestId'));
check('frontend.live_taxonomy_columns', !/subtopics'\)\.select\('id,name,subject_id,topic_id'\)|order\('display_order'\)/.test(appSource), 'expected platform_subject_id/sort_order');
check('frontend.session_persists_subtopic_filters', /test_sessions'\)\.insert\([\s\S]*filters/.test(appSource));
check('frontend.analytics_preserves_subtopic_context', appSource.includes("subtopic: ['subtopic_ids'"));
check('frontend.retake_preserves_filter_context', /preset: state\.active\.preset[\s\S]*filters: state\.active\.filters/.test(appSource));
check('frontend.ready_defers_session_creation', /function readyScreen[\s\S]*start-pending-test[\s\S]*async function createSession[\s\S]*readyScreen\(await prepareQuestionSet[\s\S]*async function startPendingSession[\s\S]*test_sessions'\)\.insert/.test(appSource));
check('frontend.browse_has_no_timer_or_session', /kind: 'browse'[\s\S]*questionStartedAt: null[\s\S]*if \(!browsing\) startQuestionTimer\(\)/.test(appSource));
check('frontend.shared_exact_question_set_actions', appSource.includes('prepareQuestionSet') && appSource.includes('actionSetButtons') && appSource.includes('questionIds: selectedIds'));
check('frontend.same_hash_origin_rerenders', /const goToHash = \(target\) => \{ if \(location\.hash === target\) render\(\)/.test(appSource));
check('frontend.review_taxonomy_multiselect', appSource.includes('id="review-filter-form"') && appSource.includes("multiPicker('subtopics'"));
check('frontend.analytics_exact_drilldowns', appSource.includes('await matchingQuestionIds(normalizedFilters)') && appSource.includes('questionIds: ids') && appSource.includes('Review Questions') && appSource.includes('Start Test'));
check('frontend.analytics_dependent_multiselect', appSource.includes('id="analytics-filter-form"') && appSource.includes("setupDependentFilters(form)"));
check('frontend.analytics_simplified_default', appSource.includes('<h1>Overall performance</h1>') && appSource.includes('analytics-primary-metrics') && appSource.includes('Questions attempted') && appSource.includes('Currently incorrect') && appSource.includes('Average time'));
check('frontend.analytics_secondary_and_more_details', appSource.includes('analytics-secondary') && appSource.includes('Marked for Review') && appSource.includes('Recall Due') && appSource.includes('analytics-more-details') && appSource.includes('Total attempts'));
check('frontend.analytics_one_breakdown_at_a_time', appSource.includes('select-analytics-breakdown') && appSource.includes('id="analytics-breakdown-selected"') && !appSource.includes('load-analytics-breakdown'));
check('frontend.analytics_breakdowns_lazy_and_paged', appSource.includes('slice(0, page * 50)') && appSource.includes('Show next'));
check('frontend.analytics_row_actions_progressively_disclosed', appSource.includes('<details class="analytics-breakdown-row">') && appSource.includes('<div class="analytics-row-detail">'));
check('frontend.analytics_redundancy_is_mapping_based', appSource.includes('analyticsTopicSubtopicRedundant({ questionIndex: state.meta.questionTaxonomy'));
check('frontend.analytics_mobile_layout', stylesSource.includes('.analytics-primary-metrics { grid-template-columns: 1fr; }') && stylesSource.includes('.analytics-breakdown-row > summary { grid-template-columns: 1fr; }'));
check('frontend.analytics_status_defines_population', appSource.includes('analyticsStatusPicker()') && appSource.includes('await matchingQuestionIds(normalizedFilters)') && !appSource.includes('data-analytics-status'));
check('frontend.analytics_single_universal_action_pair', appSource.includes('Review Questions') && appSource.includes('Start Test') && /function analyticsPopulationControls\(population\)[\s\S]*analyticsActionButtons\(population\)/.test(appSource));
check('frontend.analytics_pyq_non_pyq_architecture', appSource.includes('<option value="yes">PYQ only</option>') && appSource.includes('<option value="no">Non-PYQ</option>') && appSource.includes("is_inicet") && appSource.includes("is_neet_pg"));
check('frontend.analytics_exam_year_session_contextual', appSource.includes("multiPicker('exams'") && appSource.includes("multiPicker('years'") && appSource.includes("multiPicker('sessions'") && !appSource.includes("['exam', 'Exam']") && !appSource.includes("['year_session', 'Year / session']"));
check('frontend.analytics_srm_readiness_without_scheduler', appSource.includes('analytics-srm-ready') && appSource.includes('Available when SRM state exists') && !appSource.includes('START SRM'));
check('frontend.analytics_context_aware_breakdowns', appSource.includes('analyticsGroups(level).length > 1') && appSource.includes('This selection has no useful multi-group breakdown'));
check('frontend.analytics_no_default_breakdown_rows', appSource.includes('No rows are rendered by default.') && !/if \(!state\.analyticsBreakdown\) renderAnalyticsBreakdown/.test(appSource));
check('frontend.analytics_lightweight_taxonomy_metadata', appSource.includes("select('id,platform_id,subject_id,system_id,is_usable,is_pyq,is_inicet,is_neet_pg,exam_tags,exam_year,exam_shift,question_topics(topic_id),question_subtopics(subtopic_id)')"));
check('prepladder.canonical_subject_guard', pilotCorrectionMigration.includes("set name='Anaesthesia'") && pilotCorrectionMigration.includes('subjects_one_anaesthesia_alias'));
check('prepladder.four_source_questions_quarantined', pilotCorrectionMigration.includes("'846800','846703','846768','846764'") && pilotCorrectionMigration.includes("SOURCE_CONTENT_INCOMPLETE"));
check('prepladder.future_blank_options_rejected', prepImporterSource.includes('blank required option content'));
check('frontend.mapping_based_taxonomy_cascade', appSource.includes('resolveTaxonomyCascade(state.meta.questionTaxonomy'));
check('frontend.hidden_taxonomy_rows_not_displayed', /row\.hidden = !visible;[\s\S]*row\.style\.display = visible \? '' : 'none'/.test(appSource));
check('frontend.hidden_attribute_overrides_check_row_display', /html\s+\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/.test(stylesSource));
check('browser.taxonomy_dom_regression_installed', appSource.includes('runTaxonomyDomRegression')
  && appSource.includes('dataset.qbankDomRegression')
  && domRegressionSource.includes('getComputedStyle')
  && domRegressionSource.includes('getBoundingClientRect')
  && domRegressionSource.includes('anesthesiaIsolation')
  && domRegressionSource.includes('anatomyIsolation')
  && domRegressionSource.includes('mixedUnion')
  && domRegressionSource.includes('invalidChildPruning')
  && domRegressionSource.includes('zeroCountLabelsHidden'));
check('frontend.cascade_modules_cache_busted', appSource.includes("./validation.js?v=20260902-pilot-analytics")
  && readFileSync(resolve(root, 'index.html'), 'utf8').includes('./app/app.js?v=20260902-pilot-analytics'));
const importerTests = spawnSync('python3', ['-m', 'unittest', 'scripts.tests.test_qbank_import'], { cwd: root, encoding: 'utf8' });
check('importer.fixture_and_scale_tests', importerTests.status === 0, (importerTests.stderr || importerTests.stdout || '').trim().split('\n').slice(-1)[0] || 'python unittest');
check('importer.dry_run_default_is_read_only', /database_modified["']?:?\s*False/.test(importerSource) && /--confirm-import/.test(importerSource));
check('importer.classifies_all_safety_states', ['NEW', 'EXACT EXISTING MATCH', 'POSSIBLE DUPLICATE', 'INVALID', 'CONFLICT'].every((value) => importerSource.includes(value)));
check('importer.transactional_service_role_only_rpc', /security invoker/i.test(importerMigration) && /revoke all on function public\.qbank_import_batch\(jsonb\) from public, anon, authenticated/i.test(importerMigration) && /grant execute on function public\.qbank_import_batch\(jsonb\) to service_role/i.test(importerMigration));
const prepImporterTests = spawnSync('python3', ['-m', 'unittest', 'scripts.tests.test_prepladder_import'], { cwd: root, encoding: 'utf8' });
check('prepladder.fixture_structure_dedup_media_multicorrect', prepImporterTests.status === 0, (prepImporterTests.stderr || prepImporterTests.stdout || '').trim().split('\n').slice(-1)[0] || 'python unittest');
check('prepladder.master_source_is_not_tracked', !existsSync(resolve(root, 'import-source/PREP_q_banks.html')) && readFileSync(resolve(root, '.gitignore'), 'utf8').split(/\r?\n/).includes('import-source/'));
check('prepladder.dry_run_default_and_pilot_guard', /Dry-run is the default/i.test(prepImporterSource) && /pilot safety boundary permits Anaesthesia only/.test(prepImporterSource) && /SUPABASE_SERVICE_ROLE_KEY/.test(prepImporterSource));
check('prepladder.hybrid_payload_hydration_installed', appSource.includes('hydrateHybridQuestions') && appSource.includes("storage.from('qbank-payloads').download") && appSource.includes('DecompressionStream'));
check('prepladder.source_test_order_and_filter_installed', appSource.includes("multiPicker('source_tests'") && appSource.includes("from('qbank_source_occurrences')") && appSource.includes('question_position'));
check('prepladder.multi_correct_rendering_installed', appSource.includes('correct_option_keys') && appSource.includes('submit-multi-answer') && appSource.includes('isAnswerCorrect'));
check('prepladder.migration_is_additive_private_and_service_only', /create table if not exists public\.qbank_question_payloads/i.test(prepImporterMigration) && /values \('qbank-payloads','qbank-payloads',false/i.test(prepImporterMigration) && /grant execute on function public\.qbank_commit_prepladder_import\(jsonb\) to service_role/i.test(prepImporterMigration));
check('prepladder.two_phase_storage_verification', prepImporterSource.includes('upload_and_verify') && prepImporterSource.includes('delete_objects') && prepImporterMigration.includes("payload object is missing or its stored byte count differs"));
check('prepladder.import_run_table_does_not_collide', prepImporterMigration.includes('qbank_hybrid_import_runs') && !/create table if not exists public\.qbank_import_runs/.test(prepImporterMigration));
check('importer.protected_study_state_guard', importerMigration.includes('protected learner state changed during import'));

for (const row of rows) console.log(`${row.status} — ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);

let failed = rows.some((row) => row.status === 'FAIL');
if (process.argv.includes('--database')) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('FAIL — database.connection — DATABASE_URL is required with --database');
    failed = true;
  } else {
    const sqlFile = resolve(here, 'qbank-validation.sql');
    const run = spawnSync(process.env.PSQL_BIN || 'psql', [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off', '-f', sqlFile], { encoding: 'utf8' });
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    if (run.error || run.status !== 0 || /\bFAIL\b/.test(run.stdout || '')) failed = true;
  }
}

const passed = rows.filter((row) => row.status === 'PASS').length;
console.log(`${failed ? 'FAIL' : 'PASS'} — qbank validation summary — ${passed}/${rows.length} local checks passed`);
process.exitCode = failed ? 1 : 0;
