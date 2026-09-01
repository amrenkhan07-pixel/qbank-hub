import { db, initError, isMissingTable, requireUser, withAuthTimeout } from './supabase.js';
import { analyticsMetadataCapabilities, analyticsTopicSubtopicRedundant, assertValidation, buildTaxonomyIndex, filterAnalyticsPopulation, resolveTaxonomyCascade, validateGeneratedQuestionSet, validateQuestionStateBindings, validateResumeSnapshot } from './validation.js?v=20260901-prepladder-hybrid';
import { runTaxonomyDomRegression } from './taxonomy-dom-regression.js?v=20260828-dom-regression';

const root = document.querySelector('#app');
const TARGET_SECONDS = 50;
const PAGE_SIZE = 500;
const filterCountRequests = new WeakMap();
const state = {
  user: null,
  route: 'home',
  meta: { subjects: [], platforms: [], systems: [], topics: [], subtopics: [], sourceTests: [], tags: [], questionTaxonomy: [] },
  active: null,
  pendingSet: null,
  actionSets: new Map(),
  lastBuilder: null,
  reviewFilters: null,
  analyticsFilters: null,
  analyticsBreakdown: null,
  analyticsView: null,
  payloadCache: new Map(),
  timer: null,
  filterTimer: null,
  features: { learning: true, subtopics: true, sessions: true, personal: true },
};

const e = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const date = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : '—';
const pct = (a, b) => b ? `${Math.round((a / b) * 100)}%` : '—';
const route = () => location.hash.replace(/^#\/?/, '').split('?')[0] || 'home';
const goToHash = (target) => { if (location.hash === target) render(); else location.hash = target; };
const unique = (rows, key = 'question_id') => [...new Set((rows || []).map((row) => row[key]).filter(Boolean))];
const byId = (rows) => new Map((rows || []).map((row) => [String(row.id), row]));
const keyList = (value) => [...new Set(String(value || '').toUpperCase().split(',').map((key) => key.trim()).filter(Boolean))].sort();
const correctKeys = (question) => keyList(question.correct_option_keys?.join(',') || question.correct_answer);
const correctKey = (question) => correctKeys(question)[0] || '';
const selectedKey = (answer) => String(answer?.selected_option || '').toUpperCase();
const selectedKeys = (answer) => keyList(answer?.selected_option);
const isAnswerCorrect = (question, answer) => correctKeys(question).join(',') === selectedKeys(answer).join(',');
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
  const [subjects, platforms, platformSubjects, systems, topics, subtopics, sourceTests, tags, questionTaxonomy] = await Promise.all([
    db.from('subjects').select('id,name').order('name'),
    db.from('platforms').select('id,name').order('name'),
    db.from('platform_subjects').select('id,subject_id'),
    optional(db.from('systems').select('id,name,platform_subject_id').order('sort_order').order('name')),
    optional(db.from('topics').select('id,name,platform_subject_id,system_id,parent_topic_id').order('sort_order').order('name')),
    optional(db.from('subtopics').select('id,name,topic_id').order('sort_order').order('name'), 'subtopics'),
    optional(db.from('qbank_source_tests').select('id,title,platform_id,subject_id,sequence,declared_question_count,is_pyq').order('sequence'), 'hybrid'),
    optional(db.from('tags').select('id,name').order('name')),
    paged(() => db.from('questions').select('id,platform_id,subject_id,system_id,is_pyq,is_inicet,is_neet_pg,exam_tags,exam_year,exam_shift,question_topics(topic_id),question_subtopics(subtopic_id)')),
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
    sourceTests: (sourceTests.data || []).map((test) => ({ ...test, name: test.title })),
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

function filterFields({ revision = false, sourceTests = false } = {}) {
  return `${multiPicker('platforms', 'Platforms', state.meta.platforms)}${multiPicker('subjects', 'Subjects', state.meta.subjects)}${multiPicker('systems', 'Systems (optional)', state.meta.systems)}${multiPicker('topics', 'Topics', state.meta.topics, 'Choose a subject first')}${multiPicker('subtopics', 'Subtopics', state.meta.subtopics, 'Choose a topic first')}${sourceTests && state.meta.sourceTests.length ? multiPicker('source_tests', 'Source Tests (optional)', state.meta.sourceTests) : ''}${statusPicker(revision)}<div class="field"><label>PYQ</label><select name="pyq"><option value="">All questions</option><option value="yes">PYQ only</option></select></div><div class="field"><label>Exam year/session</label><input name="year" type="number" min="1950" max="2100" placeholder="e.g. 2024" /></div><div class="field wide"><label>Search question text</label><input name="search" placeholder="e.g. thyroid, ECG, nephrotic" /></div><div class="field wide"><label>Source / collection</label><input name="source" placeholder="Cerebellum, Marrow, PrepLadder, BTR…" /></div>`;
}

function readMulti(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((node) => node.value);
}

function readFilters(form) {
  const raw = Object.fromEntries(new FormData(form));
  return {
    platforms: readMulti(form, 'platforms'), subjects: readMulti(form, 'subjects'), systems: readMulti(form, 'systems'),
    topics: readMulti(form, 'topics'), subtopics: readMulti(form, 'subtopics'), statuses: readMulti(form, 'statuses'),
    source_tests: readMulti(form, 'source_tests'), exams: readMulti(form, 'exams'), years: readMulti(form, 'years'), sessions: readMulti(form, 'sessions'),
    pyq: raw.pyq || '', srm: raw.srm || '', year: raw.year || '', search: raw.search?.trim() || '', source: raw.source?.trim() || '',
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
    const selectedPlatforms = new Set(cascade.selected.platforms); const selectedSubjects = new Set(cascade.selected.subjects);
    form.querySelectorAll('[data-multi-field="source_tests"] input').forEach((input) => {
      const item = state.meta.sourceTests.find((test) => String(test.id) === input.value);
      const visible = Boolean(item) && (!selectedPlatforms.size || selectedPlatforms.has(String(item.platform_id)))
        && (!selectedSubjects.size || selectedSubjects.has(String(item.subject_id))) && Number(item.declared_question_count) > 0;
      const row = input.closest('.check-row'); row.hidden = !visible; row.style.display = visible ? '' : 'none';
      if (!visible) input.checked = false;
    });
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
  if (statuses.has('attempted')) add(unique(await paged(() => db.from('question_attempts').select('question_id').eq('user_id', state.user.id))));
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
  if (filters.source_tests?.length) {
    const result = await optional(db.from('qbank_source_occurrences').select('question_id').in('source_test_id', filters.source_tests).eq('is_current', true), 'hybrid');
    candidate = intersect(candidate, new Set(unique(result.data)));
  }
  if (filters.exams?.length) {
    const examIds = new Set();
    for (const exam of filters.exams) {
      const rows = await paged(() => {
        let query = db.from('questions').select('id');
        if (exam === 'inicet') query = query.eq('is_inicet', true);
        else if (exam === 'neet_pg') query = query.eq('is_neet_pg', true);
        else query = query.contains('exam_tags', [exam]);
        return query;
      });
      rows.forEach((row) => examIds.add(row.id));
    }
    candidate = intersect(candidate, examIds);
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
  if (filters.pyq === 'no') query = query.eq('is_pyq', false);
  if (filters.years?.length) query = query.in('exam_year', filters.years.map(Number));
  if (filters.sessions?.length) query = query.in('exam_shift', filters.sessions);
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

async function sha256Buffer(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function decodePayloadObject(object) {
  if (state.payloadCache.has(object.object_path)) return state.payloadCache.get(object.object_path);
  const downloaded = await db.storage.from('qbank-payloads').download(object.object_path);
  if (downloaded.error) throw downloaded.error;
  const compressed = await downloaded.data.arrayBuffer();
  if (await sha256Buffer(compressed) !== object.sha256) throw new Error(`Payload checksum failed: ${object.object_path}`);
  let decoded = compressed;
  if (object.compression === 'gzip') {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot decompress QBank payloads.');
    decoded = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  const payload = JSON.parse(new TextDecoder().decode(decoded));
  if (payload.schema_version !== 1 || !Array.isArray(payload.questions)) throw new Error('Unsupported QBank payload schema.');
  state.payloadCache.set(object.object_path, payload);
  return payload;
}

async function sourceContext(questionIds, filters = {}) {
  if (!questionIds.length) return new Map();
  const rows = [];
  for (let index = 0; index < questionIds.length; index += 200) {
    let query = db.from('qbank_source_occurrences').select('question_id,question_position,source_question_id,source_test_id,qbank_source_tests(title,sequence,is_pyq)').in('question_id', questionIds.slice(index, index + 200)).eq('is_current', true);
    if (filters.source_tests?.length) query = query.in('source_test_id', filters.source_tests);
    const result = await optional(query, 'hybrid'); if (!result.error) rows.push(...(result.data || []));
  }
  rows.sort((left, right) => Number(left.qbank_source_tests?.sequence || 0) - Number(right.qbank_source_tests?.sequence || 0) || left.question_position - right.question_position);
  const context = new Map(); rows.forEach((row) => { if (!context.has(String(row.question_id))) context.set(String(row.question_id), row); });
  return context;
}

async function hydrateHybridQuestions(questions, options, filters = {}) {
  const missingIds = questions.filter((question) => !(options.get(question.id) || []).length).map((question) => question.id);
  if (!missingIds.length) return questions.map((question) => ({ ...question, options: options.get(question.id) || [] }));
  const refs = [];
  for (let index = 0; index < missingIds.length; index += 200) {
    const result = await optional(db.from('qbank_question_payloads').select('question_id,payload_index,correct_option_keys,media_status,qbank_payload_objects!inner(object_path,sha256,compression)').in('question_id', missingIds.slice(index, index + 200)), 'hybrid');
    if (!result.error) refs.push(...(result.data || []));
  }
  const context = await sourceContext(missingIds, filters); const byQuestion = new Map();
  for (const ref of refs) {
    const object = ref.qbank_payload_objects; const document = await decodePayloadObject(object);
    const payload = document.questions[Number(ref.payload_index)];
    if (!payload) throw new Error(`Payload index is missing for question ${ref.question_id}`);
    const media = payload.media || []; const source = context.get(String(ref.question_id));
    byQuestion.set(String(ref.question_id), {
      question_text: payload.question_html,
      explanation_html: payload.explanation_html,
      correct_answer: (payload.correct_keys || ref.correct_option_keys || []).join(','),
      correct_option_keys: payload.correct_keys || ref.correct_option_keys || [],
      options: (payload.options || []).map((option, position) => ({ question_id: ref.question_id, option_key: option.key, option_text: option.html, is_correct: option.is_correct, sort_order: position })),
      question_images: media.filter((item) => item.placement === 'question').map((item) => item.reference),
      explanation_images: media.filter((item) => item.placement === 'explanation').map((item) => item.reference),
      image_url: media.find((item) => item.placement === 'question')?.reference || '',
      source_test_label: source?.qbank_source_tests?.title || document.source_test?.title || '',
      source_question_id: source?.source_question_id || '', source_position: source?.question_position || null,
      media_status: ref.media_status, audio: payload.audio || null, video_url: payload.video || '',
    });
  }
  return questions.map((question) => ({ ...question, options: options.get(question.id) || [], ...(byQuestion.get(String(question.id)) || {}) }));
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
  const hydrated = await hydrateHybridQuestions(rows, options, filters);
  return Promise.all(hydrated.map(async (question) => {
    let imageUrl = question.image_url || '';
    if (!imageUrl && question.image_path) { const signed = await db.storage.from('question-media').createSignedUrl(question.image_path, 3600); imageUrl = signed.data?.signedUrl || ''; }
    return { ...question, image_url: imageUrl };
  }));
}

async function loadQuestionsByIds(questionIds, filters = {}) {
  const ordered = [...new Set((questionIds || []).map(String).filter(Boolean))];
  const rows = [];
  for (let index = 0; index < ordered.length; index += 200) {
    const result = await db.from('questions').select('*').in('id', ordered.slice(index, index + 200));
    if (result.error) throw result.error;
    rows.push(...(result.data || []));
  }
  const byQuestion = new Map(rows.map((question) => [String(question.id), question]));
  const questions = ordered.map((id) => byQuestion.get(id)).filter(Boolean);
  const options = await batchOptions(questions.map((question) => question.id));
  const hydrated = await hydrateHybridQuestions(questions, options, filters);
  return Promise.all(hydrated.map(async (question) => {
    let imageUrl = question.image_url || '';
    if (!imageUrl && question.image_path) { const signed = await db.storage.from('question-media').createSignedUrl(question.image_path, 3600); imageUrl = signed.data?.signedUrl || ''; }
    return { ...question, image_url: imageUrl };
  }));
}

async function matchingQuestionIds(filters) {
  const candidate = await candidateIds(filters);
  if (candidate && !candidate.size) return [];
  if (candidate && candidate.size <= 400) {
    const query = applyDirectFilters(db.from('questions').select('id'), filters).in('id', [...candidate]);
    const { data, error } = await query; if (error) throw error;
    return (data || []).map((row) => row.id);
  }
  const rows = await paged(() => applyDirectFilters(db.from('questions').select('id'), filters));
  const valid = new Set(rows.map((row) => row.id).filter((id) => !candidate || candidate.has(id)));
  if (filters.source_tests?.length) {
    const occurrences = await optional(db.from('qbank_source_occurrences').select('question_id,question_position,qbank_source_tests!inner(sequence)').in('source_test_id', filters.source_tests).eq('is_current', true).order('question_position'), 'hybrid');
    const ordered = (occurrences.data || []).sort((left, right) => Number(left.qbank_source_tests?.sequence || 0) - Number(right.qbank_source_tests?.sequence || 0) || left.question_position - right.question_position).map((row) => row.question_id);
    return [...new Set(ordered.filter((id) => valid.has(id)))];
  }
  return [...valid];
}

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

async function prepareQuestionSet({ mode = 'test', preset = 'custom', title = 'Question set', filters, requested = 'all', autoSubmit = true, questionIds = null, origin = '#/qbank' }) {
  loading('Building your exact question set…');
  const normalizedFilters = { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], statuses: ['all'], pyq: '', year: '', search: '', source: '', ...(filters || {}) };
  const population = questionIds ? [...new Set(questionIds.map(String))] : await matchingQuestionIds(normalizedFilters);
  const requestedCount = requested === 'all' ? population.length : Math.min(population.length, Math.max(1, Number(requested) || 10));
  const selectedIds = questionIds ? population : shuffled(population).slice(0, requestedCount);
  const questions = await loadQuestionsByIds(selectedIds, normalizedFilters);
  const membership = await validationMembership(normalizedFilters, questions);
  assertValidation(validateGeneratedQuestionSet({ questions, filters: normalizedFilters, requested: selectedIds.length, matchingCount: questionIds ? selectedIds.length : population.length, ...membership }), 'Generated question set');
  if (!questions.length) throw new Error('No questions match those filters.');
  return { mode, preset, title, filters: normalizedFilters, requested, autoSubmit, origin, questionIds: selectedIds, questions, matchingCount: population.length, targetSeconds: questions.length * TARGET_SECONDS };
}

function taxonomySummary(questionSet) {
  const names = (items, ids) => {
    const lookup = byId(items);
    const values = (ids || []).map((id) => lookup.get(String(id))?.name).filter(Boolean);
    return values.length ? values.join(', ') : 'All applicable';
  };
  return {
    platforms: names(state.meta.platforms, questionSet.filters.platforms),
    subjects: names(state.meta.subjects, questionSet.filters.subjects),
    topics: names(state.meta.topics, questionSet.filters.topics),
    subtopics: names(state.meta.subtopics, questionSet.filters.subtopics),
  };
}

function registerActionSet(definition) {
  const token = `set-${Date.now()}-${state.actionSets.size + 1}`;
  state.actionSets.set(token, { origin: `#/${state.route}`, ...definition, questionIds: [...new Set((definition.questionIds || []).map(String))] });
  return token;
}

function actionSetButtons(definition, testLabel = 'Start test') {
  if (!definition.questionIds?.length) return '<span class="subtle">No matching questions</span>';
  const token = registerActionSet(definition);
  return `<div class="row"><button class="button secondary compact" data-action="open-action-set" data-set="${e(token)}">Open questions</button><button class="button compact" data-action="preview-action-set" data-set="${e(token)}">${e(testLabel)}</button></div>`;
}

function readyScreen(questionSet) {
  state.pendingSet = questionSet;
  const summary = taxonomySummary(questionSet);
  layout(`<div class="page-heading"><span class="eyebrow">READY</span><h1>${e(questionSet.title)}</h1><p>Your exact question set is frozen. Nothing starts until you press START TEST.</p></div><section class="card ready-card"><div class="result-grid"><div class="metric"><span>Questions</span><b>${questionSet.questions.length}</b></div><div class="metric"><span>Per question</span><b>50s</b></div><div class="metric"><span>Total target</span><b>${timerText(questionSet.targetSeconds)}</b></div><div class="metric"><span>Mode</span><b>${questionSet.mode === 'practice' ? 'Practice' : 'Test'}</b></div></div><dl class="ready-summary"><div><dt>Platforms</dt><dd>${e(summary.platforms)}</dd></div><div><dt>Subjects</dt><dd>${e(summary.subjects)}</dd></div><div><dt>Topics</dt><dd>${e(summary.topics)}</dd></div><div><dt>Subtopics</dt><dd>${e(summary.subtopics)}</dd></div></dl><div class="row"><button class="button large" data-action="start-pending-test">START TEST</button><button class="button secondary" data-action="cancel-question-set">BACK / CANCEL</button></div></section>`);
}

async function createSession(definition) {
  try { readyScreen(await prepareQuestionSet(definition)); }
  catch (error) { toast(error.message || 'Could not build question set.', 'error'); goToHash(definition.origin || '#/qbank'); }
}

async function openQuestionSet(definition) {
  try {
    const questionSet = await prepareQuestionSet({ ...definition, mode: 'browse', autoSubmit: false });
    const personal = await loadPersonalState(questionSet.questionIds);
    const recent = [];
    for (let index = 0; index < questionSet.questionIds.length; index += 200) {
      const result = await db.from('question_attempts').select('question_id,selected_option,is_correct,answered_at,time_spent_seconds,confidence,error_reason').eq('user_id', state.user.id).in('question_id', questionSet.questionIds.slice(index, index + 200)).order('answered_at', { ascending: false });
      if (!result.error) recent.push(...(result.data || []));
    }
    const answers = {};
    recent.forEach((answer) => { if (!answers[answer.question_id]) answers[answer.question_id] = answer; });
    state.active = { ...questionSet, kind: 'browse', testMode: definition.mode === 'practice' ? 'practice' : 'test', index: 0, answers, bookmarks: personal.bookmarks, marked: personal.marked, learning: personal.learning, questionStartedAt: null, explanationOpen: false, completedReview: true };
    renderActive();
  } catch (error) { toast(error.message || 'Could not open questions.', 'error'); goToHash(definition.origin || '#/qbank'); }
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

async function startPendingSession() {
  const questionSet = state.pendingSet; if (!questionSet) return;
  const { mode, preset, title, filters, autoSubmit, questions } = questionSet;
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
      question_snapshot: { question_text: q.question_text, correct_answer: q.correct_answer, correct_option_keys: q.correct_option_keys || correctKeys(q), explanation_html: q.explanation_html, source_reference: q.source_reference, source_collection: q.source_collection, source_test_label: q.source_test_label, source_position: q.source_position, media_status: q.media_status, image_url: q.image_url, subject_id: q.subject_id, platform_id: q.platform_id, system_id: q.system_id, options: q.options },
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
  state.pendingSet = null;
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
    logs.forEach((row) => { const id = questionSubject.get(row.question_id); if (!id) return; const value = tally.get(id) || { correct: 0, total: 0, incorrectIds: new Set() }; value.correct += row.is_correct ? 1 : 0; value.total++; if (!row.is_correct) value.incorrectIds.add(String(row.question_id)); tally.set(id, value); });
    const names = byId(state.meta.subjects);
    weak = [...tally].filter(([, value]) => value.total >= 2 && value.incorrectIds.size).sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total).slice(0, 3).map(([id, value]) => ({ id, name: names.get(String(id))?.name || 'Unclassified', accuracy: pct(value.correct, value.total), questionIds: [...value.incorrectIds] }));
  }
  layout(`<section class="home-hero"><div><span class="eyebrow">YOUR STUDY PLAN</span><h1>What should you do next?</h1><p class="subtle">One clear action, based on your real learning state.</p></div><a class="button large" href="${recommendation.route}">${e(recommendation.label)}</a></section>
  <section class="action-grid">${active ? `<article class="card action-card priority"><span class="eyebrow">CONTINUE</span><h2>${e(active.title || active.preset || active.mode)}</h2><p>Question ${(active.current_position || 0) + 1} of ${active.total_questions}</p><button class="button" data-action="resume" data-id="${e(active.id)}">Resume exact session</button></article>` : `<article class="card action-card"><span class="eyebrow">CONTINUE</span><h2>No unfinished session</h2><p class="subtle">Start a practice set or test when you are ready.</p><a class="button secondary" href="#/qbank">Build practice</a></article>`}<article class="card action-card"><span class="eyebrow">ACTIVE RECALL</span><h2>${dueCount} due</h2><p>Questions and recall cards ready now.</p><a class="button secondary" href="#/review">Open recall</a></article><a class="card action-card link-card" href="#/analytics"><span class="eyebrow">ACCURACY</span><h2>${pct(correct, logs.length)}</h2><p>${logs.length} recent attempts · Open analytics</p></a></section>
  <section class="card section-card"><div class="section-heading"><div><span class="eyebrow">WEAK AREAS</span><h2>Turn weakness into an exact question set</h2></div><a href="#/analytics">See all analytics</a></div>${weak.length ? `<div class="weak-list">${weak.map((item) => `<article class="weak-item"><span>${e(item.name)}</span><b>${item.accuracy}</b><small>${item.questionIds.length} incorrect contributing question${item.questionIds.length === 1 ? '' : 's'}</small>${actionSetButtons({ mode: 'test', preset: 'analytics', title: `${item.name} weak-area revision`, filters: { platforms: [], subjects: [item.id], systems: [], topics: [], subtopics: [], statuses: ['all'], pyq: '', year: '', search: '', source: '' }, questionIds: item.questionIds }, 'Start revision test')}</article>`).join('')}</div>` : '<div class="empty">Answer a few questions and weak areas will appear here.</div>'}</section><div class="secondary-metrics"><span>${logs.length} recent attempts</span><span>${correct} correct</span></div>`);
}

async function qbank() {
  layout(`<div class="page-heading"><span class="eyebrow">QBANK</span><h1>Build a focused practice set</h1><p>Platform → Subject → Topic → Subtopic. Systems remain optional.</p></div><section class="card builder-card"><form id="practice-form" class="stack"><div class="filters">${filterFields({ sourceTests: true })}</div><div class="builder-footer"><div><b data-match-count>Choose filters to count questions</b><div class="subtle">Browse without timers, or preview the same exact set before starting.</div></div><div class="row"><label class="inline-label">Questions <select name="count-mode"><option value="10">10</option><option value="20">20</option><option value="50">50</option><option value="100">100</option><option value="all">All matching</option><option value="custom">Custom</option></select></label><input class="custom-count hidden" name="custom-count" type="number" min="1" max="5000" value="30" aria-label="Custom question count" /><button class="button secondary" name="intent" value="browse">Open questions</button><button class="button" name="intent" value="test">Start practice</button></div></div></form></section>`);
  const form = document.querySelector('#practice-form'); setupDependentFilters(form);
  form.elements['count-mode'].onchange = () => form.querySelector('.custom-count').classList.toggle('hidden', form.elements['count-mode'].value !== 'custom');
  form.onsubmit = async (event) => {
    event.preventDefault(); const filters = readFilters(form); const mode = form.elements['count-mode'].value;
    const requested = mode === 'custom' ? Number(form.elements['custom-count'].value) : mode;
    const definition = { mode: 'practice', preset: 'qbank', title: 'QBank practice', filters, requested, autoSubmit: false, origin: '#/qbank' };
    try { if (event.submitter?.value === 'browse') await openQuestionSet(definition); else await createSession(definition); }
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
  slot.innerHTML = `<section class="card builder-card"><div class="section-heading"><div><span class="eyebrow">${e(item[0])}</span><h2>Configure this test</h2></div><button class="button ghost compact" data-action="close-builder">Close</button></div><form id="test-form" class="stack" data-preset="${e(preset)}"><div class="filters">${filterFields({ revision })}</div><div class="builder-footer"><div><b data-match-count>Counting available questions…</b><div class="subtle">Browse without timers, or preview this exact set before starting.</div></div><div class="row"><label class="inline-label">Questions <select name="count"><option>10</option><option>20</option><option selected>50</option><option>100</option><option value="all">All matching</option></select></label><button class="button secondary" name="intent" value="browse">Open questions</button><button class="button" name="intent" value="test">Preview ${e(item[0])}</button></div></div></form></section>`;
  const form = document.querySelector('#test-form'); if (preset === 'pyq') form.elements.pyq.value = 'yes'; setupDependentFilters(form);
  form.onsubmit = async (event) => {
    event.preventDefault(); const filters = readFilters(form);
    if (['subject', 'topic'].includes(preset) && !filters.subjects.length) return toast('Choose at least one subject.');
    if (preset === 'topic' && !filters.topics.length && !filters.subtopics.length) return toast('Choose at least one topic or subtopic.');
    const definition = { mode: 'test', preset, title: item[0], filters, requested: form.elements.count.value, autoSubmit: true, origin: '#/tests' };
    try { if (event.submitter?.value === 'browse') await openQuestionSet(definition); else await createSession(definition); }
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
  const selected = selectedKeys(answer); const right = selected.length > 0 && isAnswerCorrect(question, answer);
  const expected = correctKeys(question).join(', ') || 'Not provided';
  const resultLabel = !selected.length ? `Correct answer: ${e(expected)}` : right ? 'Previously answered correctly' : `Previously answered incorrectly · Correct answer: ${e(expected)}`;
  const info = [question.source_collection, question.source_test_label, question.source_position ? `Question ${question.source_position}` : '', question.media_status && question.media_status !== 'NO_MEDIA' ? question.media_status.replaceAll('_', ' ') : ''].filter(Boolean).join(' · ');
  return `<div class="answer-panel ${right ? 'correct-panel' : 'wrong-panel'}"><div class="row"><b>${resultLabel}</b><button class="button ghost compact" data-action="toggle-explanation">${open ? 'Hide explanation' : 'View explanation'}</button></div>${open ? `<div class="rich-content">${question.explanation_html ? richHtml(question.explanation_html) : '<p>No explanation is available for this question.</p>'}</div>${info ? `<details class="question-info"><summary>Question info</summary><p>${e(info)}</p></details>` : ''}` : ''}</div>`;
}

function renderQuestion(question, answer, reveal) {
  const correct = new Set(correctKeys(question)); const selected = new Set(selectedKeys(answer)); const multiple = correct.size > 1;
  const mediaNotice = question.media_status && !['NO_MEDIA', 'MEDIA_REFERENCED'].includes(question.media_status) ? `<div class="notice">Referenced media is not available in this import.</div>` : '';
  return `<div class="question-stem rich-content">${richHtml(question.question_text)}</div>${question.image_url ? `<img class="question-image" src="${e(safeUrl(question.image_url, true))}" alt="Question illustration" />` : ''}${mediaNotice}<div class="options" role="group" aria-label="Answer choices">${question.options.map((option) => {
    const key = String(option.option_key).toUpperCase(); const classes = ['option'];
    if (selected.has(key)) classes.push('selected'); if (reveal && correct.has(key)) classes.push('correct'); if (reveal && selected.has(key) && !correct.has(key)) classes.push('wrong');
    return `<button class="${classes.join(' ')}" data-action="answer" data-key="${e(key)}" ${reveal ? 'disabled' : ''}><b>${e(option.option_key)}.</b><span class="rich-content">${richHtml(option.option_text)}</span></button>`;
  }).join('')}</div>${multiple && !reveal && state.active.kind === 'practice' ? `<button class="button" data-action="submit-multi-answer" ${selected.size ? '' : 'disabled'}>Submit selected answers</button>` : ''}${reveal ? explanationBlock(question, answer, state.active.explanationOpen) : ''}`;
}

function feedbackControls(answer, reveal, wrong) {
  if (!reveal) return '';
  const recall = state.active.filters?.statuses?.includes('recall_due');
  return `<div class="learning-feedback"><div><span class="field-label">Confidence</span><div class="segmented">${['sure', 'unsure', 'guess'].map((value) => `<button data-action="confidence" data-value="${value}" class="${answer.confidence === value ? 'active' : ''}">${value.toUpperCase()}</button>`).join('')}</div></div>${wrong ? `<div><span class="field-label">What happened? <small>Optional</small></span><div class="reason-chips">${[['didnt_know', "Didn't know"], ['forgot', 'Forgot'], ['misread', 'Misread'], ['confused_options', 'Confused options'], ['overthought', 'Overthought'], ['silly_mistake', 'Silly mistake'], ['guess', 'Guess']].map(([value, label]) => `<button data-action="error-reason" data-value="${value}" class="${answer.error_reason === value ? 'active' : ''}">${label}</button>`).join('')}</div></div>` : ''}${recall ? `<div><span class="field-label">Active recall response</span><div class="segmented"><button data-action="recall-response" data-value="forgot">FORGOT</button><button data-action="recall-response" data-value="partial">PARTIAL</button><button data-action="recall-response" data-value="knew">KNEW</button></div></div>` : ''}</div>`;
}

function renderActive() {
  const active = state.active; const question = activeQuestion(); if (!active || !question) return;
  const answer = active.answers[question.id]; const reveal = active.completedReview || active.kind === 'practice' && Boolean(answer?.selected_option) && (correctKeys(question).length === 1 || answer.submitted);
  const answered = Object.values(active.answers).filter((item) => item?.selected_option).length;
  const browsing = active.kind === 'browse';
  layout(`<section class="question-header"><div><span class="pill">${browsing ? 'Browse' : active.completedReview ? 'Review' : active.kind === 'test' ? e(TEST_PRESETS[active.preset]?.[0] || 'Test') : 'Practice'}</span><h1>${e(active.title || 'Question set')}</h1></div>${browsing ? `<div class="row"><button class="button" data-action="preview-browsed-set">Start test with these exact questions</button><button class="button secondary" data-action="back-to-origin">Back</button></div>` : `<div class="timer-cluster"><div><span>QUESTION TARGET</span><b id="question-timer">00:50</b></div><div><span>TOTAL TARGET</span><b>${timerText(active.questions.length * TARGET_SECONDS)}</b></div></div>`}</section><div class="question-layout"><section class="card question-card"><div class="question-topline"><span>Question ${active.index + 1} of ${active.questions.length}</span><span>${questionMeta(question)}</span></div><div class="progress"><i style="width:${((active.index + 1) / active.questions.length) * 100}%"></i></div>${renderQuestion(question, answer, reveal)}${browsing ? '' : feedbackControls(answer || {}, reveal, selectedKey(answer) !== correctKey(question))}<div class="question-actions"><div class="row"><button class="button ghost ${active.bookmarks.has(question.id) ? 'active-control' : ''}" data-action="bookmark" aria-pressed="${active.bookmarks.has(question.id)}">${active.bookmarks.has(question.id) ? '★ Bookmarked' : '☆ Bookmark'}</button><button class="button ghost ${active.marked.has(question.id) ? 'active-control' : ''}" data-action="mark" aria-pressed="${active.marked.has(question.id)}">${active.marked.has(question.id) ? '✓ Marked for review' : 'Mark for review'}</button><button class="button ghost" data-action="note">Note</button><button class="button ghost" data-action="report">Report</button></div><div class="row"><button class="button secondary" data-action="previous" ${active.index === 0 ? 'disabled' : ''}>Previous</button><button class="button" data-action="next">${active.index === active.questions.length - 1 ? (browsing ? 'Back' : active.completedReview ? 'Back to results' : 'Finish') : 'Next'}</button></div></div></section><aside class="card palette-card"><div class="section-heading"><h3>Question palette</h3><span>${answered}/${active.questions.length}</span></div><div class="palette">${active.questions.slice(0, 500).map((item, index) => `<button data-action="jump" data-index="${index}" class="${index === active.index ? 'current' : ''} ${active.answers[item.id]?.selected_option ? 'answered' : ''} ${active.marked.has(item.id) ? 'marked' : ''}" aria-label="Question ${index + 1}">${index + 1}</button>`).join('')}</div>${active.questions.length > 500 ? '<p class="subtle">Palette shows the first 500 positions; Previous/Next continues through all questions.</p>' : ''}${active.kind === 'test' && !active.completedReview ? `<p class="subtle">${active.questions.length - answered} unanswered</p><button class="button danger full" data-action="submit">Submit test</button>` : ''}</aside></div>`);
  if (!browsing) startQuestionTimer(); else clearInterval(state.timer);
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
  const args = { p_question_id: question.id, p_selected_option: answer.selected_option, p_is_correct: isAnswerCorrect(question, answer), p_mode: state.active.kind === 'test' ? 'test' : 'qbank', p_test_session_id: state.active.id || null, p_time_spent_seconds: answer.time_spent_seconds || 0, p_confidence: answer.confidence || null, p_error_reason: answer.error_reason || null };
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
  const value = { session_id: state.active.id, question_id: questionId, selected_option: answer.selected_option || null, marked_for_review: state.active.marked.has(questionId), answered_at: answer.selected_option ? answer.answered_at || new Date().toISOString() : null, is_correct: answer.selected_option ? isAnswerCorrect(question, answer) : null, time_spent_seconds: answer.time_spent_seconds || 0, confidence: answer.confidence || null, error_reason: answer.error_reason || null };
  const saved = await optional(db.from('test_answers').upsert(value, { onConflict: 'session_id,question_id' }), 'sessions');
  if (!saved.error) await optional(db.from('test_sessions').update({ current_position: state.active.index, last_question_started_at: new Date(state.active.questionStartedAt).toISOString(), updated_at: new Date().toISOString() }).eq('id', state.active.id).eq('user_id', state.user.id), 'sessions');
}

async function selectAnswer(key) {
  const active = state.active; const question = activeQuestion(); if (!active || active.completedReview) return;
  const existing = active.answers[question.id]; const multiple = correctKeys(question).length > 1;
  if (active.kind === 'practice' && existing?.selected_option && (!multiple || existing.submitted)) return;
  const selection = new Set(selectedKeys(existing));
  if (multiple) { if (selection.has(key)) selection.delete(key); else selection.add(key); }
  const answer = { ...(existing || {}), selected_option: multiple ? [...selection].sort().join(',') : key, answered_at: new Date().toISOString(), time_spent_seconds: Math.max(existing?.time_spent_seconds || 0, elapsedOnQuestion()) };
  active.answers[question.id] = answer;
  if (active.kind === 'practice' && !multiple && !existing?.selected_option) await recordAttempt(question, answer);
  await saveActiveAnswer(question.id); active.explanationOpen = false; renderActive();
}

async function submitMultiAnswer() {
  const question = activeQuestion(); const answer = state.active?.answers?.[question?.id];
  if (!question || !answer?.selected_option || state.active.kind !== 'practice') return;
  answer.submitted = true; await recordAttempt(question, answer); await saveActiveAnswer(question.id); state.active.explanationOpen = false; renderActive();
}

async function navigateActive(index) {
  const active = state.active; const current = activeQuestion();
  if (current && active.kind !== 'browse') { const answer = active.answers[current.id] || {}; answer.time_spent_seconds = Math.max(answer.time_spent_seconds || 0, elapsedOnQuestion()); active.answers[current.id] = answer; await saveActiveAnswer(current.id); }
  active.index = Math.max(0, Math.min(index, active.questions.length - 1)); active.questionStartedAt = active.kind === 'browse' ? null : Date.now(); active.explanationOpen = false;
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
  const totalCorrect = completed?.total_correct ?? active.questions.filter((q) => isAnswerCorrect(q, active.answers[q.id])).length;
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
  const learning = await optional(db.from('user_question_state').select('*').eq('user_id', state.user.id), 'learning');
  const rows = learning.data || [];
  const selected = state.reviewFilters || { platforms: [], subjects: [], systems: [], topics: [], subtopics: [] };
  const validIds = new Set(resolveTaxonomyCascade(state.meta.questionTaxonomy, selected).matchingQuestionIds);
  const categories = [
    ['incorrect', 'Incorrect', rows.filter((x) => x.last_is_correct === false || x.wrong), 'Questions whose current learning state is incorrect.'],
    ['correct', 'Correct', rows.filter((x) => x.last_is_correct === true), 'Questions whose current learning state is correct.'],
    ['bookmarked', 'Bookmarked', rows.filter((x) => x.bookmarked), 'Questions saved for later.'],
    ['marked', 'Marked for Review', rows.filter((x) => x.marked_for_review || x.revision), 'Questions explicitly marked.'],
    ['recall_due', 'Recall Due', rows.filter((x) => x.recall_due_at && x.recall_due_at <= now), 'Question recall items due now.'],
    ['difficult', 'Personally Difficult', rows.filter((x) => x.personally_difficult), 'Questions flagged as difficult.'],
    ['slow', 'Slow >50s', rows.filter((x) => Number(x.last_time_seconds) > TARGET_SECONDS), 'Questions whose latest relevant time exceeded 50 seconds.'],
  ];
  const taxonomyByQuestion = new Map(state.meta.questionTaxonomy.map((item) => [item.id, item]));
  const groupRows = (ids, field, items, status, title) => {
    const groups = new Map(); ids.forEach((id) => { const key = taxonomyByQuestion.get(String(id))?.[field]; if (key) { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(id); } });
    const names = byId(items);
    return [...groups].sort((a, b) => b[1].length - a[1].length).map(([id, questionIds]) => `<li><span><b>${e(names.get(String(id))?.name || 'Unclassified')}</b><small>${questionIds.length} question${questionIds.length === 1 ? '' : 's'}</small></span>${actionSetButtons({ mode: 'test', preset: 'revision', title: `${title} · ${names.get(String(id))?.name || 'Unclassified'}`, filters: { ...selected, statuses: ['all'], pyq: '', year: '', search: '', source: '' }, questionIds }, 'Start revision test')}</li>`).join('');
  };
  const cards = categories.map(([status, title, categoryRows, description]) => {
    const questionIds = [...new Set(categoryRows.map((row) => String(row.question_id)).filter((id) => validIds.has(id)))];
    return `<article class="card review-detail"><div class="section-heading"><div><span class="eyebrow">${e(title)}</span><b class="review-count">${questionIds.length}</b><p>${e(description)}</p></div>${actionSetButtons({ mode: 'test', preset: 'revision', title: `${title} revision`, filters: { ...selected, statuses: ['all'], pyq: '', year: '', search: '', source: '' }, questionIds }, 'Start revision test')}</div>${questionIds.length ? `<details><summary>By subject</summary><ul class="action-list">${groupRows(questionIds, 'subject_id', state.meta.subjects, status, title)}</ul></details><details><summary>By platform</summary><ul class="action-list">${groupRows(questionIds, 'platform_id', state.meta.platforms, status, title)}</ul></details>` : ''}</article>`;
  }).join('');
  layout(`<div class="page-heading"><span class="eyebrow">REVIEW</span><h1>Everything worth revisiting</h1><p>Filter the review population, then browse or test the exact same question IDs.</p></div>${!state.features.learning ? featureNotice('Apply the learning-interface migration for accurate consolidated review counts.') : ''}<section class="card builder-card"><form id="review-filter-form" class="stack"><div class="filters">${multiPicker('platforms', 'Platforms', state.meta.platforms)}${multiPicker('subjects', 'Subjects', state.meta.subjects)}${multiPicker('systems', 'Systems (optional)', state.meta.systems)}${multiPicker('topics', 'Topics', state.meta.topics)}${multiPicker('subtopics', 'Subtopics', state.meta.subtopics)}</div><div class="row"><button class="button">Apply review filters</button><button type="button" class="button ghost" data-action="clear-review-filters">Clear</button></div></form></section><section class="review-stack">${cards}</section><section class="card section-card"><div class="section-heading"><h2>Test history</h2><a class="button secondary" href="#/history">Open history</a></div></section>`);
  const form = document.querySelector('#review-filter-form');
  for (const level of ['platforms', 'subjects', 'systems', 'topics', 'subtopics']) (selected[level] || []).forEach((id) => { const input = form.querySelector(`input[name="${level}"][value="${CSS.escape(String(id))}"]`); if (input) input.checked = true; });
  setupDependentFilters(form);
  form.onsubmit = (event) => { event.preventDefault(); const filters = readFilters(form); state.reviewFilters = filters; review(); };
}

const ANALYTICS_STATUSES = [['all', 'All'], ['attempted', 'Attempted'], ['incorrect', 'Incorrect'], ['correct', 'Correct'], ['bookmarked', 'Bookmarked'], ['marked', 'Marked for Review'], ['recall_due', 'Recall Due']];
const ANALYTICS_EXAM_LABELS = { inicet: 'INI-CET', neet_pg: 'NEET PG' };

function analyticsStatusPicker() {
  return `<fieldset class="field wide status-field"><legend>Question status</legend><div class="chip-checks">${ANALYTICS_STATUSES.map(([value, label]) => `<label><input type="checkbox" name="statuses" value="${value}" ${value === 'all' ? 'checked' : ''} /> <span>${e(label)}</span></label>`).join('')}</div></fieldset>`;
}

function analyticsMetadataFields(capabilities) {
  const examItems = capabilities.exams.map((id) => ({ id, name: ANALYTICS_EXAM_LABELS[id] || id.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) }));
  return `<div class="field"><label>PYQ</label><select name="pyq"><option value="">All questions</option><option value="yes">PYQ only</option><option value="no">Non-PYQ</option></select></div>${examItems.length ? multiPicker('exams', 'Exams', examItems) : ''}${capabilities.years.length ? multiPicker('years', 'Exam years', capabilities.years.map((value) => ({ id: value, name: value }))) : ''}${capabilities.sessions.length ? multiPicker('sessions', 'Exam sessions', capabilities.sessions.map((value) => ({ id: value, name: value }))) : ''}<div class="field analytics-srm-ready"><label>SRM</label><select name="srm" disabled><option value="">Available when SRM state exists</option></select></div>`;
}

async function fetchAnalyticsModel(questionIds) {
  const attempts = []; const learning = [];
  const allowed = new Set(questionIds.map(String));
  if (questionIds.length > 1000) {
    let attemptRows;
    try { attemptRows = await paged(() => db.from('question_attempts').select('question_id,is_correct,answered_at,time_spent_seconds,confidence').eq('user_id', state.user.id).order('answered_at', { ascending: false })); }
    catch { attemptRows = await paged(() => db.from('question_attempts').select('question_id,is_correct,answered_at').eq('user_id', state.user.id).order('answered_at', { ascending: false })); }
    attempts.push(...attemptRows.filter((row) => allowed.has(String(row.question_id))));
    const stateRows = await optional(paged(() => db.from('user_question_state').select('question_id,bookmarked,marked_for_review,revision,recall_due_at,last_time_seconds,last_confidence').eq('user_id', state.user.id)), 'learning');
    learning.push(...(stateRows.data || stateRows || []).filter((row) => allowed.has(String(row.question_id))));
  }
  for (let index = 0; index < questionIds.length && questionIds.length <= 1000; index += 200) {
    const chunk = questionIds.slice(index, index + 200);
    let attemptRows;
    try { attemptRows = await paged(() => db.from('question_attempts').select('question_id,is_correct,answered_at,time_spent_seconds,confidence').eq('user_id', state.user.id).in('question_id', chunk).order('answered_at', { ascending: false })); }
    catch { attemptRows = await paged(() => db.from('question_attempts').select('question_id,is_correct,answered_at').eq('user_id', state.user.id).in('question_id', chunk).order('answered_at', { ascending: false })); }
    attempts.push(...attemptRows);
    const stateRows = await optional(db.from('user_question_state').select('question_id,bookmarked,marked_for_review,revision,recall_due_at,last_time_seconds,last_confidence').eq('user_id', state.user.id).in('question_id', chunk), 'learning');
    learning.push(...(stateRows.data || []));
  }
  attempts.sort((a, b) => new Date(b.answered_at || 0) - new Date(a.answered_at || 0));
  const latest = new Map(); const attemptsByQuestion = new Map();
  attempts.forEach((row) => { const id = String(row.question_id); if (!latest.has(id)) latest.set(id, row); if (!attemptsByQuestion.has(id)) attemptsByQuestion.set(id, []); attemptsByQuestion.get(id).push(row); });
  return { attempts, latest, attemptsByQuestion, learning: new Map(learning.map((row) => [String(row.question_id), row])) };
}

function analyticsMetric(questionIds, model) {
  const ids = [...new Set(questionIds.map(String))]; const attempts = ids.flatMap((id) => model.attemptsByQuestion.get(id) || []);
  const attempted = ids.filter((id) => model.latest.has(id));
  const correct = attempted.filter((id) => model.latest.get(id)?.is_correct === true);
  const incorrect = attempted.filter((id) => model.latest.get(id)?.is_correct === false);
  const bookmarked = ids.filter((id) => model.learning.get(id)?.bookmarked === true);
  const marked = ids.filter((id) => model.learning.get(id)?.marked_for_review === true || model.learning.get(id)?.revision === true);
  const now = Date.now(); const recallDue = ids.filter((id) => { const due = model.learning.get(id)?.recall_due_at; return due && new Date(due).getTime() <= now; });
  const timed = attempts.filter((row) => row.time_spent_seconds != null);
  const slow = ids.filter((id) => Number(model.learning.get(id)?.last_time_seconds) > TARGET_SECONDS);
  const repeatedIncorrect = ids.filter((id) => (model.attemptsByQuestion.get(id) || []).filter((row) => row.is_correct === false).length >= 2);
  const mapping = new Map(state.meta.questionTaxonomy.map((question) => [String(question.id), question]));
  const pyq = ids.filter((id) => mapping.get(id)?.is_pyq === true);
  return { ids, attempted, correct, incorrect, bookmarked, marked, recallDue, attempts: attempts.length, latestAccuracy: pct(correct.length, attempted.length), attemptAccuracy: pct(attempts.filter((row) => row.is_correct).length, attempts.length), averageTime: timed.length ? Math.round(timed.reduce((sum, row) => sum + Number(row.time_spent_seconds || 0), 0) / timed.length) : null, slow, repeatedIncorrect, pyq };
}

function analyticsStatusIds(questionIds, statuses, model) {
  const metric = analyticsMetric(questionIds, model);
  const selected = new Set(statuses || []); if (!selected.size || selected.has('all')) return metric.ids;
  const populations = { attempted: metric.attempted, incorrect: metric.incorrect, correct: metric.correct, bookmarked: metric.bookmarked, marked: metric.marked, recall_due: metric.recallDue };
  return metric.ids.filter((id) => [...selected].some((status) => (populations[status] || []).includes(id)));
}

function analyticsActionButtons(population) {
  const ids = [...new Set(population.questionIds.map(String))];
  if (!ids.length) return '<span class="subtle">No questions match this selection.</span>';
  const token = registerActionSet({ mode: 'test', preset: 'analytics', title: population.title, filters: { ...population.filters, statuses: ['all'] }, questionIds: ids, origin: '#/analytics' });
  return `<button class="button secondary compact" data-action="open-action-set" data-set="${e(token)}">Review Questions</button><button class="button compact" data-action="preview-action-set" data-set="${e(token)}">Start Test</button>`;
}

function analyticsPopulationControls(population) {
  return `<div class="analytics-population-controls"><div class="row">${analyticsActionButtons(population)}</div></div>`;
}

function analyticsGroups(level) {
  const view = state.analyticsView; if (view.groups.has(level)) return view.groups.get(level);
  const definition = {
    platform: ['platform_id', state.meta.platforms, false], subject: ['subject_id', state.meta.subjects, false],
    topic: ['topic_ids', state.meta.topics, true], subtopic: ['subtopic_ids', state.meta.subtopics, true],
  }[level];
  const groups = new Map(); const mapping = new Map(state.meta.questionTaxonomy.map((question) => [question.id, question]));
  if (level === 'exam') {
    view.questionIds.forEach((questionId) => (mapping.get(String(questionId))?.exams || []).forEach((key) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(String(questionId)); }));
    const result = [...groups].map(([id, questionIds]) => ({ id, name: ANALYTICS_EXAM_LABELS[id] || id.replace(/_/g, ' '), questionIds, metric: analyticsMetric(questionIds, view.model) })).sort((a, b) => a.name.localeCompare(b.name));
    view.groups.set(level, result); return result;
  }
  if (level === 'year_session') {
    view.questionIds.forEach((questionId) => { const row = mapping.get(String(questionId)); if (!row?.exam_year && !row?.exam_session) return; const key = `${row.exam_year || 'Unknown year'}${row.exam_session ? ` · ${row.exam_session}` : ''}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(String(questionId)); });
    const result = [...groups].map(([id, questionIds]) => ({ id, name: id, questionIds, metric: analyticsMetric(questionIds, view.model) })).sort((a, b) => b.name.localeCompare(a.name));
    view.groups.set(level, result); return result;
  }
  if (!definition) return [];
  const [field, items, nested] = definition; const names = byId(items);
  view.questionIds.forEach((questionId) => {
    const raw = mapping.get(String(questionId))?.[field]; const keys = nested ? raw || [] : [raw];
    keys.filter(Boolean).forEach((key) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(String(questionId)); });
  });
  const result = [...groups].map(([id, questionIds]) => ({ id, name: names.get(String(id))?.name || 'Unclassified', questionIds, metric: analyticsMetric(questionIds, view.model) })).sort((a, b) => a.name.localeCompare(b.name));
  view.groups.set(level, result); return result;
}

function renderAnalyticsBreakdown(level, page = 1) {
  const holder = document.querySelector('#analytics-breakdown-selected'); if (!holder || !state.analyticsView) return;
  const groups = analyticsGroups(level); const visible = groups.slice(0, page * 50);
  holder.innerHTML = visible.length ? visible.map((group) => {
    const metric = group.metric; const weak = metric.attempted.length >= 2 && metric.correct.length / metric.attempted.length < .6;
    return `<details class="analytics-breakdown-row"><summary><span><b>${e(group.name)}</b>${weak ? '<span class="pill weak-pill">Weak</span>' : ''}</span><span class="breakdown-performance"><b>${metric.latestAccuracy}</b><small>${metric.attempted.length} / ${metric.ids.length} attempted · ${metric.incorrect.length} incorrect · ${metric.averageTime == null ? '—' : `${metric.averageTime}s`} avg</small></span></summary><div class="analytics-row-detail"><div class="compact-stats"><span>Total attempts <b>${metric.attempts}</b></span><span>Bookmarked <b>${metric.bookmarked.length}</b></span><span>Marked <b>${metric.marked.length}</b></span><span>Repeatedly incorrect <b>${metric.repeatedIncorrect.length}</b></span>${metric.pyq.length ? `<span>PYQ <b>${metric.pyq.length}</b></span>` : ''}</div>${analyticsPopulationControls({ title: group.name, questionIds: group.questionIds, filters: state.analyticsView.filters })}</div></details>`;
  }).join('') + (visible.length < groups.length ? `<button class="button secondary" data-action="analytics-more" data-level="${e(level)}" data-page="${page + 1}">Show next ${Math.min(50, groups.length - visible.length)}</button>` : '') : '<div class="empty">No mapped entries in this population.</div>';
}

async function analytics() {
  loading('Calculating selected analytics…');
  const filters = state.analyticsFilters || { platforms: [], subjects: [], systems: [], topics: [], subtopics: [], statuses: ['all'], exams: [], years: [], sessions: [], pyq: '', srm: '' };
  const cascade = resolveTaxonomyCascade(state.meta.questionTaxonomy, filters);
  const capabilities = analyticsMetadataCapabilities(state.meta.questionTaxonomy, cascade.matchingQuestionIds);
  const normalizedFilters = {
    ...filters, ...cascade.selected,
    statuses: filters.statuses?.length ? filters.statuses : ['all'],
    exams: (filters.exams || []).filter((value) => capabilities.exams.includes(String(value))),
    years: (filters.years || []).filter((value) => capabilities.years.includes(String(value))),
    sessions: (filters.sessions || []).filter((value) => capabilities.sessions.includes(String(value))),
    year: '', search: '', source: '',
  };
  const taxonomyIds = new Set(cascade.matchingQuestionIds);
  const metadataIds = filterAnalyticsPopulation(state.meta.questionTaxonomy.filter((question) => taxonomyIds.has(question.id)), normalizedFilters);
  const model = await fetchAnalyticsModel(metadataIds);
  const questionIds = analyticsStatusIds(metadataIds, normalizedFilters.statuses, model);
  const metric = analyticsMetric(questionIds, model);
  const topicSubtopicRedundant = analyticsTopicSubtopicRedundant({ questionIndex: state.meta.questionTaxonomy, topics: state.meta.topics, subtopics: state.meta.subtopics, questionIds });
  state.analyticsView = { questionIds, model, filters: normalizedFilters, groups: new Map(), topicSubtopicRedundant, capabilities };
  const combined = { title: 'Selected analytics population', questionIds, filters: normalizedFilters };
  const candidates = [['platform', 'Platform'], ['subject', 'Subject'], ['topic', topicSubtopicRedundant ? 'Topic / Subtopic' : 'Topic'], ...(!topicSubtopicRedundant ? [['subtopic', 'Subtopic']] : []), ['exam', 'Exam'], ['year_session', 'Year / session']];
  const breakdowns = candidates.filter(([level]) => analyticsGroups(level).length > 1);
  if (!breakdowns.some(([level]) => level === state.analyticsBreakdown)) state.analyticsBreakdown = null;
  layout(`<div class="page-heading"><span class="eyebrow">ANALYTICS</span><h1>Overall performance</h1><p>First select the question population. Analytics then summarizes exactly that selection.</p></div><section class="card builder-card"><form id="analytics-filter-form" class="stack"><div class="filters analytics-query-filters">${multiPicker('platforms', 'Platforms', state.meta.platforms)}${multiPicker('subjects', 'Subjects', state.meta.subjects)}${multiPicker('systems', 'Systems (optional)', state.meta.systems)}${multiPicker('topics', 'Topics', state.meta.topics)}${multiPicker('subtopics', 'Subtopics', state.meta.subtopics)}${analyticsStatusPicker()}${analyticsMetadataFields(capabilities)}</div><div class="builder-footer"><div><b>${metric.ids.length.toLocaleString()} questions selected</b><div class="subtle">No fallback questions are substituted when a combination has zero matches.</div></div><div class="row"><button class="button">Apply analytics filters</button><button type="button" class="button ghost" data-action="clear-analytics-filters">Clear</button></div></div></form></section><section class="card analytics-summary"><div class="section-heading"><div><span class="eyebrow">SELECTED POPULATION</span><h2>${metric.ids.length} questions available</h2><p class="subtle">Primary accuracy uses the newest answer for each attempted question.</p></div>${analyticsPopulationControls(combined)}</div><div class="analytics-primary-metrics"><div><span>Mastery accuracy</span><b>${metric.latestAccuracy}</b><small>latest answers</small></div><div><span>Questions attempted</span><b>${metric.attempted.length} / ${metric.ids.length}</b><small>unique questions</small></div><div><span>Currently incorrect</span><b>${metric.incorrect.length}</b><small>latest answer</small></div><div><span>Average time</span><b>${metric.averageTime == null ? '—' : `${metric.averageTime}s`}</b><small>across attempts</small></div></div><div class="analytics-secondary"><span>Bookmarked <b>${metric.bookmarked.length}</b></span><span>Marked for Review <b>${metric.marked.length}</b></span><span>Recall Due <b>${metric.recallDue.length}</b></span>${metric.pyq.length ? `<span>PYQ <b>${metric.pyq.length}</b></span>` : ''}</div><details class="analytics-more-details"><summary>More details</summary><div class="compact-stats"><span>Total attempts <b>${metric.attempts}</b></span><span>Unique correct <b>${metric.correct.length}</b></span><span>Attempt accuracy <b>${metric.attemptAccuracy}</b></span><span>Slow &gt;50s <b>${metric.slow.length}</b></span><span>Repeatedly incorrect <b>${metric.repeatedIncorrect.length}</b></span></div><p class="analytics-rule">Weak area = at least 2 unique attempted questions and latest-answer accuracy below 60%. Repeatedly incorrect = at least 2 incorrect attempts on the same question.</p></details></section><section class="card detailed-analytics"><div class="section-heading"><div><span class="eyebrow">BREAK DOWN THIS SELECTION BY</span><h2>Optional detailed analysis</h2></div>${topicSubtopicRedundant && analyticsGroups('topic').length > 1 ? '<span class="subtle">Topic and Subtopic are equivalent in this selection, so one combined view is shown.</span>' : ''}</div>${breakdowns.length ? `<div class="breakdown-selector">${breakdowns.map(([level, label]) => `<button class="button ${state.analyticsBreakdown === level ? '' : 'secondary'}" data-action="select-analytics-breakdown" data-level="${level}">By ${e(label)}</button>`).join('')}</div><div id="analytics-breakdown-selected" class="analytics-breakdown-content">${state.analyticsBreakdown ? '' : '<div class="empty">Choose one useful breakdown. No rows are rendered by default.</div>'}</div>` : '<div id="analytics-breakdown-selected" class="empty">This selection has no useful multi-group breakdown.</div>'}</section>`);
  const form = document.querySelector('#analytics-filter-form');
  form.querySelectorAll('input[name="statuses"]').forEach((input) => { input.checked = false; });
  for (const level of ['platforms', 'subjects', 'systems', 'topics', 'subtopics', 'statuses', 'exams', 'years', 'sessions']) (normalizedFilters[level] || []).forEach((id) => { const input = form.querySelector(`input[name="${level}"][value="${CSS.escape(String(id))}"]`); if (input) input.checked = true; });
  form.elements.pyq.value = normalizedFilters.pyq || '';
  setupDependentFilters(form);
  form.onsubmit = (event) => { event.preventDefault(); state.analyticsFilters = readFilters(form); analytics(); };
  if (state.analyticsBreakdown) renderAnalyticsBreakdown(state.analyticsBreakdown, 1);
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
  if (action === 'answer') await selectAnswer(target.dataset.key); if (action === 'submit-multi-answer') await submitMultiAnswer(); if (action === 'previous') await navigateActive(state.active.index - 1);
  if (action === 'next') { if (state.active.index === state.active.questions.length - 1) { if (state.active.kind === 'browse') { goToHash(state.active.origin || '#/qbank'); return; } if (state.active.completedReview) return resultScreen(); return submitActive(false); } await navigateActive(state.active.index + 1); }
  if (action === 'jump') await navigateActive(Number(target.dataset.index)); if (action === 'bookmark') await toggleBookmark(); if (action === 'mark') await toggleMark();
  if (action === 'toggle-explanation') { state.active.explanationOpen = !state.active.explanationOpen; renderActive(); }
  if (action === 'confidence') await updateAnswerMetadata('confidence', target.dataset.value); if (action === 'error-reason') await updateAnswerMetadata('error_reason', target.dataset.value);
  if (action === 'recall-response') await recordRecallResponse(target.dataset.value);
  if (action === 'note') await noteModal(); if (action === 'report') reportModal(); if (action === 'close-modal') document.querySelector('#modal')?.remove(); if (action === 'submit') await submitActive(false); if (action === 'resume') await resumeSession(target.dataset.id);
  if (action === 'start-pending-test') await startPendingSession();
  if (action === 'cancel-question-set') { const origin = state.pendingSet?.origin || '#/qbank'; state.pendingSet = null; goToHash(origin); }
  if (action === 'back-to-origin') goToHash(state.active?.origin || '#/qbank');
  if (action === 'preview-browsed-set') await createSession({ mode: state.active.testMode || 'test', preset: state.active.preset, title: state.active.title, filters: state.active.filters, questionIds: state.active.questionIds, requested: state.active.questionIds.length, autoSubmit: state.active.testMode !== 'practice', origin: state.active.origin });
  if (action === 'open-action-set' || action === 'preview-action-set') {
    const definition = state.actionSets.get(target.dataset.set); if (!definition) return toast('That question set expired. Please reopen this page.', 'error');
    if (action === 'open-action-set') await openQuestionSet(definition); else await createSession(definition);
  }
  if (action === 'clear-review-filters') { state.reviewFilters = null; await review(); }
  if (action === 'clear-analytics-filters') { state.analyticsFilters = null; state.analyticsBreakdown = null; await analytics(); }
  if (action === 'select-analytics-breakdown') { state.analyticsBreakdown = target.dataset.level; document.querySelectorAll('[data-action="select-analytics-breakdown"]').forEach((button) => { button.classList.toggle('secondary', button !== target); }); renderAnalyticsBreakdown(state.analyticsBreakdown, 1); }
  if (action === 'analytics-more') renderAnalyticsBreakdown(target.dataset.level, Number(target.dataset.page) || 1);
  if (action === 'review-result') { state.active.index = 0; state.active.completedReview = true; state.active.questionStartedAt = Date.now(); renderActive(); }
  if (action === 'review-mistakes') { const questions = state.active.questions.filter((q) => state.active.answers[q.id]?.selected_option && !isAnswerCorrect(q, state.active.answers[q.id])); if (!questions.length) return toast('No incorrect questions in this session.'); state.active = { ...state.active, questions, index: 0, completedReview: true, questionStartedAt: Date.now() }; renderActive(); }
  if (action === 'retake') await createSession({ mode: state.active.kind, preset: state.active.preset || 'retake', title: `${state.active.title || 'Test'} retake`, filters: state.active.filters || {}, questionIds: state.active.questions.map((question) => question.id), requested: state.active.questions.length, autoSubmit: state.active.kind === 'test', origin: '#/history' });
  if (action === 'my-bank-tab') showMyBankTab(target.dataset.tab);
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
