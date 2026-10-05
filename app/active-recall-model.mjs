/** Deterministic Active Recall only. Smart Recall selection is independent. */
export const RECALL_LADDER = Object.freeze([15, 1440, 4320, 10080, 20160, 43200, 86400]);
export function nextRetrieval(previous = {}, { correct, strength, now = Date.now() }) {
  if (!['failed', 'partial', 'strong'].includes(strength)) throw new Error('Invalid retrieval strength');
  const interval = Math.max(0, Number(previous.interval_minutes || 0));
  let step = RECALL_LADDER.reduce((n, value, i) => value <= interval ? i : n, 0);
  const spaced = !previous.last_reviewed_at || now - new Date(previous.last_reviewed_at).getTime() >= 20 * 3600000;
  // Seeing the explanation is not a successful retrieval. Wrong + "knew it" remains a lapse.
  const strong = correct === true && strength === 'strong';
  const failed = correct !== true || strength === 'failed';
  const failures = failed ? Number(previous.consecutive_failures || 0) + 1 : 0;
  const successes = failed ? 0 : Number(previous.spaced_successes || 0) + (strong && spaced ? 1 : 0);
  if (failed) step = 0;
  else if (strong && (spaced || step === 0)) step = Math.min(6, step + 1);
  else if (!strong) step = Math.max(0, Math.min(step - 1, 2));
  const mastery = failures >= 2 ? 'WEAK' : successes >= 5 && step >= 5 ? 'MASTERED' : successes >= 3 && step >= 3 ? 'STABLE' : 'LEARNING';
  return { interval_minutes: RECALL_LADDER[step], mastery, consecutive_failures: failures, spaced_successes: successes,
    last_reviewed_at: new Date(now).toISOString(), due_at: new Date(now + RECALL_LADDER[step] * 60000).toISOString(), relearn: failed };
}
/** One unit per selection; never infer relationships from labels or text similarity. */
export function selectRecallUnits(rows, limit = 20) {
  const seen = new Set();
  return rows.filter(row => row.unit_key && !seen.has(row.unit_key) && seen.add(row.unit_key)).slice(0, limit === 'all' ? rows.length : Number(limit));
}
export function selectVariant(questionIds, lastQuestionId) {
  return questionIds.find(id => id !== lastQuestionId) || questionIds[0] || null;
}
/** Repeat after three other retrievals, once per unit per session. */
export function enqueueRelearning(queue, index, item, repeats = new Set()) {
  if (repeats.has(item.unit_key)) return queue;
  repeats.add(item.unit_key);
  const result = queue.slice();
  result.splice(Math.min(index + 4, result.length), 0, { ...item, relearning: true });
  return result;
}
