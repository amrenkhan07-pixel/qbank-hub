#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateGeneratedQuestionSet, validateQuestionStateBindings, validateResumeSnapshot } from '../app/validation.js';

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

const appSource = readFileSync(resolve(root, 'app/app.js'), 'utf8');
check('frontend.canonical_learning_state_table', !appSource.includes("from('question_learning_state')"), 'expected user_question_state');
check('frontend.live_session_total_columns', !/\bquestion_count\b|\bcorrect_count\b/.test(appSource), 'expected total_questions/total_correct');
check('frontend.generated_set_guard_installed', appSource.includes('validateGeneratedQuestionSet'));
check('frontend.resume_guard_installed', appSource.includes('validateResumeSnapshot'));
check('frontend.ui_count_uses_database_count', /updateMatchCount[\s\S]*matchingCount\(readFilters\(form\)\)/.test(appSource));

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
