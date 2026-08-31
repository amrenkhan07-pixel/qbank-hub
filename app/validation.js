const cleanText = (value) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const asSet = (value) => value instanceof Set ? value : new Set(value || []);
const ids = (questions) => (questions || []).map((question) => String(question.id));

const stringIds = (values) => [...new Set((values || []).map(String).filter(Boolean))];

export function buildTaxonomyIndex(questionRows = []) {
  return (questionRows || []).map((question) => ({
    id: String(question.id),
    platform_id: String(question.platform_id || ''),
    subject_id: String(question.subject_id || ''),
    system_id: String(question.system_id || ''),
    topic_ids: stringIds((question.question_topics || question.topic_ids || []).map((item) => item?.topic_id ?? item)),
    subtopic_ids: stringIds((question.question_subtopics || question.subtopic_ids || []).map((item) => item?.subtopic_id ?? item)),
  })).filter((question) => question.id && question.platform_id && question.subject_id);
}

export function resolveTaxonomyCascade(questionIndex = [], selection = {}) {
  const selected = {
    platforms: stringIds(selection.platforms), subjects: stringIds(selection.subjects),
    systems: stringIds(selection.systems), topics: stringIds(selection.topics),
    subtopics: stringIds(selection.subtopics),
  };
  const valid = {};
  const keepValid = (level) => { selected[level] = selected[level].filter((id) => valid[level].has(id)); };
  const matches = (value, choices) => !choices.length || choices.includes(value);
  const intersects = (values, choices) => !choices.length || values.some((value) => choices.includes(value));

  valid.platforms = new Set(questionIndex.map((question) => question.platform_id).filter(Boolean));
  keepValid('platforms');
  let candidates = questionIndex.filter((question) => matches(question.platform_id, selected.platforms));

  valid.subjects = new Set(candidates.map((question) => question.subject_id).filter(Boolean));
  keepValid('subjects');
  candidates = candidates.filter((question) => matches(question.subject_id, selected.subjects));

  valid.systems = new Set(candidates.map((question) => question.system_id).filter(Boolean));
  keepValid('systems');
  candidates = candidates.filter((question) => matches(question.system_id, selected.systems));

  valid.topics = new Set(candidates.flatMap((question) => question.topic_ids));
  keepValid('topics');
  candidates = candidates.filter((question) => intersects(question.topic_ids, selected.topics));

  valid.subtopics = new Set(candidates.flatMap((question) => question.subtopic_ids));
  keepValid('subtopics');
  candidates = candidates.filter((question) => intersects(question.subtopic_ids, selected.subtopics));

  return { valid, selected, matchingQuestionIds: candidates.map((question) => question.id) };
}

function result(check, failures, details = '') {
  return { check, status: failures.length ? 'FAIL' : 'PASS', failures, details };
}

export function validateGeneratedQuestionSet({
  questions = [], filters = {}, requested = 0, matchingCount = 0,
  topicQuestionIds = [], subtopicQuestionIds = [], statusQuestionIds = [],
  allowDuplicates = false,
}) {
  const checks = [];
  const questionIds = ids(questions);
  const requestedNumber = requested === 'all' ? matchingCount : Math.max(0, Number(requested) || 0);
  const expectedCount = Math.min(requestedNumber, matchingCount);
  const duplicateIds = questionIds.filter((id, index) => questionIds.indexOf(id) !== index);
  checks.push(result('generated.no_duplicate_question_ids', allowDuplicates ? [] : [...new Set(duplicateIds)], `${questionIds.length} returned`));
  checks.push(result('generated.zero_result_is_empty', matchingCount === 0 && questions.length ? questionIds : [], `${matchingCount} match`));
  checks.push(result('generated.count_not_above_true_count', questions.length > matchingCount ? questionIds : [], `${questions.length}/${matchingCount}`));
  checks.push(result('generated.requested_count_respected', questions.length === expectedCount ? [] : [`expected ${expectedCount}, got ${questions.length}`], requested === 'all' ? 'all matching' : String(requestedNumber)));

  const directFailures = [];
  const platforms = asSet((filters.platforms || []).map(String));
  const subjects = asSet((filters.subjects || []).map(String));
  const systems = asSet((filters.systems || []).map(String));
  const statuses = asSet(filters.statuses || []);
  for (const question of questions) {
    if (platforms.size && !platforms.has(String(question.platform_id))) directFailures.push(`${question.id}:platform`);
    if (subjects.size && !subjects.has(String(question.subject_id))) directFailures.push(`${question.id}:subject`);
    if (systems.size && !systems.has(String(question.system_id))) directFailures.push(`${question.id}:system`);
    if (filters.pyq === 'yes' && question.is_pyq !== true) directFailures.push(`${question.id}:pyq`);
    if (filters.year && Number(question.exam_year) !== Number(filters.year)) directFailures.push(`${question.id}:year`);
    if (filters.search && !String(question.question_text || '').toLowerCase().includes(String(filters.search).toLowerCase())) directFailures.push(`${question.id}:search`);
    if (filters.source && !String(question.source_reference || '').toLowerCase().includes(String(filters.source).toLowerCase())) directFailures.push(`${question.id}:source`);
    if (statuses.has('my_content') && (question.content_origin !== 'user' || !question.created_by)) directFailures.push(`${question.id}:my_content`);
    if (!statuses.has('my_content') && question.content_origin === 'user') directFailures.push(`${question.id}:personal_content_not_requested`);
  }
  checks.push(result('generated.direct_filters', directFailures));

  const topicIds = asSet(topicQuestionIds.map(String));
  const subtopicIds = asSet(subtopicQuestionIds.map(String));
  const statusIds = asSet(statusQuestionIds.map(String));
  checks.push(result('generated.topic_membership', (filters.topics || []).length ? questionIds.filter((id) => !topicIds.has(id)) : []));
  checks.push(result('generated.subtopic_membership', (filters.subtopics || []).length ? questionIds.filter((id) => !subtopicIds.has(id)) : []));
  checks.push(result('generated.status_membership', statuses.size && !statuses.has('all') ? questionIds.filter((id) => !statusIds.has(id)) : []));

  const contentFailures = [];
  for (const question of questions) {
    const options = question.options || [];
    const keys = options.map((option) => String(option.option_key || '').trim().toUpperCase()).filter(Boolean);
    if (!cleanText(question.question_text)) contentFailures.push(`${question.id}:blank_stem`);
    if (options.length < 2) contentFailures.push(`${question.id}:fewer_than_two_options`);
    if (new Set(keys).size !== options.length) contentFailures.push(`${question.id}:duplicate_or_blank_option_key`);
    if (options.some((option) => !cleanText(option.option_text))) contentFailures.push(`${question.id}:blank_option_text`);
    const correct = String(question.correct_answer || '').trim().charAt(0).toUpperCase();
    if (!correct || !keys.includes(correct)) contentFailures.push(`${question.id}:invalid_correct_answer`);
  }
  checks.push(result('generated.usable_question_structure', contentFailures));
  return { status: checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL', checks };
}

export function validateQuestionStateBindings({ questions = [], answers = {}, bookmarks = [], marked = [] }) {
  const allowed = new Set(ids(questions));
  const attached = [
    ...Object.keys(answers || {}).map((id) => `${id}:answer`),
    ...[...asSet(bookmarks)].map((id) => `${id}:bookmark`),
    ...[...asSet(marked)].map((id) => `${id}:marked`),
  ];
  const failures = attached.filter((entry) => !allowed.has(String(entry.split(':')[0])));
  const check = result('state.attached_to_current_question_ids', failures, `${attached.length} state bindings`);
  return { status: check.status, checks: [check] };
}

export function validateResumeSnapshot({ session = {}, storedRows = [], questions = [], answers = [] }) {
  const checks = [];
  const storedIds = storedRows.map((row) => String(row.question_id));
  const restoredIds = ids(questions);
  const expectedCount = Number(session.total_questions ?? storedRows.length);
  checks.push(result('resume.exact_question_order', storedIds.join('|') === restoredIds.join('|') ? [] : ['stored/restored order differs']));
  checks.push(result('resume.no_duplicate_question_ids', storedIds.length === new Set(storedIds).size ? [] : ['duplicate stored question IDs']));
  checks.push(result('resume.session_count_matches_snapshot', storedRows.length === expectedCount ? [] : [`expected ${expectedCount}, stored ${storedRows.length}`]));
  checks.push(result('resume.answers_belong_to_session', answers.filter((answer) => !storedIds.includes(String(answer.question_id))).map((answer) => String(answer.question_id))));
  const snapshotFailures = storedRows.filter((row) => !cleanText(row.question_snapshot?.question_text) || !Array.isArray(row.question_snapshot?.options) || row.question_snapshot.options.length < 2).map((row) => String(row.question_id));
  checks.push(result('resume.snapshots_are_usable', snapshotFailures));
  return { status: checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL', checks };
}

export function validateQuestionSetLifecycle({
  sourceQuestionIds = [], browseQuestionIds = [], previewQuestionIds = [], sessionQuestionIds = [],
  previewSessionWrites = 0, previewAttemptWrites = 0, previewTimerCount = 0,
  browseSessionWrites = 0, browseAttemptWrites = 0, browseTimerCount = 0,
  startSessionWrites = 1, startTimerCount = 1, targetSeconds = 0, secondsPerQuestion = 50,
}) {
  const source = stringIds(sourceQuestionIds); const browse = stringIds(browseQuestionIds);
  const preview = stringIds(previewQuestionIds); const session = stringIds(sessionQuestionIds);
  const sameOrder = (left, right) => left.join('|') === right.join('|');
  const checks = [
    result('lifecycle.source_has_no_duplicates', source.length === sourceQuestionIds.length ? [] : ['duplicate source IDs']),
    result('lifecycle.browse_uses_exact_source_ids', sameOrder(source, browse) ? [] : ['browse IDs differ']),
    result('lifecycle.preview_uses_exact_source_ids', sameOrder(source, preview) ? [] : ['preview IDs differ']),
    result('lifecycle.started_session_uses_preview_ids', sameOrder(preview, session) ? [] : ['session IDs differ']),
    result('lifecycle.preview_is_read_only', previewSessionWrites === 0 && previewAttemptWrites === 0 ? [] : ['preview wrote session/attempt state']),
    result('lifecycle.preview_has_no_timer', previewTimerCount === 0 ? [] : ['preview timer started']),
    result('lifecycle.browse_is_read_only', browseSessionWrites === 0 && browseAttemptWrites === 0 ? [] : ['browse wrote session/attempt state']),
    result('lifecycle.browse_has_no_timer', browseTimerCount === 0 ? [] : ['browse timer started']),
    result('lifecycle.start_creates_session', startSessionWrites === 1 ? [] : [`expected 1 session write, got ${startSessionWrites}`]),
    result('lifecycle.start_starts_timer', startTimerCount > 0 ? [] : ['start did not start timer']),
    result('lifecycle.target_is_count_times_50', Number(targetSeconds) === source.length * Number(secondsPerQuestion) ? [] : [`${targetSeconds}/${source.length * secondsPerQuestion}`]),
  ];
  return { status: checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL', checks };
}

export function deriveAnalyticsPopulations({ questionIds = [], attempts = [], learning = [] }) {
  const all = stringIds(questionIds); const allowed = new Set(all);
  const ordered = attempts.map((row, index) => ({ ...row, _index: index })).filter((row) => allowed.has(String(row.question_id))).sort((a, b) => {
    const time = new Date(b.answered_at || 0) - new Date(a.answered_at || 0); return time || a._index - b._index;
  });
  const latest = new Map(); ordered.forEach((row) => { const id = String(row.question_id); if (!latest.has(id)) latest.set(id, row); });
  const stateByQuestion = new Map(learning.filter((row) => allowed.has(String(row.question_id))).map((row) => [String(row.question_id), row]));
  const attempted = all.filter((id) => latest.has(id));
  const now = Date.now();
  return {
    all, attempted,
    correct: attempted.filter((id) => latest.get(id)?.is_correct === true),
    incorrect: attempted.filter((id) => latest.get(id)?.is_correct === false),
    bookmarked: all.filter((id) => stateByQuestion.get(id)?.bookmarked === true),
    marked: all.filter((id) => stateByQuestion.get(id)?.marked_for_review === true || stateByQuestion.get(id)?.revision === true),
    recall_due: all.filter((id) => { const due = stateByQuestion.get(id)?.recall_due_at; return due && new Date(due).getTime() <= now; }),
    totalAttempts: ordered.length,
  };
}

export function validateAnalyticsDrilldown({ questionIds = [], attempts = [], learning = [], populations = {}, breakdowns = {} }) {
  const expected = deriveAnalyticsPopulations({ questionIds, attempts, learning });
  const samePopulation = (left, right) => stringIds(left).sort().join('|') === stringIds(right).sort().join('|');
  const checks = [
    result('analytics.population_has_no_duplicates', expected.all.length === questionIds.length ? [] : ['duplicate source IDs']),
    result('analytics.total_attempts_reconciles', expected.totalAttempts === attempts.filter((row) => expected.all.includes(String(row.question_id))).length ? [] : ['attempt total differs']),
    ...['all', 'attempted', 'correct', 'incorrect', 'bookmarked', 'marked', 'recall_due'].map((status) => result(`analytics.${status}_population_reconciles`, samePopulation(expected[status], populations[status] || []) ? [] : [`${status} population differs`])),
  ];
  for (const [level, groups] of Object.entries(breakdowns)) {
    const leaked = Object.entries(groups || {}).flatMap(([group, ids]) => ids.filter((id) => !expected.all.includes(String(id))).map((id) => `${level}:${group}:${id}`));
    checks.push(result(`analytics.${level}_breakdown_has_no_leakage`, leaked));
    if (level === 'platform' || level === 'subject') {
      const union = stringIds(Object.values(groups || {}).flat());
      checks.push(result(`analytics.${level}_breakdown_reconciles`, samePopulation(expected.all, union) ? [] : [`${level} union differs`]));
    }
  }
  return { status: checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL', checks };
}

export function assertValidation(report, context) {
  if (report.status === 'PASS') return report;
  const failures = report.checks.filter((check) => check.status === 'FAIL');
  const summary = failures.map((check) => `${check.check} (${check.failures.length})`).join(', ');
  throw new Error(`${context} validation failed: ${summary}`);
}
