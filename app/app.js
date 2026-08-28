import { db, initError, isMissingTable, requireUser, withAuthTimeout } from './supabase.js';
import { assertValidation, buildTaxonomyIndex, resolveTaxonomyCascade, validateGeneratedQuestionSet, validateQuestionStateBindings, validateResumeSnapshot } from './validation.js?v=20260828-cascade';
import { runTaxonomyDomRegression } from './taxonomy-dom-regression.js?v=20260828-dom-regression';

const root = document.querySelector('#app');
const TARGET_SECONDS = 50;
const PAGE_SIZE = 500;
const filterCountRequests = new WeakMap();
const state = {
  user: null,
  route: 'home',
  meta: { subjects: [], platforms: [], systems: [], topics: [], subtopics: [], tags: [], questionTaxonomy: [] },
  active: null,
  timer: null,
  filterTimer: null,
  features: { learning: true, subtopics: true, sessions: true, personal: true },
};

const e = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const date = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : '—';
const pct = (a, b) => b ? `${Math.round((a / b) * 100)}%` : '—';
const route = () => location.hash.replace(/^#\/?/, '').split('?')[0] || 'home';
const unique = (rows, key = 'question_id') => [...new Set((rows || []).map((row) => row[key]).filter(Boolean))];
const byId = (rows) => new Map((rows || []).map((row) => [String(row.id), row]));
const correctKey = (question) => String(question.correct_answer || '').trim().charAt(0).toUpperCase();
const selectedKey = (answer) => String(answer?.selected_option || '').toUpperCase();
const intersect = (left, right) => left == null ? new Set(right) : new Set([...left].filter((value) => right.has(value)));

function toast(text, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = text;
  document.querySelector('#toast-region')?.append(node);
  setTimeout(() => node.remove(), 4200);
}

function safeUrl(value, image = false) {
  try {
    const parsed = new URL(value, location.href);
    const allowed = image ? ['http:', 'https:', 'data:'] : ['http:', 'https:', 'mailto:'];
    return allowed.includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
}

function richHtml(value) {
  const input = String(value ?? '');
  if (!input) return '';
  const doc = new DOMParser().parseFromString(`<div>${input}</div>`, 'text/html');
  const allowed = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'CODE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SUP', 'SUB', 'A', 'IMG', 'HR', 'DIV', 'SPAN']);
  const clean = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return e(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const children = [...node.childNodes].map(clean).join('');
    if (!allowed.has(node.tagName)) return children;
    if (node.tagName === 'A') {
      const href = safeUrl(node.getAttribute('href') || '');
      return href ? `<a href="${e(href)}" target="_blank" rel="noopener noreferrer">${children}</a>` : children;
    }
    if (node.tagName === 'IMG') {
      const src = safeUrl(node.getAttribute('src') || '', true);
      return src ? `<img src="${e(src)}" alt="${e(node.getAttribute('alt') || 'Explanation image')}" loading="lazy" />` : '';
    }
    return `<${node.tagName.toLowerCase()}>${children}</${node.tagName.toLowerCase()}>`;
  };
  return [...doc.body.firstElementChild.childNodes].map(clean).join('');
}

function layout(content) {
  const nav = [['home', 'Home'], ['qbank', 'QBank'], ['tests', 'Test'], ['review', 'Review'], ['analytics', 'Analytics'], ['my-bank', 'My Bank']];
  root.innerHTML = `<header class="topbar"><div class="shell topbar-row"><a class="brand" href="#/home">QBank <span>Hub</span></a><div class="user-actions"><span class="email">${e(state.user?.email)}</span><button class="button secondary compact" data-action="signout">Sign out</button></div></div><nav class="shell nav" aria-label="Primary navigation">${nav.map(([id, label]) => `<a href="#/${id}" class="${state.route === id ? 'active' : ''}">${label}</a>`).join('')}</nav></header><main class="shell">${content}</main>`;
}

function loading(message = 'Loading QBank Hub…') {
  root.innerHTML = `<main class="shell"><div class="card empty"><span class="spinner" aria-hidden="true"></span>${e(message)}</div></main>`;
}

function featureNotice(text) {
  return `<div class="notice"><b>Setup required</b><p>${e(text)}</p></div>`;
}

async function optional(query, feature) {
  const result = await query;
  if (result.error && isMissingTable(result.error)) {
    if (feature) state.features[feature] = false;
    return { data: [], count: 0, error: result.error, missing: true };
  }
  if (result.error) console.warn(result.error.message);
  return result;
}

async function loadMeta(force = false) {
  if (!force && state.meta.subjects.length && state.meta.platforms.length) return;
  const [subjects, platforms, platformSubjects, systems, topics, subtopics, tags, questionTaxonomy] = await Promise.all([
    db.from('subjects').select('id,name').order('name'),
    db.from('platforms').select('id,name').order('name'),
    db.from('platform_subjects').select('id,subject_id'),
    optional(db.from('systems').select('id,name,platform_subject_id').order('sort_order').order('name')),
    optional(db.from('topics').select('id,name,platform_subject_id,system_id,parent_topic_id').order('sort_order').order('name')),
    optional(db.from('subtopics').select('id,name,topic_id').order('sort_order').order('name'), 'subtopics'),
    optional(db.from('tags').select('id,name').order('name')),
    paged(() => db.from('questions').select('id,platform_id,subject_id,system_id,question_topics(topic_id),question_subtopics(subtopic_id)')),
  ]);
  if (subjects.error) throw subjects.error;
  if (platforms.error) throw platforms.error;
  if (platformSubjects.error) throw platformSubjects.error;
  const subjectByPlatformSubject = new Map((platformSubjects.data || []).map((row) => [row.id, row.subject_id]));
  const hydratedTopics = (topics.data || []).map((topic) => ({ ...topic, subject_id: subjectByPlatformSubject.get(topic.platform_subject_id) || '' }));
  const topicById = new Map(hydratedTopics.map((topic) => [topic.id, topic]));
  state.meta = {
    subjects: subjects.data || [], platforms: platforms.data || [],
    systems: (systems.data || []).map((system) => ({ ...system, subject_id: subjectByPlatformSubject.get(system.platform_subject_id) || '' })),
    topics: hydratedTopics.filter((topic) => !topic.parent_topic_id),
    subtopics: (subtopics.data || []).map((subtopic) => ({ ...subtopic, subject_id: topicById.get(subtopic.topic_id)?.subject_id || '' })),
    tags: tags.data || [],
    questionTaxonomy: buildTaxonomyIndex(questionTaxonomy),
  };
}

function multiPicker(name, label, items, empty = `No ${label.toLowerCase()} available`) {
  return `<div class="field multi-field" data-multi-field="${e(name)}"><label>${e(label)}</label><details class="multi-picker"><summary><span data-multi-summary>${e(`All ${name}`)}</span></summary><div class="multi-menu">${items.length ? items.map((item) => `<label class="check-row" data-taxonomy-label="${e(item.name)}" data-subject="${e(item.subject_id || '')}" data-topic="${e(item.topic_id || '')}"><input type="checkbox" name="${e(name)}" value="${e(item.id)}" /> <span>${e(item.name)}</span></label>`).join('') : `<span class="subtle">${e(empty)}</span>`}</div></details></div>`;
}

function statusPicker(revision = false) {
  const values = revision
    ? [['incorrect', 'Incorrect'], ['bookmarked', 'Bookmarked'], ['marked', 'Marked for review'], ['recall_due', 'Recall due'], ['difficult', 'Personally difficult'], ['confident_wrong', 'Confidently wrong'], ['slow', 'Slow >50 sec'], ['my_content', 'My Content']]
    : [['new', 'New'], ['incorrect', 'Incorrect'], ['correct', 'Correct'], ['bookmarked', 'Bookmarked'], ['marked', 'Marked for review'], ['recall_due', 'Recall due'], ['my_content', 'My Content']];
  return `<fieldset class="field wide status-field"><legend>Question status</legend><div class="chip-checks"><label><input type="checkbox" name="statuses" value="all" checked /> <span>All</span></label>${values.map(([value, label]) => `<label><input type="checkbox" name="statuses" value="${value}" /> <span>${label}</span></label>`).join('')}</div></fieldset>`;
}

function filterFields({ revision = false } = {}) {
  return `${multiPicker('platforms', 'Platforms', state.meta.platforms)}${multiPicker('subjects', 'Subjects', state.meta.subjects)}${multiPicker('systems', 'Systems (optional)', state.meta.systems)}${multiPicker('topics', 'Topics', state.meta.topics, 'Choose a subject first')}${multiPicker('subtopics', 'Subtopics', state.meta.subtopics, 'Choose a topic first')}${statusPicker(revision)}<div class="field"><label>PYQ</label><select name="pyq"><option value="">All questions</option><option value="yes">PYQ only</option></select></div><div class="field"><label>Exam year/session</label><input name="year" type="number" min="1950" max="2100" placeholder="e.g. 2024" /></div><div class="field wide"><label>Search question text</label><input name="search" placeholder="e.g. thyroid, ECG, nephrotic" /></div><div class="field wide"><label>Source / collection</label><input name="source" placeholder="Cerebellum, Marrow, PrepLadder, BTR…" /></div>`;
}

function readMulti(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((node) => node.value);
}

function readFilters(form) {
  const raw = Object.fromEntries(new FormData(form));
  return {
    platforms: readMulti(form, 'platforms'), subjects: readMulti(form, 'subjects'), systems: readMulti(form, 'systems'),
    topics: readMulti(form, 'topics'), subtopics: readMulti(form, 'subtopics'), statuses: readMulti(form, 'statuses'),
    pyq: raw.pyq || '', year: raw.year || '', search: raw.search?.trim() || '', source: raw.source?.trim() || '',
  };
}

function setupDependentFilters(form) {
  const update = () => {
    const cascade = resolveTaxonomyCascade(state.meta.questionTaxonomy, {
      platforms: readMulti(form, 'platforms'), subjects: readMulti(form, 'subjects'),
      systems: readMulti(form, 'systems'), topics: readMulti(form, 'topics'),
      subtopics: readMulti(form, 'subtopics'),
    });
    for (const level of ['platforms', 'subjects', 'systems', 'topics', 'subtopics']) {
      const selected = new Set(cascade.selected[level]);
      form.querySelectorAll(`[data-multi-field="${level}"] input`).forEach((input) => {
        const visible = cascade.valid[level].has(input.value);
        const row = input.closest('.check-row');
        row.hidden = !visible;
        row.style.display = visible ? '' : 'none';
        input.checked = visible && selected.has(input.value);
      });
    }
    form.querySelectorAll('[data-multi-field]').forEach((field) => {
      const checked = readMulti(form, field.dataset.multiField);
      field.querySelector('[data-multi-summary]').textContent = checked.length ? `${checked.length} selected` : `All ${field.dataset.multiField}`;
    });
  };
  form.addEventListener('change', (event) => {
    if (event.target.name === 'statuses') {
      const all = form.querySelector('input[name="statuses"][value="all"]');
      if (event.target.value === 'all' && event.target.checked) form.querySelectorAll('input[name="statuses"]').forEach((input) => { if (input !== all) input.checked = false; });
      else if (event.target.checked && all) all.checked = false;
    }
    update(); clearTimeout(state.filterTimer); state.filterTimer = setTimeout(() => updateMatchCount(form), 250);
  });
  update();
}

async function paged(queryFactory, size = PAGE_SIZE) {
  const rows = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await queryFactory().range(from, from + size - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return rows;
}

async function statusCandidateIds(filters) {
  const statuses = new Set(filters.statuses || []);
  if (!statuses.size || statuses.has('all') || statuses.has('my_content')) return null;
  const union = new Set(); const add = (values) => values.forEach((value) => union.add(value));
  if (statuses.has('bookmarked')) add(unique(await paged(() => db.from('user_question_state').select('question_id').eq('user_id', state.user.id).eq('bookmarked', true))));
  const needsLearning = ['marked', 'incorrect', 'correct', 'recall_due', 'difficult', 'confident_wrong', 'slow'].some((value) => statuses.has(value));
  if (needsLearning) {
    const result = await optional(db.from('user_question_state').select('*').eq('user_id', state.user.id), 'learning');
    const rows = result.data || [];
    if (statuses.has('marked')) add(rows.filter((x) => x.marked_for_review).map((x) => x.question_id));
    if (statuses.has('incorrect')) add(rows.filter((x) => x.last_is_correct === false || x.wrong).map((x) => x.question_id));
    if (statuses.has('correct')) add(rows.filter((x) => x.last_is_correct === true).map((x) => x.question_id));
    if (statuses.has('recall_due')) add(rows.filter((x) => x.recall_due_at && new Date(x.recall_due_at) <= new Date()).map((x) => x.question_id));
    if (statuses.has('difficult')) add(rows.filter((x) => x.personally_difficult).map((x) => x.question_id));
    if (statuses.has('confident_wrong')) add(rows.filter((x) => x.last_is_correct === false && x.last_confidence === 'sure').map((x) => x.question_id));
    if (statuses.has('slow')) add(rows.filter((x) => x.last_time_seconds > TARGET_SECONDS).map((x) => x.question_id));
  }
  if (statuses.has('new')) {
    const attempted = new Set(unique(await paged(() => db.from('question_attempts').select('question_id').eq('user_id', state.user.id))));
    add((await paged(() => db.from('questions').select('id'))).filter((q) => !attempted.has(q.id)).map((q) => q.id));
  }
  return union;
}

async function candidateIds(filters) {
  let candidate = null;
  if (filters.topics?.length) {
    const result = await db.from('question_topics').select('question_id').in('topic_id', filters.topics);
    if (result.error) throw result.error; candidate = intersect(candidate, new Set(unique(result.data)));
  }
  if (filters.subtopics?.length) {
    const result = await optional(db.from('question_subtopics').select('question_id').in('subtopic_id', filters.subtopics), 'subtopics');
    candidate = intersect(candidate, new Set(unique(result.data)));
  }
  const status = await statusCandidateIds(filters);
  if (status) candidate = intersect(candidate, status);
  return candidate;
}

async function rowsForQuestionIds(table, columns, questionIds, configure = (query) => query) {
  const rows = [];
  for (let index = 0; index < questionIds.length; index += 200) {
    const result = await configure(db.from(table).select(columns).in('question_id', questionIds.slice(index, index + 200)));
    if (result.error) throw result.error;
    rows.push(...(result.data || []));
  }
  return rows;
}

async function validationMembership(filters, questions) {
  const questionIds = questions.map((question) => question.id);
  const topicQuestionIds = (filters.topics || []).length
    ? unique(await rowsForQuestionIds('question_topics', 'question_id', questionIds, (query) => query.in('topic_id', filters.topics)))
    : questionIds;
  const subtopicQuestionIds = (filters.subtopics || []).length
    ? unique(await rowsForQuestionIds('question_subtopics', 'question_id', questionIds, (query) => query.in('subtopic_id', filters.subtopics)))
    : questionIds;
  const statuses = new Set(filters.statuses || []);
  if (!statuses.size || statuses.has('all')) return { topicQuestionIds, subtopicQuestionIds, statusQuestionIds: questionIds };

  const statusQuestionIds = new Set();
  if (statuses.has('my_content')) questions.filter((question) => question.content_origin === 'user' && question.created_by === state.user.id).forEach((question) => statusQuestionIds.add(question.id));
  if (statuses.has('bookmarked')) {
    const rows = await rowsForQuestionIds('user_question_state', 'question_id', questionIds, (query) => query.eq('user_id', state.user.id).eq('bookmarked', true));
    rows.forEach((row) => statusQuestionIds.add(row.question_id));
  }
  const learningStatuses = ['incorrect', 'correct', 'marked', 'recall_due', 'difficult', 'confident_wrong', 'slow'];
  if (learningStatuses.some((status) => statuses.has(status))) {
    const now = Date.now();
    const rows = await rowsForQuestionIds('user_question_state', '*', questionIds, (query) => query.eq('user_id', state.user.id));
    rows.forEach((row) => {
      const matches = (statuses.has('incorrect') && (row.last_is_correct === false || row.wrong === true))
        || (statuses.has('correct') && row.last_is_correct === true)
        || (statuses.has('marked') && (row.marked_for_review === true || row.revision === true))
        || (statuses.has('recall_due') && row.recall_due_at && new Date(row.recall_due_at).getTime() <= now)
        || (statuses.has('difficult') && row.personally_difficult === true)
        || (statuses.has('confident_wrong') && row.last_is_correct === false && row.last_confidence === 'sure')
        || (statuses.has('slow') && Number(row.last_time_seconds) > TARGET_SECONDS);
      if (matches) statusQuestionIds.add(row.question_id);
    });
  }
  if (statuses.has('new')) {
    const attempted = new Set(unique(await rowsForQuestionIds('question_attempts', 'question_id', questionIds, (query) => query.eq('user_id', state.user.id))));
    questionIds.filter((questionId) => !attempted.has(questionId)).forEach((questionId) => statusQuestionIds.add(questionId));
  }
  return { topicQuestionIds, subtopicQuestionIds, statusQuestionIds: [...statusQuestionIds] };
}

function applyDirectFilters(query, filters) {
  if (filters.platforms?.length) query = query.in('platform_id', filters.platforms);
  if (filters.subjects?.length) query = query.in('subject_id', filters.subjects);
  if (filters.systems?.length) query = query.in('system_id', filters.systems);
  if (filters.pyq === 'yes') query = query.eq('is_pyq', true);
  if (filters.year) query = query.eq('exam_year', Number(filters.year));
  if (filters.search) query = query.ilike('question_text', `%${filters.search}%`);
  if (filters.source) query = query.ilike('source_reference', `%${filters.source}%`);
  if (filters.statuses?.includes('my_content')) query = query.eq('created_by', state.user.id);
  return query;
}

async function matchingCount(filters) {
  const candidate = await candidateIds(filters);
  if (candidate && !candidate.size) return 0;
  let query = applyDirectFilters(db.from('questions').select('*', { count: 'exact', head: true }), filters);
  if (candidate) query = query.in('id', [...candidate]);
  const { count, error } = await query; if (error) throw error; return count || 0;
}

async function updateMatchCount(form) {
  const holder = form.querySelector('[data-match-count]'); if (!holder) return;
  const requestId = (filterCountRequests.get(form) || 0) + 1;
  filterCountRequests.set(form, requestId);
  holder.textContent = 'Counting…';
  try {
    const count = await matchingCount(readFilters(form));
    if (!form.isConnected || filterCountRequests.get(form) !== requestId) return;
    holder.textContent = `${count.toLocaleString()} question${count === 1 ? '' : 's'} match`; holder.dataset.count = count;
  } catch (error) {
    if (!form.isConnected || filterCountRequests.get(form) !== requestId) return;
    holder.textContent = 'Count unavailable'; console.warn(error);
  }
}

async function batchOptions(questionIds) {
  const all = [];
  for (let i = 0; i < questionIds.length; i += 200) {
    const result = await db.from('question_options').select('question_id,option_key,option_text').in('question_id', questionIds.slice(i, i + 200)).order('option_key');
    if (result.error) throw result.error; all.push(...(result.data || []));
  }
  const grouped = new Map();
  all.forEach((option) => { if (!grouped.has(option.question_id)) grouped.set(option.question_id, []); grouped.get(option.question_id).push(option); });
  return grouped;
}

async function loadQuestions(filters, requested = 10) {
  const candidate = await candidateIds(filters); if (candidate && !candidate.size) return [];
  const limit = requested === 'all' ? null : Math.max(1, Number(requested) || 10);
  let rows;
  if (limit) {
    let query = applyDirectFilters(db.from('questions').select('*'), filters);
    if (candidate) query = query.in('id', [...candidate]);
    const result = await query.limit(Math.min(Math.max(limit * 4, limit), 1000));
    if (result.error) throw result.error; rows = result.data || [];
  } else {
    rows = await paged(() => applyDirectFilters(db.from('questions').select('*'), filters));
    if (candidate) rows = rows.filter((row) => candidate.has(row.id));
  }
  rows.sort(() => Math.random() - .5); if (limit) rows = rows.slice(0, limit);
  const options = await batchOptions(rows.map((row) => row.id));
  return Promise.all(rows.map(async (question) => {
    let imageUrl = question.image_url || '';
    if (!imageUrl && question.image_path) { const signed = await db.storage.from('question-media').createSignedUrl(question.image_path, 3600); imageUrl = signed.data?.signedUrl || ''; }
    return { ...question, image_url: imageUrl, options: options.get(question.id) || [] };
  }));
}

async function loadPersonalState(questionIds) {
  const bookmarks = new Set(); const marked = new Set(); const learning = new Map();
  for (let i = 0; i < questionIds.length; i += 200) {
    const chunk = questionIds.slice(i, i + 200);
    const learningResult = await optional(db.from('user_question_state').select('*').eq('user_id', state.user.id).in('question_id', chunk), 'learning');
    (learningResult.data || []).forEach((row) => {
      learning.set(row.question_id, row);
      if (row.bookmarked) bookmarks.add(row.question_id);
      if (row.marked_for_review) marked.add(row.question_id);
    });
  }
  return { bookmarks, marked, learning };
}

async function createSession({ mode, preset, title, filters, requested, autoSubmit }) {
  loading('Building your question set…');
  const trueMatchingCount = await matchingCount(filters);
  const questions = trueMatchingCount ? await loadQuestions(filters, requested) : [];
  const membership = await validationMembership(filters, questions);
  assertValidation(validateGeneratedQuestionSet({ questions, filters, requested, matchingCount: trueMatchingCount, ...membership }), 'Generated question set');
  if (!questions.length) { toast('No questions match those filters.'); location.hash = mode === 'test' ? '#/tests' : '#/qbank'; return; }
  const now = new Date().toISOString();
  const payload = {
    user_id: state.user.id, title, mode, status: 'in_progress', filters, total_questions: questions.length,
    duration_minutes: Math.max(1, Math.ceil(questions.length * TARGET_SECONDS / 60)), started_at: now,
    current_position: 0, preset, target_seconds_per_question: TARGET_SECONDS, auto_submit: autoSubmit,
    last_question_started_at: now,
  };
  let session = null;
  const created = await optional(db.from('test_sessions').insert(payload).select().single(), 'sessions');
  if (!created.error) {
    session = created.data;
    const snapshots = questions.map((q, position) => ({
      session_id: session.id, question_id: q.id, position,
      question_snapshot: { question_text: q.question_text, correct_answer: q.correct_answer, explanation_html: q.explanation_html, source_reference: q.source_reference, source_collection: q.source_collection, image_url: q.image_url, subject_id: q.subject_id, platform_id: q.platform_id, system_id: q.system_id, options: q.options },
    }));
    for (let i = 0; i < snapshots.length; i += 100) {
      const result = await db.from('test_session_questions').insert(snapshots.slice(i, i + 100));
      if (result.error) throw result.error;
    }
  }
  const personal = await loadPersonalState(questions.map((q) => q.id));
  assertValidation(validateQuestionStateBindings({ questions, answers: {}, bookmarks: personal.bookmarks, marked: personal.marked }), 'Question state');
  state.active = {
    ...payload, ...(session || {}), kind: mode, questions, index: 0, answers: {},
    bookmarks: personal.bookmarks, marked: personal.marked, learning: personal.learning,
    questionStartedAt: Date.now(), explanationOpen: false, completedReview: false,
  };
  renderActive();
}

async function home() {
  loading('Preparing your study plan…');
  const now = new Date().toISOString();
  const [attempts, sessions, due, cards] = await Promise.all([
    db.from('question_attempts').select('question_id,is_correct,answered_at').eq('user_id', state.user.id).order('answered_at', { ascending: false }).limit(1000),
    optional(db.from('test_sessions').select('*').eq('user_id', state.user.id).eq('status', 'in_progress').order('updated_at', { ascending: false }).limit(1), 'sessions'),
    optional(db.from('user_question_state').select('question_id', { count: 'exact' }).eq('user_id', state.user.id).lte('recall_due_at', now), 'learning'),
    optional(db.from('recall_card_progress').select('card_id', { count: 'exact' }).eq('user_id', state.user.id).lte('due_at', now), 'personal'),
  ]);
  const logs = attempts.data || []; const correct = logs.filter((row) => row.is_correct).length;
  const active = sessions.data?.[0]; const dueCount = (due.count || due.data?.length || 0) + (cards.count || cards.data?.length || 0);
  const mistakes = new Map(); logs.filter((row) => !row.is_correct).forEach((row) => mistakes.set(row.question_id, (mistakes.get(row.question_id) || 0) + 1));
  const recommendation = dueCount ? { label: `Review ${dueCount} recall item${dueCount === 1 ? '' : 's'}`, route: '#/review' }
    : [...mistakes.values()].some((count) => count > 1) ? { label: 'Revise repeated mistakes', route: '#/review' }
      : { label: 'Start a focused QBank set', route: '#/qbank' };
  let weak = [];
  const attemptedIds = [...new Set(logs.map((row) => row.question_id))];
  if (attemptedIds.length) {
    const result = await db.from('questions').select('id,subject_id').in('id', attemptedIds.slice(0, 1000));
    const questionSubject = new Map((result.data || []).map((q) => [q.id, q.subject_id])); const tally = new Map();
    logs.forEach((row) => { const id = questionSubject.get(row.question_id); if (!id) return; const value = tally.get(id) || [0, 0]; value[0] += row.is_correct ? 1 : 0; value[1]++; tally.set(id, value); });
    const names = byId(state.meta.subjects);
    weak = [...tally].filter(([, value]) => value[1] >= 2).sort((a, b) => a[1][0] / a[1][1] - b[1][0] / b[1][1]).slice(0, 3).map(([id, value]) => ({ id, name: names.get(String(id))?.name || 'Unclassified', accuracy: pct(value[0], value[1]) }));
  }
  layout(`<section class="home-hero"><div><span class="eyebrow">YOUR STUDY PLAN</span><h1>What should you do next?</h1><p class="subtle">One clear action, based on your real learning state.</p></div><a class="button large" href="${recommendation.route}">${e(recommendation.label)}</a></section>
  <section class="action-grid">${active ? `<article class="card action-card priority"><span class="eyebrow">CONTINUE</span><h2>${e(active.title || active.preset || active.mode)}</h2><p>Question ${(active.current_position || 0) + 1} of ${active.total_questions}</p><button class="button" data-action="resume" data-id="${e(active.id)}">Resume exact session</button></article>` : `<article class="card action-card"><span class="eyebrow">CONTINUE</span><h2>No unfinished session</h2><p class="subtle">Start a practice set or test when you are ready.</p><a class="button secondary" href="#/qbank">Build practice</a></article>`}<article class="card action-card"><span class="eyebrow">ACTIVE RECALL</span><h2>${dueCount} due</h2><p>Questions and recall cards ready now.</p><a class="button secondary" href="#/review">Open recall</a></article><a class="card action-card link-card" href="#/analytics"><span class="eyebrow">ACCURACY</span><h2>${pct(correct, logs.length)}</h2><p>${logs.length} recent attempts · Open analytics</p></a></section>
  <section class="card section-card"><div class="section-heading"><div><span class="eyebrow">WEAK AREAS</span><h2>Turn weakness into a question set</h2></div><a href="#/analytics">See all analytics</a></div>${weak.length ? `<div class="weak-list">${weak.map((item) => `<button class="weak-item" data-action="quick-subject" data-id="${e(item.id)}"><span>${e(item.name)}</span><b>${item.accuracy}</b><small>Start revision</small></button>`).join('')}</div>` : '<div class="empty">Answer a few questions and weak areas will appear here.</div>'}</section><div class="secondary-metrics"><span>${logs.length} recent attempts</span><span>${correct} correct</span></div>`);
}

async function qbank() {
  layout(`<div class="page-heading"><span class="eyebrow">QBANK</span><h1>Build a focused practice set</h1><p>Platform → Subject → Topic → Subtopic. Systems remain optional.</p></div><section class="card builder-card"><form id="practice-form" class="stack"><div class="filters">${filterFields()}</div><div class="builder-footer"><div><b data-match-count>Choose filters to count questions</b><div class="subtle">Target time uses 50 seconds per question.</div></div><div class="row"><label class="inline-label">Questions <select name="count-mode"><option value="10">10</option><option value="20">20</option><option value="50">50</option><option value="100">100</option><option value="all">All matching</option><option value="custom">Custom</option></select></label><input class="custom-count hidden" name="custom-count" type="number" min="1" max="5000" value="30" aria-label="Custom question count" /><button class="button">Start practice</button></div></div></form></section>`);
  const form = document.querySelector('#practice-form'); setupDependentFilters(form);
  form.elements['count-mode'].onchange = () => form.querySelector('.custom-count').classList.toggle('hidden', form.elements['count-mode'].value !== 'custom');
  form.onsubmit = async (event) => {
    event.preventDefault(); const filters = readFilters(form); const mode = form.elements['count-mode'].value;
    const requested = mode === 'custom' ? Number(form.elements['custom-count'].value) : mode;
    try { await createSession({ mode: 'practice', preset: 'qbank', title: 'QBank practice', filters, requested, autoSubmit: false }); }
    catch (error) { toast(error.message || 'Could not build practice set.', 'error'); qbank(); }
  };
  updateMatchCount(form);
  const diagnostic = new URLSearchParams(location.hash.split('?')[1] || '').get('dom-regression');
  if (diagnostic === '1') {
    const regressionRun = `${Date.now()}-${Math.random()}`;
    document.documentElement.dataset.qbankDomRegressionRun = regressionRun;
    document.documentElement.dataset.qbankDomRegression = JSON.stringify({ status: 'RUNNING' });
    window.__QBANK_DOM_REGRESSION__ = { status: 'RUNNING' };
    setTimeout(async () => {
      if (!form.isConnected || document.documentElement.dataset.qbankDomRegressionRun !== regressionRun) return;
      try {
        window.__QBANK_DOM_REGRESSION__ = await runTaxonomyDomRegression({ form, questionIndex: state.meta.questionTaxonomy });
      } catch (error) {
        window.__QBANK_DOM_REGRESSION__ = { status: 'FAIL', error: error?.message || String(error) };
      }
      if (document.documentElement.dataset.qbankDomRegressionRun !== regressionRun) return;
      document.documentElement.dataset.qbankDomRegression = JSON.stringify(window.__QBANK_DOM_REGRESSION__);
      console.info('QBank taxonomy DOM regression', window.__QBANK_DOM_REGRESSION__);
    }, 100);
  }
}

const TEST_PRESETS = {
  mixed: ['Mixed Test', 'Combine multiple platforms, subjects and topics.'],
  subject: ['Subject Test', 'Choose one or more subjects, then relevant topics.'],
  topic: ['Topic / Subtopic Test', 'Build through the learning hierarchy.'],
  revision: ['Revision Test', 'Incorrect, bookmarked, marked, recall-due or slow questions.'],
  pyq: ['PYQ Test', 'Filter trusted PYQ metadata by platform, year and subject.'],
  grand: ['Grand Test', 'Broad exam-style set from the available pool.'],
  custom: ['Custom Test', 'Expose every applicable filter.'],
};

async function tests() {
  layout(`<div class="page-heading"><span class="eyebrow">TEST</span><h1>Choose a test type</h1><p>Start with intent, then narrow the question pool.</p></div><section class="preset-grid">${Object.entries(TEST_PRESETS).map(([id, item]) => `<button class="card preset-card" data-action="choose-preset" data-preset="${id}"><b>${e(item[0])}</b><span>${e(item[1])}</span></button>`).join('')}</section><section id="test-builder-slot"></section><section class="card section-card"><div class="section-heading"><div><span class="eyebrow">CONTINUE</span><h2>Unfinished tests</h2></div><a href="#/history">History</a></div><div id="resume-tests" class="empty">Loading…</div></section>`);
  const result = await optional(db.from('test_sessions').select('*').eq('user_id', state.user.id).eq('status', 'in_progress').order('updated_at', { ascending: false }).limit(10), 'sessions');
  document.querySelector('#resume-tests').innerHTML = result.data?.length ? `<ul class="list">${result.data.map((session) => `<li><div><b>${e(session.title || session.preset || 'Test')}</b><div class="subtle">Question ${(session.current_position || 0) + 1}/${session.total_questions} · ${date(session.updated_at)}</div></div><button class="button secondary" data-action="resume" data-id="${e(session.id)}">Resume</button></li>`).join('')}</ul>` : '<div class="empty">No unfinished tests.</div>';
}

function showTestBuilder(preset) {
  const item = TEST_PRESETS[preset] || TEST_PRESETS.custom; const revision = preset === 'revision';
  const slot = document.querySelector('#test-builder-slot');
  slot.innerHTML = `<section class="card builder-card"><div class="section-heading"><div><span class="eyebrow">${e(item[0])}</span><h2>Configure this test</h2></div><button class="button ghost compact" data-action="close-builder">Close</button></div><form id="test-form" class="stack" data-preset="${e(preset)}"><div class="filters">${filterFields({ revision })}</div><div class="builder-footer"><div><b data-match-count>Counting available questions…</b><div class="subtle">50 seconds/question · total target calculated automatically</div></div><div class="row"><label class="inline-label">Questions <select name="count"><option>10</option><option>20</option><option selected>50</option><option>100</option><option value="all">All matching</option></select></label><button class="button">Start ${e(item[0])}</button></div></div></form></section>`;
  const form = document.querySelector('#test-form'); if (preset === 'pyq') form.elements.pyq.value = 'yes'; setupDependentFilters(form);
  form.onsubmit = async (event) => {
    event.preventDefault(); const filters = readFilters(form);
    if (['subject', 'topic'].includes(preset) && !filters.subjects.length) return toast('Choose at least one subject.');
    if (preset === 'topic' && !filters.topics.length && !filters.subtopics.length) return toast('Choose at least one topic or subtopic.');
    try { await createSession({ mode: 'test', preset, title: item[0], filters, requested: form.elements.count.value, autoSubmit: true }); }
    catch (error) { toast(error.message || 'Could not create test.', 'error'); }
  };
  updateMatchCount(form); slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function activeQuestion() { return state.active?.questions?.[state.active.index]; }
function timerText(seconds) { const value = Math.max(0, Math.floor(Number(seconds) || 0)); return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
function questionMeta(question) {
  const subjects = byId(state.meta.subjects); const platforms = byId(state.meta.platforms);
  return [subjects.get(String(question.subject_id))?.name, platforms.get(String(question.platform_id))?.name].filter(Boolean).map(e).join(' · ') || 'General';
}

function explanationBlock(question, answer, open) {
  const right = selectedKey(answer) === correctKey(question);
  return `<div class="answer-panel ${right ? 'correct-panel' : 'wrong-panel'}"><div class="row"><b>${right ? 'Correct' : `Correct answer: ${e(correctKey(question) || 'Not provided')}`}</b><button class="button ghost compact" data-action="toggle-explanation">${open ? 'Hide explanation' : 'View explanation'}</button></div>${open ? `<div class="rich-content">${question.explanation_html ? richHtml(question.explanation_html) : '<p>No explanation is available for this question.</p>'}</div>${question.source_reference || question.source_collection ? `<details class="question-info"><summary>Question info</summary><p>${e(question.source_collection || '')}${question.source_reference ? ` · ${e(question.source_reference)}` : ''}</p></details>` : ''}` : ''}</div>`;
}

function renderQuestion(question, answer, reveal) {
  const correct = correctKey(question); const selected = selectedKey(answer);
  return `<div class="question-stem rich-content">${richHtml(question.question_text)}</div>${question.image_url ? `<img class="question-image" src="${e(safeUrl(question.image_url, true))}" alt="Question illustration" />` : ''}<div class="options" role="group" aria-label="Answer choices">${question.options.map((option) => {
    const key = String(option.option_key).toUpperCase(); const classes = ['option'];
    if (selected === key) classes.push('selected'); if (reveal && key === correct) classes.push('correct'); if (reveal && selected === key && key !== correct) classes.push('wrong');
    return `<button class="${classes.join(' ')}" data-action="answer" data-key="${e(key)}" ${reveal ? 'disabled' : ''}><b>${e(option.option_key)}.</b><span class="rich-content">${richHtml(option.option_text)}</span></button>`;
  }).join('')}</div>${reveal ? explanationBlock(question, answer, state.active.explanationOpen) : ''}`;
}

function feedbackControls(answer, reveal, wrong) {
  if (!reveal) return '';
  const recall = state.active.filters?.statuses?.includes('recall_due');
  return `<div class="learning-feedback"><div><span class="field-label">Confidence</span><div class="segmented">${['sure', 'unsure', 'guess'].map((value) => `<button data-action="confidence" data-value="${value}" class="${answer.confidence === value ? 'active' : ''}">${value.toUpperCase()}</button>`).join('')}</div></div>${wrong ? `<div><span class="field-label">What happened? <small>Optional</small></span><div class="reason-chips">${[['didnt_know', "Didn't know"], ['forgot', 'Forgot'], ['misread', 'Misread'], ['confused_options', 'Confused options'], ['overthought', 'Overthought'], ['silly_mistake', 'Silly mistake'], ['guess', 'Guess']].map(([value, label]) => `<button data-action="error-reason" data-value="${value}" class="${answer.error_reason === value ? 'active' : ''}">${label}</button>`).join('')}</div></div>` : ''}${recall ? `<div><span class="field-label">Active recall response</span><div class="segmented"><button data-action="recall-response" data-value="forgot">FORGOT</button><button data-action="recall-response" data-value="partial">PARTIAL</button><button data-action="recall-response" data-value="knew">KNEW</button></div></div>` : ''}</div>`;
}

function renderActive() {
  const active = state.active; const question = activeQuestion(); if (!active || !question) return;
  const answer = active.answers[question.id]; const reveal = active.completedReview || active.kind === 'practice' && Boolean(answer?.selected_option);
  const answered = Object.values(active.answers).filter((item) => item?.selected_option).length;
  layout(`<section class="question-header"><div><span class="pill">${active.completedReview ? 'Review' : active.kind === 'test' ? e(TEST_PRESETS[active.preset]?.[0] || 'Test') : 'Practice'}</span><h1>${e(active.title || 'Question set')}</h1></div><div class="timer-cluster"><div><span>QUESTION TARGET</span><b id="question-timer">00:50</b></div><div><span>TOTAL TARGET</span><b>${timerText(active.questions.length * TARGET_SECONDS)}</b></div></div></section><div class="question-layout"><section class="card question-card"><div class="question-topline"><span>Question ${active.index + 1} of ${active.questions.length}</span><span>${questionMeta(question)}</span></div><div class="progress"><i style="width:${((active.index + 1) / active.questions.length) * 100}%"></i></div>${renderQuestion(question, answer, reveal)}${feedbackControls(answer || {}, reveal, selectedKey(answer) !== correctKey(question))}<div class="question-actions"><div class="row"><button class="button ghost ${active.bookmarks.has(question.id) ? 'active-control' : ''}" data-action="bookmark" aria-pressed="${active.bookmarks.has(question.id)}">${active.bookmarks.has(question.id) ? '★ Bookmarked' : '☆ Bookmark'}</button><button class="button ghost ${active.marked.has(question.id) ? 'active-control' : ''}" data-action="mark" aria-pressed="${active.marked.has(question.id)}">${active.marked.has(question.id) ? '✓ Marked for review' : 'Mark for review'}</button><button class="button ghost" data-action="note">Note</button><button class="button ghost" data-action="report">Report</button></div><div class="row"><button class="button secondary" data-action="previous" ${active.index === 0 ? 'disabled' : ''}>Previous</button><button class="button" data-action="next">${active.index === active.questions.length - 1 ? (active.completedReview ? 'Back to results' : 'Finish') : 'Next'}</button></div></div></section><aside class="card palette-card"><div class="section-heading"><h3>Question palette</h3><span>${answered}/${active.questions.length}</span></div><div class="palette">${active.questions.slice(0, 500).map((item, index) => `<button data-action="jump" data-index="${index}" class="${index === active.index ? 'current' : ''} ${active.answers[item.id]?.selected_option ? 'answered' : ''} ${active.marked.has(item.id) ? 'marked' : ''}" aria-label="Question ${index + 1}">${index + 1}</button>`).join('')}</div>${active.questions.length > 500 ? '<p class="subtle">Palette shows the first 500 positions; Previous/Next continues through all questions.</p>' : ''}${active.kind === 'test' && !active.completedReview ? `<p class="subtle">${active.questions.length - answered} unanswered</p><button class="button danger full" data-action="submit">Submit test</button>` : ''}</aside></div>`);
  startQuestionTimer();
}

function startQuestionTimer() {
  clearInterval(state.timer);
  const tick = () => {
    const elapsed = Math.floor((Date.now() - state.active.questionStartedAt) / 1000); const remaining = Math.max(0, TARGET_SECONDS - elapsed);
    const node = document.querySelector('#question-timer'); if (node) { node.textContent = timerText(remaining); node.classList.toggle('low', remaining <= 10); node.classList.toggle('expired', remaining === 0); }
    if (state.active.kind === 'test' && state.active.auto_submit) {
      const used = Math.floor((Date.now() - new Date(state.active.started_at).getTime()) / 1000);
      if (used >= state.active.questions.length * TARGET_SECONDS) submitActive(true);
    }
  };
  tick(); state.timer = setInterval(tick, 1000);
}

function elapsedOnQuestion() { return Math.max(0, Math.floor((Date.now() - state.active.questionStartedAt) / 1000)); }

async function recordAttempt(question, answer) {
  const args = { p_question_id: question.id, p_selected_option: answer.selected_option, p_is_correct: selectedKey(answer) === correctKey(question), p_mode: state.active.kind === 'test' ? 'test' : 'qbank', p_test_session_id: state.active.id || null, p_time_spent_seconds: answer.time_spent_seconds || 0, p_confidence: answer.confidence || null, p_error_reason: answer.error_reason || null };
  const result = await db.rpc('qbank_record_attempt', args);
  if (!result.error) return;
  if (isMissingTable(result.error) || /function .* does not exist|schema cache/i.test(result.error.message)) {
    const saved = await db.from('question_attempts').insert({ user_id: state.user.id, question_id: question.id, selected_option: answer.selected_option, is_correct: args.p_is_correct, mode: args.p_mode, answered_at: new Date().toISOString() });
    if (saved.error) toast(`Answer sync failed: ${saved.error.message}`, 'error');
  } else toast(result.error.message, 'error');
}

async function saveActiveAnswer(questionId) {
  if (!state.active.id || !state.features.sessions) return;
  const answer = state.active.answers[questionId] || {}; const question = state.active.questions.find((q) => q.id === questionId);
  const value = { session_id: state.active.id, question_id: questionId, selected_option: answer.selected_option || null, marked_for_review: state.active.marked.has(questionId), answered_at: answer.selected_option ? answer.answered_at || new Date().toISOString() : null, is_correct: answer.selected_option ? selectedKey(answer) === correctKey(question) : null, time_spent_seconds: answer.time_spent_seconds || 0, confidence: answer.confidence || null, error_reason: answer.error_reason || null };
  const saved = await optional(db.from('test_answers').upsert(value, { onConflict: 'session_id,question_id' }), 'sessions');
  if (!saved.error) await optional(db.from('test_sessions').update({ current_position: state.active.index, last_question_started_at: new Date(state.active.questionStartedAt).toISOString(), updated_at: new Date().toISOString() }).eq('id', state.active.id).eq('user_id', state.user.id), 'sessions');
}

async function selectAnswer(key) {
  const active = state.active; const question = activeQuestion(); if (!active || active.completedReview) return;
  const existing = active.answers[question.id]; if (active.kind === 'practice' && existing?.selected_option) return;
  const answer = { ...(existing || {}), selected_option: key, answered_at: new Date().toISOString(), time_spent_seconds: Math.max(existing?.time_spent_seconds || 0, elapsedOnQuestion()) };
  active.answers[question.id] = answer;
  if (active.kind === 'practice' && !existing?.selected_option) await recordAttempt(question, answer);
  await saveActiveAnswer(question.id); active.explanationOpen = false; renderActive();
}

async function navigateActive(index) {
  const active = state.active; const current = activeQuestion();
  if (current) { const answer = active.answers[current.id] || {}; answer.time_spent_seconds = Math.max(answer.time_spent_seconds || 0, elapsedOnQuestion()); active.answers[current.id] = answer; await saveActiveAnswer(current.id); }
  active.index = Math.max(0, Math.min(index, active.questions.length - 1)); active.questionStartedAt = Date.now(); active.explanationOpen = false;
  if (active.id) await optional(db.from('test_sessions').update({ current_position: active.index, last_question_started_at: new Date().toISOString() }).eq('id', active.id).eq('user_id', state.user.id), 'sessions');
  renderActive();
}

async function toggleBookmark() {
  const question = activeQuestion(); const active = state.active;
  const bookmarked = !active.bookmarks.has(question.id);
  let result = await db.rpc('qbank_set_bookmark', { p_question_id: question.id, p_bookmarked: bookmarked });
  if (result.error && /function .* does not exist|schema cache/i.test(result.error.message)) {
    result = await db.from('user_question_state').upsert({ user_id: state.user.id, question_id: question.id, bookmarked }, { onConflict: 'user_id,question_id' });
    if (!result.error) {
      const mirror = bookmarked
        ? await db.from('bookmarks').upsert({ user_id: state.user.id, question_id: question.id }, { onConflict: 'user_id,question_id' })
        : await db.from('bookmarks').delete().eq('user_id', state.user.id).eq('question_id', question.id);
      if (mirror.error) {
        await db.from('user_question_state').upsert({ user_id: state.user.id, question_id: question.id, bookmarked: !bookmarked }, { onConflict: 'user_id,question_id' });
        result = mirror;
      }
    }
  }
  if (result.error) return toast(result.error.message, 'error');
  bookmarked ? active.bookmarks.add(question.id) : active.bookmarks.delete(question.id);
  const learning = active.learning.get(question.id) || { user_id: state.user.id, question_id: question.id };
  active.learning.set(question.id, { ...learning, bookmarked });
  toast(bookmarked ? 'Bookmarked' : 'Bookmark removed');
  await saveActiveAnswer(question.id); renderActive();
}

async function toggleMark() {
  const question = activeQuestion(); const active = state.active; const marked = !active.marked.has(question.id);
  const result = await optional(db.from('user_question_state').upsert({ user_id: state.user.id, question_id: question.id, marked_for_review: marked, revision: marked }, { onConflict: 'user_id,question_id' }), 'learning');
  if (result.error) return toast(result.error.message, 'error');
  marked ? active.marked.add(question.id) : active.marked.delete(question.id); await saveActiveAnswer(question.id); renderActive();
}

async function updateAnswerMetadata(field, value) {
  const question = activeQuestion(); const answer = state.active.answers[question.id]; if (!answer) return;
  answer[field] = answer[field] === value ? null : value; await saveActiveAnswer(question.id);
  const column = field === 'confidence' ? 'last_confidence' : 'last_error_reason';
  await optional(db.from('user_question_state').upsert({ user_id: state.user.id, question_id: question.id, [column]: answer[field] }, { onConflict: 'user_id,question_id' }), 'learning');
  renderActive();
}

function modal(title, body, submitLabel = 'Save') {
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="modal"><div class="modal card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="section-heading"><h2 id="modal-title">${e(title)}</h2><button class="button ghost compact" data-action="close-modal" type="button">Close</button></div><form id="modal-form" class="stack">${body}<button class="button">${e(submitLabel)}</button></form></div></div>`);
  document.querySelector('#modal input, #modal textarea, #modal select')?.focus();
}

async function noteModal() {
  const question = activeQuestion(); const { data } = await optional(db.from('question_notes').select('*').eq('user_id', state.user.id).eq('question_id', question.id).maybeSingle());
  modal('Personal note', `<div class="field"><label>Your private note</label><textarea name="body" placeholder="Key takeaway, memory aid, or doubt…">${e(data?.body || '')}</textarea></div>`);
  document.querySelector('#modal-form').onsubmit = async (event) => {
    event.preventDefault(); const body = new FormData(event.currentTarget).get('body').trim();
    const result = !body ? await db.from('question_notes').delete().eq('user_id', state.user.id).eq('question_id', question.id) : await db.from('question_notes').upsert({ user_id: state.user.id, question_id: question.id, body }, { onConflict: 'user_id,question_id' });
    if (result.error) return toast(result.error.message, 'error'); document.querySelector('#modal')?.remove(); toast(body ? 'Note saved' : 'Note removed');
  };
}

function reportModal() {
  const question = activeQuestion();
  modal('Report question', `<div class="field"><label>What needs attention?</label><select name="reason"><option value="wrong_answer">Wrong answer</option><option value="wrong_explanation">Wrong explanation</option><option value="ambiguous">Ambiguous question</option><option value="poor_quality">Poor-quality question</option><option value="broken_image">Broken image</option><option value="other">Other</option></select></div><div class="field"><label>Details (optional)</label><textarea name="details"></textarea></div>`, 'Send report');
  document.querySelector('#modal-form').onsubmit = async (event) => { event.preventDefault(); const payload = Object.fromEntries(new FormData(event.currentTarget)); const result = await db.from('question_reports').insert({ user_id: state.user.id, question_id: question.id, ...payload }); if (result.error) return toast(result.error.message, 'error'); document.querySelector('#modal')?.remove(); toast('Thank you — report saved.'); };
}

async function resumeSession(id) {
  loading('Restoring your exact session…');
  try {
    const sessionResult = await db.from('test_sessions').select('*').eq('id', id).eq('user_id', state.user.id).single(); if (sessionResult.error) throw sessionResult.error;
    const [itemsResult, answersResult] = await Promise.all([db.from('test_session_questions').select('*').eq('session_id', id).order('position'), db.from('test_answers').select('*').eq('session_id', id)]);
    if (itemsResult.error) throw itemsResult.error;
    const questions = (itemsResult.data || []).map((item) => ({ id: item.question_id, ...item.question_snapshot, options: item.question_snapshot.options || [] }));
    const answers = Object.fromEntries((answersResult.data || []).map((answer) => [answer.question_id, answer])); const personal = await loadPersonalState(questions.map((question) => question.id)); const session = sessionResult.data;
    assertValidation(validateResumeSnapshot({ session, storedRows: itemsResult.data || [], questions, answers: answersResult.data || [] }), 'Resume');
    assertValidation(validateQuestionStateBindings({ questions, answers, bookmarks: personal.bookmarks, marked: new Set([...personal.marked, ...(answersResult.data || []).filter((answer) => answer.marked_for_review).map((answer) => answer.question_id)]) }), 'Resumed question state');
    state.active = { ...session, kind: session.mode === 'practice' ? 'practice' : 'test', questions, index: Math.min(session.current_position || 0, Math.max(questions.length - 1, 0)), answers, bookmarks: personal.bookmarks, marked: new Set([...personal.marked, ...(answersResult.data || []).filter((x) => x.marked_for_review).map((x) => x.question_id)]), learning: personal.learning, questionStartedAt: Date.now(), explanationOpen: false, completedReview: session.status !== 'in_progress' };
    renderActive();
  } catch (error) { toast(error.message || 'Could not resume session.', 'error'); location.hash = '#/home'; }
}

async function submitActive(timedOut = false) {
  const active = state.active; if (!active || active.completedReview) return;
  const answeredRows = Object.values(active.answers).filter((a) => a?.selected_option); const unanswered = active.questions.length - answeredRows.length;
  if (!timedOut && !confirm(`Finish this ${active.kind}? ${unanswered} question${unanswered === 1 ? '' : 's'} unanswered.`)) return;
  clearInterval(state.timer); const current = activeQuestion(); if (current) await saveActiveAnswer(current.id);
  let completed = null;
  if (active.id) { const result = await db.rpc('submit_test_session', { p_session_id: active.id, p_timed_out: timedOut }); if (result.error) return toast(result.error.message, 'error'); completed = result.data; }
  if (active.kind === 'test') for (const question of active.questions) { const answer = active.answers[question.id]; if (answer?.selected_option) await recordAttempt(question, answer); }
  if (Array.isArray(completed)) completed = completed[0] || null;
  const totalCorrect = completed?.total_correct ?? active.questions.filter((q) => selectedKey(active.answers[q.id]) === correctKey(q)).length;
  state.active = { ...active, ...(completed || {}), total_questions: completed?.total_questions ?? active.questions.length, total_correct: totalCorrect, incorrect_count: completed?.incorrect_count ?? answeredRows.length - totalCorrect, unanswered_count: completed?.unanswered_count ?? unanswered, total_time_seconds: completed?.total_time_seconds ?? Math.floor((Date.now() - new Date(active.started_at).getTime()) / 1000), timed_out: completed?.timed_out ?? timedOut, status: completed?.status ?? (timedOut ? 'timed_out' : 'completed'), completedReview: false };
  resultScreen();
}

function resultScreen() {
  const active = state.active; const answered = Object.values(active.answers).filter((answer) => answer?.selected_option).length;
  const average = answered ? Math.round(Object.values(active.answers).reduce((sum, answer) => sum + (answer?.time_spent_seconds || 0), 0) / answered) : 0;
  layout(`<div class="page-heading"><span class="eyebrow">${active.timed_out ? 'TIME EXPIRED' : 'COMPLETED'}</span><h1>${e(active.title || 'Result')}</h1><p>${date(new Date())}</p></div><section class="result-grid"><div class="card metric"><span>Score</span><b>${active.total_correct}/${active.total_questions}</b></div><div class="card metric"><span>Accuracy</span><b>${pct(active.total_correct, answered)}</b></div><div class="card metric"><span>Incorrect</span><b>${active.incorrect_count}</b></div><div class="card metric"><span>Unanswered</span><b>${active.unanswered_count}</b></div><div class="card metric"><span>Average time</span><b>${average}s</b></div></section><section class="card result-actions"><h2>Turn this result into action</h2><div class="row"><button class="button" data-action="review-result">Review every question</button><button class="button secondary" data-action="review-mistakes">Review incorrect</button><button class="button secondary" data-action="retake">Retake</button><a class="button ghost" href="#/history">History</a></div></section>`);
}

async function history() {
  const result = await optional(db.from('test_sessions').select('*').eq('user_id', state.user.id).neq('status', 'in_progress').order('completed_at', { ascending: false }).limit(100), 'sessions');
  layout(`<div class="page-heading"><span class="eyebrow">TEST HISTORY</span><h1>Completed sessions</h1><p>Every result leads back to its original question set.</p></div><section class="card">${result.data?.length ? `<ul class="history-list">${result.data.map((session) => `<li><div><b>${e(session.title || session.preset || 'Test')}</b><div class="subtle">${date(session.completed_at)} · ${session.total_questions} questions · ${session.total_correct} correct · ${session.incorrect_count ?? '—'} incorrect</div></div><div class="row"><span class="pill">${pct(session.total_correct, session.total_correct + (session.incorrect_count || 0))}</span><button class="button secondary" data-action="resume" data-id="${e(session.id)}">Open result</button></div></li>`).join('')}</ul>` : '<div class="empty">No completed sessions yet.</div>'}</section>`);
}

async function review() {
  const now = new Date().toISOString();
  const [learning, cards] = await Promise.all([optional(db.from('user_question_state').select('*').eq('user_id', state.user.id), 'learning'), optional(db.from('recall_card_progress').select('card_id').eq('user_id', state.user.id).lte('due_at', now), 'personal')]);
  const rows = learning.data || [];
  const sections = [['incorrect', 'Incorrect', rows.filter((x) => x.last_is_correct === false || x.wrong).length, 'Questions that produced errors.'], ['bookmarked', 'Bookmarked', rows.filter((x) => x.bookmarked).length, 'Questions saved for later.'], ['marked', 'Marked for Review', rows.filter((x) => x.marked_for_review).length, 'Questions you explicitly marked.'], ['recall_due', 'Recall Due', rows.filter((x) => x.recall_due_at && x.recall_due_at <= now).length + (cards.data?.length || 0), 'Scheduled for active recall now.'], ['confident_wrong', 'Confidently Wrong', rows.filter((x) => x.last_is_correct === false && x.last_confidence === 'sure').length, 'High-confidence misconceptions.'], ['slow', 'Slow Questions >50s', rows.filter((x) => x.last_time_seconds > TARGET_SECONDS).length, 'Questions needing faster recall.'], ['my_content', 'My Content', '—', 'Your MCQs, recall cards and notes.']];
  layout(`<div class="page-heading"><span class="eyebrow">REVIEW</span><h1>Everything worth revisiting</h1><p>Open questions directly or turn a category into a revision test.</p></div>${!state.features.learning ? featureNotice('Apply the learning-interface migration for accurate consolidated review counts.') : ''}<section class="review-grid">${sections.map(([status, title, count, description]) => `<article class="card review-card"><span class="eyebrow">${e(title)}</span><b class="review-count">${count}</b><p>${e(description)}</p><div class="row"><button class="button secondary" data-action="open-review" data-status="${status}">Open</button><button class="button" data-action="start-revision" data-status="${status}">Start revision test</button></div></article>`).join('')}</section><section class="card section-card"><div class="section-heading"><h2>Test history</h2><a class="button secondary" href="#/history">Open history</a></div></section>`);
}

async function startStatusSession(status, mode = 'practice') {
  const filters = { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], statuses: [status], pyq: '', year: '', search: '', source: '' };
  await createSession({ mode, preset: 'revision', title: `${status.replaceAll('_', ' ')} revision`, filters, requested: 50, autoSubmit: mode === 'test' });
}

async function analytics() {
  let attemptsResult = await db.from('question_attempts').select('question_id,is_correct,answered_at,time_spent_seconds,confidence').eq('user_id', state.user.id).order('answered_at', { ascending: false }).limit(5000);
  if (isMissingTable(attemptsResult.error)) attemptsResult = await db.from('question_attempts').select('question_id,is_correct,answered_at').eq('user_id', state.user.id).order('answered_at', { ascending: false }).limit(5000);
  if (attemptsResult.error) throw attemptsResult.error;
  const attempts = attemptsResult.data || []; const questionIds = [...new Set(attempts.map((row) => row.question_id))];
  const questions = questionIds.length ? await paged(() => db.from('questions').select('id,subject_id,platform_id').in('id', questionIds)) : []; const qMap = new Map(questions.map((question) => [question.id, question]));
  const aggregate = (field) => {
    const result = new Map();
    attempts.forEach((attempt) => { const key = qMap.get(attempt.question_id)?.[field]; if (!key) return; const value = result.get(key) || { correct: 0, total: 0, time: 0, timed: 0 }; value.total++; value.correct += attempt.is_correct ? 1 : 0; if (attempt.time_spent_seconds != null) { value.time += attempt.time_spent_seconds; value.timed++; } result.set(key, value); });
    return result;
  };
  const renderRows = (data, names, type) => data.size ? [...data].sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total).map(([id, value]) => `<button class="analytics-row" data-action="analytics-drill" data-type="${type}" data-id="${e(id)}"><span><b>${e(names.get(String(id))?.name || 'Unclassified')}</b><small>${value.total} attempts · ${value.timed ? Math.round(value.time / value.timed) : '—'}s avg</small></span><span>${pct(value.correct, value.total)}</span><span>Open questions →</span></button>`).join('') : '<div class="empty">No data yet.</div>';
  const correct = attempts.filter((x) => x.is_correct).length; const timed = attempts.filter((x) => x.time_spent_seconds != null);
  layout(`<div class="page-heading"><span class="eyebrow">ANALYTICS</span><h1>Performance that leads to questions</h1><p>Click any area to start a focused revision set.</p></div><section class="result-grid"><div class="card metric"><span>Overall accuracy</span><b>${pct(correct, attempts.length)}</b></div><div class="card metric"><span>Coverage</span><b>${questionIds.length}</b><small>unique questions</small></div><div class="card metric"><span>Average time</span><b>${timed.length ? `${Math.round(timed.reduce((s, x) => s + (x.time_spent_seconds || 0), 0) / timed.length)}s` : '—'}</b></div><div class="card metric"><span>Recent attempts</span><b>${attempts.length}</b></div></section><section class="analytics-grid"><div class="card"><div class="section-heading"><h2>Subject analytics</h2></div>${renderRows(aggregate('subject_id'), byId(state.meta.subjects), 'subject')}</div><div class="card"><div class="section-heading"><h2>Platform analytics</h2></div>${renderRows(aggregate('platform_id'), byId(state.meta.platforms), 'platform')}</div></section><section class="card section-card"><h2>Topic and subtopic analytics</h2><p class="subtle">Topic/subtopic filters are functional. Detailed historical drilldowns require existing questions to be mapped through question_topics and question_subtopics.</p><a class="button secondary" href="#/qbank">Open hierarchical filters</a></section>`);
}

function taxonomyOptions(items, first) { return `<option value="">${e(first)}</option>${items.map((item) => `<option value="${e(item.id)}">${e(item.name)}</option>`).join('')}`; }
function taxonomyFields() { return `<div class="filters"><div class="field"><label>Platform (optional)</label><select name="platform_id">${taxonomyOptions(state.meta.platforms, 'My Content / no platform')}</select></div><div class="field"><label>Subject</label><select name="subject_id">${taxonomyOptions(state.meta.subjects, 'Choose subject')}</select></div><div class="field"><label>System (optional)</label><select name="system_id">${taxonomyOptions(state.meta.systems, 'No system')}</select></div><div class="field"><label>Topic</label><select name="topic_id">${taxonomyOptions(state.meta.topics, 'Choose topic')}</select></div><div class="field"><label>Subtopic</label><select name="subtopic_id">${taxonomyOptions(state.meta.subtopics, 'Choose subtopic')}</select></div></div>`; }

async function myBank() {
  const [questions, cards, notes] = await Promise.all([optional(db.from('questions').select('*', { count: 'exact', head: true }).eq('created_by', state.user.id), 'personal'), optional(db.from('recall_cards').select('*', { count: 'exact', head: true }).eq('user_id', state.user.id), 'personal'), optional(db.from('personal_notes').select('*', { count: 'exact', head: true }).eq('user_id', state.user.id), 'personal')]);
  layout(`<div class="page-heading"><span class="eyebrow">MY BANK</span><h1>Your own learning material</h1><p>Personal MCQs enter the same QBank and test engine as imported questions.</p></div>${!state.features.personal ? featureNotice('Apply the learning-interface migration to add personal MCQs, recall cards and notes.') : ''}<section class="result-grid"><div class="card metric"><span>My MCQs</span><b>${questions.count || 0}</b></div><div class="card metric"><span>Recall cards</span><b>${cards.count || 0}</b></div><div class="card metric"><span>Notes</span><b>${notes.count || 0}</b></div><div class="card metric"><span>Imported pool</span><b>Protected</b><small>never reset or deleted</small></div></section><section class="tab-row"><button class="button" data-action="my-bank-tab" data-tab="mcq">Add MCQ</button><button class="button secondary" data-action="my-bank-tab" data-tab="card">Add Recall Card</button><button class="button secondary" data-action="my-bank-tab" data-tab="note">Add Note</button><button class="button secondary" data-action="my-bank-tab" data-tab="reset">Reset Learning State</button></section><section id="my-bank-editor" class="card section-card"></section>`);
  showMyBankTab('mcq');
}

function showMyBankTab(tab) {
  const holder = document.querySelector('#my-bank-editor'); if (!holder) return;
  if (tab === 'mcq') holder.innerHTML = `<h2>Add a personal MCQ</h2><form id="personal-mcq-form" class="stack"><div class="field"><label>Question</label><textarea name="question_text" required></textarea></div><div class="filters">${['A', 'B', 'C', 'D'].map((key) => `<div class="field"><label>Option ${key}</label><input name="option_${key}" required /></div>`).join('')}</div><div class="field"><label>Correct answer</label><select name="correct_answer"><option>A</option><option>B</option><option>C</option><option>D</option></select></div><div class="field"><label>Explanation</label><textarea name="explanation_html"></textarea></div>${taxonomyFields()}<div class="filters"><div class="field"><label>Source (optional)</label><input name="source_reference" /></div><div class="field"><label>Personal tags</label><input name="tags" placeholder="comma separated" /></div></div><button class="button">Save MCQ</button></form>`;
  if (tab === 'card') holder.innerHTML = `<h2>Add a recall card / fact</h2><form id="recall-card-form" class="stack"><div class="field"><label>Front / prompt</label><textarea name="front" required></textarea></div><div class="field"><label>Back / answer</label><textarea name="back_html" required></textarea></div>${taxonomyFields()}<button class="button">Save recall card</button></form>`;
  if (tab === 'note') holder.innerHTML = `<h2>Add a note</h2><form id="personal-note-form" class="stack"><div class="field"><label>Title</label><input name="title" required /></div><div class="field"><label>Note</label><textarea name="body_html" required></textarea></div>${taxonomyFields()}<button class="button">Save note</button></form>`;
  if (tab === 'reset') holder.innerHTML = `<h2>Reset learning state</h2><p class="notice">Imported questions are never deleted. Bookmarks and notes are preserved by default.</p><form id="reset-form" class="stack"><div class="filters"><div class="field"><label>Scope</label><select name="scope"><option value="all">All learning progress</option><option value="subject">Subject</option><option value="topic">Topic</option><option value="subtopic">Subtopic</option></select></div><div class="field"><label>Subject</label><select name="subject_id">${taxonomyOptions(state.meta.subjects, 'Choose subject')}</select></div><div class="field"><label>Topic</label><select name="topic_id">${taxonomyOptions(state.meta.topics, 'Choose topic')}</select></div><div class="field"><label>Subtopic</label><select name="subtopic_id">${taxonomyOptions(state.meta.subtopics, 'Choose subtopic')}</select></div></div><label class="check-row"><input type="checkbox" name="remove_bookmarks" /> Also remove bookmarks</label><label class="check-row"><input type="checkbox" name="remove_notes" /> Also remove private notes</label><button class="button danger">Reset selected learning data</button></form>`;
  const form = holder.querySelector('form'); if (!form) return;
  if (form.id === 'personal-mcq-form') form.onsubmit = savePersonalMcq;
  if (form.id === 'recall-card-form') form.onsubmit = saveRecallCard;
  if (form.id === 'personal-note-form') form.onsubmit = savePersonalNote;
  if (form.id === 'reset-form') form.onsubmit = resetLearning;
}

async function savePersonalMcq(event) {
  event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget));
  const created = await db.from('questions').insert({ question_text: value.question_text, correct_answer: value.correct_answer, explanation_html: value.explanation_html || null, subject_id: value.subject_id || null, platform_id: value.platform_id || null, system_id: value.system_id || null, source_reference: value.source_reference || null, source_collection: 'My Content', created_by: state.user.id, content_origin: 'user', status: 'draft', is_pyq: false }).select().single();
  if (created.error) return toast(created.error.message, 'error');
  const options = ['A', 'B', 'C', 'D'].map((key) => ({ question_id: created.data.id, option_key: key, option_text: value[`option_${key}`] })); const saved = await db.from('question_options').insert(options); if (saved.error) return toast(saved.error.message, 'error');
  if (value.topic_id) await optional(db.from('question_topics').insert({ question_id: created.data.id, topic_id: value.topic_id }));
  if (value.subtopic_id) await optional(db.from('question_subtopics').insert({ question_id: created.data.id, subtopic_id: value.subtopic_id }), 'subtopics');
  if (value.tags?.trim()) for (const name of [...new Set(value.tags.split(',').map((tag) => tag.trim()).filter(Boolean))]) { const tag = await db.from('personal_tags').upsert({ user_id: state.user.id, name }, { onConflict: 'user_id,name' }).select().single(); if (!tag.error) await db.from('question_personal_tags').upsert({ user_id: state.user.id, question_id: created.data.id, tag_id: tag.data.id }); }
  toast('Personal MCQ saved and available under My Content.'); myBank();
}

async function saveRecallCard(event) {
  event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget));
  const result = await db.from('recall_cards').insert({ user_id: state.user.id, front: value.front, back_html: value.back_html, subject_id: value.subject_id || null, system_id: value.system_id || null, topic_id: value.topic_id || null, subtopic_id: value.subtopic_id || null }).select().single();
  if (result.error) return toast(result.error.message, 'error'); await db.from('recall_card_progress').insert({ user_id: state.user.id, card_id: result.data.id, due_at: new Date().toISOString() }); toast('Recall card saved and due now.'); myBank();
}

async function savePersonalNote(event) {
  event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget));
  const result = await db.from('personal_notes').insert({ user_id: state.user.id, title: value.title, body_html: value.body_html, subject_id: value.subject_id || null, topic_id: value.topic_id || null, subtopic_id: value.subtopic_id || null }); if (result.error) return toast(result.error.message, 'error'); toast('Note saved.'); myBank();
}

async function resetLearning(event) {
  event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget)); const scope = value.scope; const entity = value[`${scope}_id`];
  if (scope !== 'all' && !entity) return toast(`Choose a ${scope}.`);
  if (scope === 'all') { if (prompt('Type RESET to remove all personal learning progress. Imported questions remain untouched.') !== 'RESET') return; }
  else if (!confirm(`Reset learning state for this ${scope}? Imported questions remain untouched.`)) return;
  let questionIds = null;
  if (scope === 'subject') questionIds = (await paged(() => db.from('questions').select('id').eq('subject_id', entity))).map((row) => row.id);
  if (scope === 'topic') questionIds = unique((await db.from('question_topics').select('question_id').eq('topic_id', entity)).data);
  if (scope === 'subtopic') questionIds = unique((await db.from('question_subtopics').select('question_id').eq('subtopic_id', entity)).data);
  for (const table of ['question_attempts', 'user_question_state', 'review_queue']) { let query = db.from(table).delete().eq('user_id', state.user.id); if (questionIds) query = query.in('question_id', questionIds); const result = await optional(query); if (result.error && !result.missing) return toast(result.error.message, 'error'); }
  if (scope === 'all') { await optional(db.from('test_sessions').delete().eq('user_id', state.user.id)); await optional(db.from('recall_card_progress').delete().eq('user_id', state.user.id)); }
  if (value.remove_bookmarks) { let query = db.from('bookmarks').delete().eq('user_id', state.user.id); if (questionIds) query = query.in('question_id', questionIds); await query; }
  if (value.remove_notes) { let query = db.from('question_notes').delete().eq('user_id', state.user.id); if (questionIds) query = query.in('question_id', questionIds); await query; }
  toast('Selected learning state reset. Imported questions were preserved.'); myBank();
}

async function analyticsDrill(type, id) {
  const filters = { platforms: type === 'platform' ? [id] : [], subjects: type === 'subject' ? [id] : [], systems: [], topics: type === 'topic' ? [id] : [], subtopics: type === 'subtopic' ? [id] : [], statuses: ['incorrect'], pyq: '', year: '', search: '', source: '' };
  await createSession({ mode: 'practice', preset: 'analytics', title: 'Analytics revision', filters, requested: 50, autoSubmit: false });
}

async function recordRecallResponse(value) {
  const question = activeQuestion();
  const result = await db.rpc('qbank_review_question', { p_question_id: question.id, p_response: value });
  if (result.error) return toast(result.error.message, 'error');
  toast(`Recall scheduled: ${value}.`);
}

async function render() {
  clearInterval(state.timer); state.route = route(); if (!state.user) return auth();
  try {
    await loadMeta();
    if (state.route === 'home') return home(); if (state.route === 'qbank') return qbank(); if (state.route === 'tests') return tests(); if (state.route === 'review') return review(); if (state.route === 'analytics') return analytics(); if (state.route === 'my-bank' || state.route === 'manage') return myBank(); if (state.route === 'history') return history(); return home();
  } catch (error) { console.error(error); layout(`<div class="card notice"><b>Something went wrong.</b><p>${e(error.message || 'Please try again.')}</p><button class="button secondary" data-action="retry">Try again</button></div>`); }
}

function auth() {
  root.innerHTML = `<main class="shell auth"><section class="card"><span class="eyebrow">PRIVATE MEDICAL QBANK</span><h1>QBank Hub</h1><p class="subtle">Study, test, review and recall from one question pool.</p>${initError ? `<div class="notice">${e(initError)}</div>` : ''}<form id="auth-form" class="stack"><div class="field"><label for="auth-email">Email</label><input id="auth-email" required name="email" type="email" autocomplete="email" /></div><div class="field"><label for="auth-password">Password</label><input id="auth-password" required name="password" type="password" autocomplete="current-password" minlength="6" /></div><button class="button" ${db ? '' : 'disabled'}>Sign in</button><button class="button secondary" type="button" data-action="signup" ${db ? '' : 'disabled'}>Create account</button><button class="button ghost" type="button" data-action="reset-password" ${db ? '' : 'disabled'}>Reset password</button></form></section></main>`;
  document.querySelector('#auth-form').onsubmit = signIn;
}

async function signIn(event) {
  event.preventDefault();
  if (!db) return toast(initError, 'error');
  const value = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const { error } = await withAuthTimeout(db.auth.signInWithPassword(value));
    if (error) toast(error.message, 'error');
  } catch (error) {
    toast(error.message || 'Sign in did not complete. Please try again.', 'error');
  }
}
async function signUp() { const form = document.querySelector('#auth-form'); if (!form?.reportValidity()) return; const { data, error } = await db.auth.signUp(Object.fromEntries(new FormData(form))); if (error) return toast(error.message, 'error'); toast(data.session ? 'Account created.' : 'Account created. Check your email to confirm.'); }
async function resetPassword() { const email = document.querySelector('[name="email"]')?.value.trim(); if (!email) return toast('Enter your email first.'); const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin }); toast(error ? error.message : 'Password reset email sent.', error ? 'error' : ''); }

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]'); if (!target) return; const action = target.dataset.action;
  if (action === 'signout') await db.auth.signOut(); if (action === 'signup') await signUp(); if (action === 'reset-password') await resetPassword(); if (action === 'retry') render();
  if (action === 'choose-preset') showTestBuilder(target.dataset.preset); if (action === 'close-builder') document.querySelector('#test-builder-slot').innerHTML = '';
  if (action === 'answer') await selectAnswer(target.dataset.key); if (action === 'previous') await navigateActive(state.active.index - 1);
  if (action === 'next') { if (state.active.index === state.active.questions.length - 1) { if (state.active.completedReview) return resultScreen(); return submitActive(false); } await navigateActive(state.active.index + 1); }
  if (action === 'jump') await navigateActive(Number(target.dataset.index)); if (action === 'bookmark') await toggleBookmark(); if (action === 'mark') await toggleMark();
  if (action === 'toggle-explanation') { state.active.explanationOpen = !state.active.explanationOpen; renderActive(); }
  if (action === 'confidence') await updateAnswerMetadata('confidence', target.dataset.value); if (action === 'error-reason') await updateAnswerMetadata('error_reason', target.dataset.value);
  if (action === 'recall-response') await recordRecallResponse(target.dataset.value);
  if (action === 'note') await noteModal(); if (action === 'report') reportModal(); if (action === 'close-modal') document.querySelector('#modal')?.remove(); if (action === 'submit') await submitActive(false); if (action === 'resume') await resumeSession(target.dataset.id);
  if (action === 'review-result') { state.active.index = 0; state.active.completedReview = true; state.active.questionStartedAt = Date.now(); renderActive(); }
  if (action === 'review-mistakes') { const questions = state.active.questions.filter((q) => state.active.answers[q.id]?.selected_option && selectedKey(state.active.answers[q.id]) !== correctKey(q)); if (!questions.length) return toast('No incorrect questions in this session.'); state.active = { ...state.active, questions, index: 0, completedReview: true, questionStartedAt: Date.now() }; renderActive(); }
  if (action === 'retake') await createSession({ mode: state.active.kind, preset: state.active.preset || 'retake', title: `${state.active.title || 'Test'} retake`, filters: state.active.filters || {}, requested: state.active.questions.length, autoSubmit: state.active.kind === 'test' });
  if (action === 'open-review') await startStatusSession(target.dataset.status, 'practice'); if (action === 'start-revision') await startStatusSession(target.dataset.status, 'test');
  if (action === 'quick-subject') await analyticsDrill('subject', target.dataset.id); if (action === 'analytics-drill') await analyticsDrill(target.dataset.type, target.dataset.id); if (action === 'my-bank-tab') showMyBankTab(target.dataset.tab);
});

document.addEventListener('keydown', (event) => { if (event.key === 'Escape') document.querySelector('#modal')?.remove(); });
window.addEventListener('hashchange', render);

async function bootstrap() {
  loading(); state.user = await requireUser();
  if (db) {
    db.auth.onAuthStateChange((_event, session) => {
      state.user = session?.user || null;
      state.meta.subjects = [];
      setTimeout(render, 0);
    });
    if (state.user) {
      try { await loadMeta(); } catch (error) { console.error('Startup metadata failed', error); }
    }
  }
  render();
}

bootstrap();
