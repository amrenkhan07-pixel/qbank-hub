const cleanText = (value) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const asSet = (value) => value instanceof Set ? value : new Set(value || []);
const ids = (questions) => (questions || []).map((question) => String(question.id));

const stringIds = (values) => [...new Set((values || []).map(String).filter(Boolean))];

export function normalizeOptionKeys(value, availableKeys = []) {
  const available = new Set((availableKeys || []).map((key) => String(key).trim().toUpperCase()).filter(Boolean));
  const values = Array.isArray(value) ? value : String(value ?? '').split(/\s*(?:,|;|\||\+)\s*/);
  const normalized = values.flatMap((item) => {
    const raw = String(item ?? '').trim().toUpperCase();
    if (!raw) return [];
    if (available.has(raw) || (!available.size && /^[A-Z0-9]+$/.test(raw))) return [raw];
    const prefix = raw.match(/^([A-Z0-9]+)(?=\s*[.):\-]|\s)/)?.[1] || '';
    return prefix && (!available.size || available.has(prefix)) ? [prefix] : [];
  });
  return [...new Set(normalized)].sort();
}

export function canonicalCorrectOptionKeys(question = {}) {
  const options = question.options || [];
  const available = options.map((option) => option.option_key);
  const canonical = options.filter((option) => option.is_correct === true).map((option) => option.option_key);
  if (canonical.length) return normalizeOptionKeys(canonical, available);
  const declared = normalizeOptionKeys(question.correct_option_keys, available);
  if (declared.length) return declared;
  const legacy = normalizeOptionKeys(question.correct_answer, available);
  if (legacy.length) return legacy;
  const answerText = cleanText(question.correct_answer).toLowerCase();
  const textMatch = options.find((option) => cleanText(option.option_text).toLowerCase() === answerText);
  return textMatch ? normalizeOptionKeys([textMatch.option_key], available) : [];
}

export function isCanonicalAnswerCorrect(question = {}, selectedOption = '') {
  const available = (question.options || []).map((option) => option.option_key);
  const expected = canonicalCorrectOptionKeys(question);
  const selected = normalizeOptionKeys(selectedOption?.selected_option ?? selectedOption, available);
  return expected.length > 0 && expected.length === selected.length && expected.every((key, index) => key === selected[index]);
}

export function buildTaxonomyIndex(questionRows = []) {
  return (questionRows || []).map((question) => ({
    id: String(question.id),
    platform_id: String(question.platform_id || ''),
    subject_id: String(question.subject_id || ''),
    system_id: String(question.system_id || ''),
    topic_ids: stringIds((question.question_topics || question.topic_ids || []).map((item) => item?.topic_id ?? item)),
    subtopic_ids: stringIds((question.question_subtopics || question.subtopic_ids || []).map((item) => item?.subtopic_id ?? item)),
    source_test_ids: stringIds(question.source_test_ids),
    pyq_source_test_ids: stringIds(question.pyq_source_test_ids),
    non_pyq_source_test_ids: stringIds(question.non_pyq_source_test_ids),
    is_usable: question.is_usable !== false,
    is_pyq: question.is_pyq === true,
    exams: stringIds([...(question.is_inicet ? ['inicet'] : []), ...(question.is_neet_pg ? ['neet_pg'] : []), ...(question.exam_tags || [])].map((value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''))),
    exam_year: question.exam_year == null ? '' : String(question.exam_year),
    exam_session: String(question.exam_shift || ''),
  })).filter((question) => question.id && question.platform_id && question.subject_id && question.is_usable);
}

export function filterAnalyticsPopulation(questionIndex = [], filters = {}) {
  const allowed = {
    pyq: String(filters.pyq || ''), exams: new Set(stringIds(filters.exams)),
    years: new Set(stringIds(filters.years)), sessions: new Set(stringIds(filters.sessions)),
    sourceTests: new Set(stringIds(filters.source_tests)),
  };
  return questionIndex.filter((question) => {
    const sourceTests = question.source_test_ids || [];
    const scopedSourceTests = allowed.sourceTests.size ? sourceTests.filter((id) => allowed.sourceTests.has(id)) : sourceTests;
    if (allowed.sourceTests.size && !scopedSourceTests.length) return false;
    const pyqSourceTests = question.pyq_source_test_ids || [];
    const nonPyqSourceTests = question.non_pyq_source_test_ids || [];
    const matchesPyqSource = (ids) => allowed.sourceTests.size ? ids.some((id) => allowed.sourceTests.has(id)) : ids.length > 0;
    if (allowed.pyq === 'yes' && !(matchesPyqSource(pyqSourceTests) || (!sourceTests.length && question.is_pyq))) return false;
    if (allowed.pyq === 'no' && !(matchesPyqSource(nonPyqSourceTests) || (!sourceTests.length && !question.is_pyq))) return false;
    if (allowed.exams.size && !(question.exams || []).some((exam) => allowed.exams.has(exam))) return false;
    if (allowed.years.size && !allowed.years.has(String(question.exam_year))) return false;
    if (allowed.sessions.size && !allowed.sessions.has(String(question.exam_session))) return false;
    return true;
  }).map((question) => question.id);
}

export function analyticsMetadataCapabilities(questionIndex = [], questionIds = null) {
  const constrained = Array.isArray(questionIds);
  const allowed = new Set(stringIds(questionIds || []));
  const rows = constrained ? questionIndex.filter((question) => allowed.has(String(question.id))) : questionIndex;
  return {
    hasPyq: rows.some((question) => question.is_pyq),
    exams: [...new Set(rows.flatMap((question) => question.exams))].sort(),
    years: [...new Set(rows.map((question) => question.exam_year).filter(Boolean))].sort((a, b) => Number(b) - Number(a)),
    sessions: [...new Set(rows.map((question) => question.exam_session).filter(Boolean))].sort(),
  };
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
  pyqQuestionIds = [], nonPyqQuestionIds = [], allowDuplicates = false,
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
  const exams = asSet((filters.exams || []).map(String));
  const years = asSet((filters.years || []).map(String));
  const sessions = asSet((filters.sessions || []).map(String));
  const pyqIds = asSet(pyqQuestionIds.map(String));
  const nonPyqIds = asSet(nonPyqQuestionIds.map(String));
  for (const question of questions) {
    if (platforms.size && !platforms.has(String(question.platform_id))) directFailures.push(`${question.id}:platform`);
    if (subjects.size && !subjects.has(String(question.subject_id))) directFailures.push(`${question.id}:subject`);
    if (systems.size && !systems.has(String(question.system_id))) directFailures.push(`${question.id}:system`);
    if (filters.pyq === 'yes' && !(pyqIds.size ? pyqIds.has(String(question.id)) : question.is_pyq === true)) directFailures.push(`${question.id}:pyq`);
    if (filters.pyq === 'no' && !(nonPyqIds.size ? nonPyqIds.has(String(question.id)) : question.is_pyq !== true)) directFailures.push(`${question.id}:non_pyq`);
    if (question.is_usable === false) directFailures.push(`${question.id}:unusable`);
    const questionExams = new Set([...(question.is_inicet ? ['inicet'] : []), ...(question.is_neet_pg ? ['neet_pg'] : []), ...(question.exam_tags || [])].map((value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')));
    if (exams.size && ![...exams].some((exam) => questionExams.has(exam))) directFailures.push(`${question.id}:exam`);
    if (years.size && !years.has(String(question.exam_year ?? ''))) directFailures.push(`${question.id}:exam_year`);
    if (sessions.size && !sessions.has(String(question.exam_shift || ''))) directFailures.push(`${question.id}:exam_session`);
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
    const correct = canonicalCorrectOptionKeys(question);
    if (!correct.length || correct.some((key) => !keys.includes(key))) contentFailures.push(`${question.id}:invalid_correct_answer`);
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

export function analyticsStudyPriority({
  isPyq = false, currentIncorrect = 0, repeatedIncorrect = 0, slowIncorrect = 0,
  attempted = 0, available = 0, latestAccuracy = null, bookmarked = 0, marked = 0,
} = {}) {
  const accuracyPenalty = attempted >= 5 && Number.isFinite(latestAccuracy)
    ? Math.max(0, Math.round((0.7 - latestAccuracy) * 20))
    : 0;
  const coverageGap = attempted >= 5 && available > 0 && attempted / available < 0.5 ? 2 : 0;
  const score = currentIncorrect * 4 + repeatedIncorrect * 10 + slowIncorrect * 2
    + bookmarked + marked * 2 + accuracyPenalty + coverageGap
    + (isPyq ? 15 + currentIncorrect * 4 + repeatedIncorrect * 6 : 0);
  const label = score >= 30 ? 'VERY HIGH PRIORITY'
    : score >= 15 ? 'HIGH PRIORITY'
      : score >= 5 ? 'WATCH' : 'INSUFFICIENT DATA';
  return { score, label };
}

export function analyticsActionQuestionIds(metric = {}, action = '') {
  const populations = {
    practice_pyqs: metric.ids || [],
    unattempted_pyqs: metric.unattempted || [],
    review_wrong_pyqs: metric.incorrect || [],
    review_incorrect: metric.incorrect || [],
    review_repeated_mistakes: metric.repeatedIncorrect || [],
  };
  return stringIds(populations[action] || []);
}

export function analyticsPlatformDisagreement(platformMetrics = [], minimumAttempts = 5, threshold = 0.2) {
  const eligible = platformMetrics.filter((metric) => Number(metric?.attempted) >= minimumAttempts && Number.isFinite(metric?.latestAccuracy));
  if (eligible.length < 2) return false;
  const values = eligible.map((metric) => Number(metric.latestAccuracy));
  return Math.max(...values) - Math.min(...values) >= threshold;
}

export function srmTransition(current = {}, event = {}) {
  const result = event.result;
  const confidence = result === 'correct' && event.confidence === 'sure' ? 'sure' : result === 'correct' ? 'unsure' : null;
  const state = current.state || 'new';
  const interval = Math.max(0, Number(current.intervalMinutes) || 0);
  const active = current.active === true;
  const isPyq = event.isPyq === true;
  if (result === 'manual_add') return { state: active ? state : 'new', intervalMinutes: 0, active: true };
  if (result === 'manual_remove') return { state, intervalMinutes: interval, active: false };
  if (result === 'manual_reset') return { state: 'new', intervalMinutes: 0, active: true, consecutiveCorrect: 0, consecutiveIncorrect: 0, lapseCount: 0 };
  if (result === 'correct' && confidence === 'sure' && !active && !isPyq) return { state: 'new', intervalMinutes: 0, active: false, confidence };
  if (result === 'incorrect') {
    const immediateUsed = Number(current.immediateRepeatsToday || 0) >= 1;
    return { state: 'relearning', intervalMinutes: immediateUsed ? 1440 : 10, active: true, confidence: null,
      consecutiveCorrect: 0, consecutiveIncorrect: Number(current.consecutiveIncorrect || 0) + 1,
      lapseCount: Number(current.lapseCount || 0) + (['review', 'mature'].includes(state) ? 1 : 0),
      immediateRepeatsToday: immediateUsed ? Number(current.immediateRepeatsToday || 0) : 1 };
  }
  let nextInterval; let nextState;
  if (state === 'relearning') { nextInterval = 1440; nextState = 'learning'; }
  else if (state === 'learning' && String(current.enrolledReason || '').startsWith('incorrect') && Number(current.consecutiveCorrect || 0) >= 1 && confidence === 'sure') {
    nextInterval = 10080; nextState = 'review';
  } else if (confidence === 'unsure') {
    nextInterval = interval < 1440 ? 1440 : interval < 4320 ? 4320 : interval < 10080 ? 10080 : 20160;
    nextState = nextInterval >= 10080 ? 'review' : 'learning';
  } else {
    nextInterval = interval < 4320 ? 4320 : interval < 10080 ? 10080 : interval < 20160 ? 20160 : interval < 43200 ? 43200 : 86400;
    nextState = nextInterval >= 43200 ? 'mature' : 'review';
  }
  return { state: nextState, intervalMinutes: nextInterval, active: true, confidence,
    consecutiveCorrect: Number(current.consecutiveCorrect || 0) + 1, consecutiveIncorrect: 0,
    lapseCount: Number(current.lapseCount || 0), immediateRepeatsToday: 0 };
}

export function rankSrmQueue(rows = []) {
  const priorityClass = (row) => row.isPyq && row.consecutiveIncorrect >= 2 ? 7
    : row.isPyq && row.lastResult === 'incorrect' ? 6
      : !row.isPyq && row.consecutiveIncorrect >= 2 ? 5
        : row.lastResult === 'incorrect' ? 4
          : row.isPyq && row.confidence === 'unsure' ? 3 : row.isPyq ? 2 : 1;
  return [...rows].map((row) => ({ ...row, priorityClass: priorityClass(row) })).sort((left, right) =>
    Number(right.overdueSeconds || 0) - Number(left.overdueSeconds || 0)
    || right.priorityClass - left.priorityClass
    || Number(right.consecutiveIncorrect || 0) - Number(left.consecutiveIncorrect || 0)
    || Number(right.marked === true) - Number(left.marked === true)
    || Number(right.bookmarked === true) - Number(left.bookmarked === true)
    || String(left.questionId).localeCompare(String(right.questionId)));
}

export function validateSrmQueue(rows = []) {
  const ids = rows.map((row) => String(row.questionId || row.question_id || ''));
  const failures = [];
  if (ids.some((id) => !id)) failures.push('missing_question_id');
  if (ids.length !== new Set(ids).size) failures.push('duplicate_question_id');
  rows.forEach((row) => { if (row.isUsable === false || row.is_usable === false) failures.push(`${row.questionId || row.question_id}:quarantined`); });
  const check = result('srm.queue_invariants', failures, `${rows.length} due items`);
  return { status: check.status, checks: [check] };
}

export function sameSrmLocalDate(left, right, timezone = 'UTC') {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(new Date(left)) === formatter.format(new Date(right));
}

export function analyticsTopicSubtopicRedundant({ questionIndex = [], topics = [], subtopics = [], questionIds = [] }) {
  const allowed = new Set(stringIds(questionIds));
  const names = (items) => new Map((items || []).map((item) => [String(item.id), String(item.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '')]));
  const topicNames = names(topics); const subtopicNames = names(subtopics);
  const signatures = (field, itemNames) => {
    const grouped = new Map();
    questionIndex.filter((question) => allowed.has(String(question.id))).forEach((question) => {
      (question[field] || []).forEach((id) => { const key = String(id); if (!grouped.has(key)) grouped.set(key, new Set()); grouped.get(key).add(String(question.id)); });
    });
    const result = new Map(); let invalid = false;
    grouped.forEach((members, id) => {
      const name = itemNames.get(id);
      if (!name || result.has(name)) invalid = true;
      else result.set(name, [...members].sort().join('|'));
    });
    return { result, invalid };
  };
  const topicGroups = signatures('topic_ids', topicNames); const subtopicGroups = signatures('subtopic_ids', subtopicNames);
  if (topicGroups.invalid || subtopicGroups.invalid || !topicGroups.result.size || topicGroups.result.size !== subtopicGroups.result.size) return false;
  return [...topicGroups.result].every(([name, members]) => subtopicGroups.result.get(name) === members);
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
