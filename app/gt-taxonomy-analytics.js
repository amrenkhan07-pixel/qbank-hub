// Completed-attempt analytics only; never loaded by the active exam module.
const requireValue = (ok, message) => { if (!ok) throw Error(message); };
const blank = () => ({ correct: 0, incorrect: 0, unattempted: 0, unscored: 0, total: 0, timed_questions: 0, total_time_ms: 0, accuracy: null, average_time_ms: null });
function add(m, status, time) {
  m[status]++; m.total++;
  if (Number.isFinite(time) && time >= 0) { m.timed_questions++; m.total_time_ms += time; }
  m.accuracy = m.correct + m.incorrect ? 100 * m.correct / (m.correct + m.incorrect) : null;
  m.average_time_ms = m.timed_questions ? m.total_time_ms / m.timed_questions : null;
}
export function aggregateTaxonomy(bundle, attempt) {
  requireValue(attempt.status === 'completed', 'Taxonomy is available only after the attempt is completed.');
  requireValue(bundle?.version === 1 && Array.isArray(bundle.tests) && Array.isArray(bundle.concepts) && Array.isArray(bundle.families), 'Invalid taxonomy snapshot');
  const concepts = new Map(bundle.concepts.map(c => [c.concept_id, c]));
  const families = new Map(bundle.families.map(f => [f.concept_family_id, f]));
  requireValue(concepts.size === bundle.concepts.length && families.size === bundle.families.length, 'Duplicate taxonomy IDs');
  const matches = bundle.tests.filter(t => t.source_test_uuid === attempt.source_test_id && t.payload_sha256 === attempt.payload_sha256);
  requireValue(matches.length === 1, 'No taxonomy matches this exact GT payload version.');
  const test = matches[0];
  requireValue(test.questions.length === attempt.question_count, 'Taxonomy question count mismatch');
  const recurrence = new Map(), testIds = new Set(), occurrenceIds = new Set();
  for (const t of bundle.tests) {
    requireValue(!testIds.has(t.source_test_uuid), 'Duplicate GT binding'); testIds.add(t.source_test_uuid);
    const positions = new Set();
    for (const q of t.questions) {
      const c = concepts.get(q.concept_id), f = families.get(c?.concept_family_id);
      requireValue(c && f && c.subject === q.subject && f.subject === q.subject, 'Broken taxonomy link');
      requireValue(Number.isInteger(q.position) && q.position > 0 && q.position <= t.questions.length && !positions.has(q.position) && !occurrenceIds.has(q.question_id), 'Duplicate or invalid occurrence');
      positions.add(q.position); occurrenceIds.add(q.question_id);
      for (const key of ['c:' + c.concept_id, 'f:' + f.concept_family_id]) {
        if (!recurrence.has(key)) recurrence.set(key, { questions: 0, tests: new Set(), concepts: new Set() });
        const r = recurrence.get(key); r.questions++; r.tests.add(t.source_test_uuid); r.concepts.add(c.concept_id);
      }
    }
  }
  const count = key => { const r = recurrence.get(key); return { questions: r.questions, tests: r.tests.size, primary_concepts: r.concepts.size }; };
  const root = { test_id: test.source_test_uuid, title: test.title, metrics: blank(), sections: [], subjects: [] };
  for (const q of test.questions) {
    const outcome = attempt.result?.outcomes?.[String(q.position)];
    requireValue(['correct', 'incorrect', 'unanswered'].includes(outcome), 'Completed per-question outcomes missing');
    const response = attempt.responses?.[String(q.position)];
    const status = outcome === 'unanswered' ? (response?.selected?.length ? 'unscored' : 'unattempted') : outcome;
    // Only explicit per-question durations can contribute; saved_at is not time spent.
    const time = typeof response?.time_spent_ms === 'number' ? response.time_spent_ms : null;
    const c = concepts.get(q.concept_id), f = families.get(c.concept_family_id);
    let subject = root.subjects.find(s => s.subject === q.subject);
    if (!subject) { subject = { subject: q.subject, metrics: blank(), systems: [], families: [] }; root.subjects.push(subject); }
    let system = subject.systems.find(s => s.system === (f.system || 'Unspecified'));
    if (!system) { system = { system: f.system || 'Unspecified', metrics: blank(), families: [] }; subject.systems.push(system); }
    let family = system.families.find(x => x.concept_family_id === f.concept_family_id);
    if (!family) { family = { ...f, metrics: blank(), concepts: [], recurrence: count('f:' + f.concept_family_id) }; system.families.push(family); subject.families.push(family); }
    let concept = family.concepts.find(x => x.concept_id === c.concept_id);
    if (!concept) { concept = { concept_id: c.concept_id, name: c.canonical_concept_name, family_confidence: c.family_confidence, family_needs_review: c.family_needs_review, metrics: blank(), questions: [], recurrence: count('c:' + c.concept_id) }; family.concepts.push(concept); }
    concept.questions.push({ question_id: q.question_id, position: q.position, status, route: q.route, time_ms: time });
    for (const m of [root.metrics, subject.metrics, system.metrics, family.metrics, concept.metrics]) add(m, status, time);
    if (Number.isInteger(attempt.section_size) && attempt.section_size > 0) {
      const section = Math.floor((q.position - 1) / attempt.section_size) + 1;
      let group = root.sections.find(s => s.section === section);
      if (!group) { group = { section, metrics: blank() }; root.sections.push(group); }
      add(group.metrics, status, time);
    }
  }
  return root;
}
export async function loadCompletedTaxonomy(db, historyAttempt, fetcher = fetch) {
  requireValue(historyAttempt.status === 'completed' && historyAttempt.result, 'Complete the attempt before viewing taxonomy.');
  const response = await fetcher(new URL('../gt-taxonomy/live-taxonomy.json', import.meta.url), { cache: 'no-cache' });
  requireValue(response.ok, 'Family analytics is awaiting a published taxonomy snapshot.');
  const bundle = await response.json();
  const { data, error } = await db.rpc('qbank_gt_state', { p_attempt: historyAttempt.id });
  if (error) throw error;
  requireValue(data?.id === historyAttempt.id && data.status === 'completed', 'Completed attempt identity mismatch');
  return aggregateTaxonomy(bundle, data);
}
export function renderTaxonomy(tree, escape) {
  const e = escape;
  const metrics = x => `${x.total} questions · ${x.correct} correct · ${x.incorrect} incorrect · ${x.unattempted} unattempted${x.unscored ? ' · ' + x.unscored + ' answered but unscored' : ''} · accuracy ${x.accuracy === null ? '—' : x.accuracy.toFixed(1) + '%'}`;
  const repeat = x => `${x.questions} GT-question occurrences · ${x.primary_concepts} distinct primary concepts · ${x.tests} GTs`;
  const concept = c => `<details><summary>${e(c.name)}${c.family_needs_review ? ' · Family assignment needs review' : ''} — ${e(metrics(c.metrics))} · ${e(repeat(c.recurrence))}</summary><ul>${c.questions.map(q => `<li>Question ${q.position}: ${e(q.status)} · ${e(q.route)}</li>`).join('')}</ul></details>`;
  const family = f => `<details><summary>${e(f.canonical_family_name)} — ${e(metrics(f.metrics))} · ${e(repeat(f.recurrence))}</summary>${f.concepts.map(concept).join('')}</details>`;
  return `<p>Draft taxonomy · completed attempt only. Occurrences count questions across all seven GTs, including different primary concepts in the same family. Accuracy excludes unanswered and exam-rule unscored responses.</p><h3>${e(tree.title)}</h3><p>${e(metrics(tree.metrics))}</p><p>Per-question average time: ${tree.metrics.average_time_ms === null ? 'unavailable' : e((tree.metrics.average_time_ms / 1000).toFixed(1) + 's')}</p>${tree.sections.length ? `<details><summary>Section performance</summary>${tree.sections.map(s => `<p>Section ${s.section}: ${e(metrics(s.metrics))}</p>`).join('')}</details>` : ''}${tree.subjects.map(s => `<details><summary>${e(s.subject)} — ${e(metrics(s.metrics))}</summary>${s.systems.map(y => `<details><summary>${e(y.system)} — ${e(metrics(y.metrics))}</summary>${y.families.map(family).join('')}</details>`).join('')}</details>`).join('')}`;
}
