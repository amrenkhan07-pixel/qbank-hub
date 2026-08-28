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

export function assertValidation(report, context) {
  if (report.status === 'PASS') return report;
  const failures = report.checks.filter((check) => check.status === 'FAIL');
  const summary = failures.map((check) => `${check.check} (${check.failures.length})`).join(', ');
  throw new Error(`${context} validation failed: ${summary}`);
}
