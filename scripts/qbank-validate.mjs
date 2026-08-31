#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildTaxonomyIndex, resolveTaxonomyCascade, validateAnalyticsDrilldown, validateGeneratedQuestionSet, validateQuestionSetLifecycle, validateQuestionStateBindings, validateResumeSnapshot } from '../app/validation.js';

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
const analyticsPopulation = validateAnalyticsDrilldown({ attempts: [{ question_id: 'q-1', is_correct: false }, { question_id: 'q-1', is_correct: true }, { question_id: 'q-2', is_correct: false }], allQuestionIds: ['q-1', 'q-2'], correctQuestionIds: ['q-1'], incorrectQuestionIds: ['q-1', 'q-2'] });
check('analytics.exact_contributing_populations', analyticsPopulation.status === 'PASS');
const analyticsLeak = validateAnalyticsDrilldown({ attempts: [{ question_id: 'q-1', is_correct: false }], allQuestionIds: ['q-1'], correctQuestionIds: [], incorrectQuestionIds: ['q-1', 'q-2'] });
check('analytics.unrelated_question_detected', analyticsLeak.status === 'FAIL');

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
check('frontend.canonical_learning_state_table', !appSource.includes("from('question_learning_state')"), 'expected user_question_state');
check('frontend.live_session_total_columns', !/\bquestion_count\b|\bcorrect_count\b/.test(appSource), 'expected total_questions/total_correct');
check('frontend.generated_set_guard_installed', appSource.includes('validateGeneratedQuestionSet'));
check('frontend.resume_guard_installed', appSource.includes('validateResumeSnapshot'));
check('frontend.ui_count_uses_database_count', /updateMatchCount[\s\S]*matchingCount\(readFilters\(form\)\)/.test(appSource));
check('frontend.stale_filter_counts_cannot_overwrite_current_count', appSource.includes('filterCountRequests.get(form) !== requestId'));
check('frontend.live_taxonomy_columns', !/subtopics'\)\.select\('id,name,subject_id,topic_id'\)|order\('display_order'\)/.test(appSource), 'expected platform_subject_id/sort_order');
check('frontend.session_persists_subtopic_filters', /test_sessions'\)\.insert\([\s\S]*filters/.test(appSource));
check('frontend.analytics_preserves_subtopic_context', appSource.includes("aggregate('subtopic_ids', true)"));
check('frontend.retake_preserves_filter_context', /preset: state\.active\.preset[\s\S]*filters: state\.active\.filters/.test(appSource));
check('frontend.ready_defers_session_creation', /function readyScreen[\s\S]*start-pending-test[\s\S]*async function createSession[\s\S]*readyScreen\(await prepareQuestionSet[\s\S]*async function startPendingSession[\s\S]*test_sessions'\)\.insert/.test(appSource));
check('frontend.browse_has_no_timer_or_session', /kind: 'browse'[\s\S]*questionStartedAt: null[\s\S]*if \(!browsing\) startQuestionTimer\(\)/.test(appSource));
check('frontend.shared_exact_question_set_actions', appSource.includes('prepareQuestionSet') && appSource.includes('actionSetButtons') && appSource.includes('questionIds: selectedIds'));
check('frontend.same_hash_origin_rerenders', /const goToHash = \(target\) => \{ if \(location\.hash === target\) render\(\)/.test(appSource));
check('frontend.review_taxonomy_multiselect', appSource.includes('id="review-filter-form"') && appSource.includes("multiPicker('subtopics'"));
check('frontend.analytics_exact_drilldowns', appSource.includes('value.incorrectIds') && appSource.includes('value.correctIds') && appSource.includes("aggregate('subtopic_ids', true)"));
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
check('frontend.cascade_modules_cache_busted', appSource.includes("./validation.js?v=20260828-learning-flow")
  && readFileSync(resolve(root, 'index.html'), 'utf8').includes('./app/app.js?v=20260828-learning-flow'));
const importerTests = spawnSync('python3', ['-m', 'unittest', 'scripts.tests.test_qbank_import'], { cwd: root, encoding: 'utf8' });
check('importer.fixture_and_scale_tests', importerTests.status === 0, (importerTests.stderr || importerTests.stdout || '').trim().split('\n').slice(-1)[0] || 'python unittest');
check('importer.dry_run_default_is_read_only', /database_modified["']?:?\s*False/.test(importerSource) && /--confirm-import/.test(importerSource));
check('importer.classifies_all_safety_states', ['NEW', 'EXACT EXISTING MATCH', 'POSSIBLE DUPLICATE', 'INVALID', 'CONFLICT'].every((value) => importerSource.includes(value)));
check('importer.transactional_service_role_only_rpc', /security invoker/i.test(importerMigration) && /revoke all on function public\.qbank_import_batch\(jsonb\) from public, anon, authenticated/i.test(importerMigration) && /grant execute on function public\.qbank_import_batch\(jsonb\) to service_role/i.test(importerMigration));
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
