import { resolveTaxonomyCascade } from './validation.js?v=20260902-pilot-analytics';

const levels = ['platforms', 'subjects', 'systems', 'topics', 'subtopics'];
const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const sorted = (values) => [...values].map(String).sort();
const same = (left, right) => sorted(left).join('|') === sorted(right).join('|');
const pause = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function rows(form, level) {
  return [...form.querySelectorAll(`[data-multi-field="${level}"] .check-row`)].map((row) => ({
    row,
    input: row.querySelector('input'),
    label: row.dataset.taxonomyLabel || row.textContent.trim(),
  }));
}

function isRendered(row) {
  const style = getComputedStyle(row);
  const bounds = row.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden'
    && style.pointerEvents !== 'none' && bounds.width > 0 && bounds.height > 0;
}

function visible(form, level) {
  return rows(form, level).filter(({ row }) => isRendered(row));
}

function selected(form) {
  return Object.fromEntries(levels.map((level) => [level,
    rows(form, level).filter(({ input }) => input?.checked).map(({ input }) => input.value),
  ]));
}

async function choose(form, choices) {
  let changed;
  for (const level of levels) {
    const wanted = new Set((choices[level] || []).map(normalize));
    for (const item of rows(form, level)) {
      const checked = wanted.has(normalize(item.label));
      if (item.input.checked !== checked) {
        item.input.checked = checked;
        changed = item.input;
      }
    }
  }
  if (changed) changed.dispatchEvent(new Event('change', { bubbles: true }));
  await pause(375);
}

async function matchCount(form) {
  const node = form.querySelector('[data-match-count]');
  for (let attempt = 0; attempt < 20 && /counting/i.test(node?.textContent || ''); attempt += 1) await pause(250);
  return node?.textContent || '';
}

function expected(questionIndex, selection) {
  return resolveTaxonomyCascade(questionIndex, selection).valid;
}

function renderedIds(form, level) {
  return visible(form, level).map(({ input }) => input.value);
}

function labels(form, level) {
  return visible(form, level).map((item) => item.label);
}

function excludes(actual, forbidden) {
  const normalized = new Set(actual.map(normalize));
  return forbidden.every((label) => !normalized.has(normalize(label)));
}

export async function runTaxonomyDomRegression({ form, questionIndex }) {
  form.querySelectorAll('[data-multi-field] details').forEach((details) => { details.open = true; });
  const anatomyOnly = ['Brain', 'Embryology', 'General Anatomy', 'Head, Neck and Face', 'Histology', 'Lower Limb', 'Thorax', 'Upper Limb'];
  const anesthesiaOnly = ['Pre Anesthesia Evaluation', 'Pre-Anesthesia Evaluation', 'Regional Anesthesia', 'Local Anesthetics', 'Pediatric and Obstetric Anesthesia'];
  const cases = {};

  await choose(form, { platforms: ['Cerebellum'], subjects: ['Anaesthesia'] });
  let active = selected(form);
  let valid = expected(questionIndex, active);
  const anesthesiaTopics = renderedIds(form, 'topics');
  const anesthesiaSubtopics = renderedIds(form, 'subtopics');
  cases.anesthesiaIsolation = same(anesthesiaTopics, valid.topics)
    && same(anesthesiaSubtopics, valid.subtopics)
    && excludes([...labels(form, 'topics'), ...labels(form, 'subtopics')], anatomyOnly);

  await choose(form, { platforms: ['Cerebellum'], subjects: ['Anatomy'] });
  active = selected(form);
  valid = expected(questionIndex, active);
  const anatomyTopics = renderedIds(form, 'topics');
  const anatomySubtopics = renderedIds(form, 'subtopics');
  const anatomyCount = await matchCount(form);
  cases.anatomyIsolation = same(anatomyTopics, valid.topics)
    && same(anatomySubtopics, valid.subtopics)
    && excludes([...labels(form, 'topics'), ...labels(form, 'subtopics')], anesthesiaOnly);

  await choose(form, { platforms: ['Cerebellum'], subjects: ['Anatomy', 'Anaesthesia'] });
  active = selected(form);
  valid = expected(questionIndex, active);
  const mixedTopics = renderedIds(form, 'topics');
  const mixedSubtopics = renderedIds(form, 'subtopics');
  cases.mixedUnion = same(mixedTopics, valid.topics)
    && same(mixedSubtopics, valid.subtopics)
    && same(mixedTopics, new Set([...anatomyTopics, ...anesthesiaTopics]))
    && same(mixedSubtopics, new Set([...anatomySubtopics, ...anesthesiaSubtopics]));

  await choose(form, { platforms: ['Cerebellum'], subjects: ['Anaesthesia'], subtopics: ['Local Anesthetics'] });
  await choose(form, { platforms: ['Cerebellum'], subjects: ['Anatomy'], subtopics: ['Local Anesthetics'] });
  active = selected(form);
  const localRows = [...rows(form, 'topics'), ...rows(form, 'subtopics')].filter((item) => normalize(item.label) === normalize('Local Anesthetics'));
  cases.invalidChildPruning = localRows.length > 0
    && localRows.every(({ row, input }) => !input.checked && !isRendered(row))
    && !active.topics.includes(localRows[0]?.input.value)
    && !active.subtopics.includes(localRows[0]?.input.value)
    && await matchCount(form) === anatomyCount;

  active = selected(form);
  valid = expected(questionIndex, active);
  cases.zeroCountLabelsHidden = levels.every((level) => same(renderedIds(form, level), valid[level]));

  await choose(form, { platforms: ['PrepLadder'], subjects: ['Anaesthesia'] });
  const prepSourceRows = visible(form, 'source_tests');
  cases.prepladderCanonicalSubject = selected(form).subjects.length === 1;
  cases.sourceTestsSeparateFromTaxonomy = prepSourceRows.length === 30
    && visible(form, 'topics').length === 0 && visible(form, 'subtopics').length === 0;
  form.elements.pyq.value = 'yes'; form.elements.pyq.dispatchEvent(new Event('change', { bubbles: true })); await pause(400);
  cases.prepladderPyq = await matchCount(form) === '147 questions match';
  form.elements.pyq.value = 'no'; form.elements.pyq.dispatchEvent(new Event('change', { bubbles: true })); await pause(400);
  cases.prepladderNonPyq = await matchCount(form) === '236 questions match';
  form.elements.pyq.value = ''; form.elements.pyq.dispatchEvent(new Event('change', { bubbles: true }));
  const firstSource = prepSourceRows[0]; firstSource.input.checked = true;
  firstSource.input.dispatchEvent(new Event('change', { bubbles: true })); await pause(375);
  await choose(form, { platforms: ['Cerebellum'], subjects: ['Anaesthesia'] });
  cases.sourceTestParentPruning = !firstSource.input.checked && !isRendered(firstSource.row);

  await choose(form, {});
  const status = Object.values(cases).every(Boolean) ? 'PASS' : 'FAIL';
  return {
    status,
    cases,
    evidence: {
      anesthesia: { topics: anesthesiaTopics.length, subtopics: anesthesiaSubtopics.length },
      anatomy: { topics: anatomyTopics.length, subtopics: anatomySubtopics.length },
      mixed: { topics: mixedTopics.length, subtopics: mixedSubtopics.length },
    },
  };
}
