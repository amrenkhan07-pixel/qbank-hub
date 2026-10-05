# Active Recall V2 and study navigation

Smart Recall selection, Active/Early exposure preferences, Global Importance scoring, GT behavior, media, question IDs, source order and taxonomy are unchanged.

## Audit and the reported 137 due

The old Home card added due `user_question_state` SRM rows to due `recall_card_progress` rows. It counted questions plus personal cards, not concepts. The historical display of 137 cannot be reconstructed exactly without its timestamp/snapshot. At the audit, there were 143 due questions and one personal card. The 242 learner-state rows had 242 unique user/question pairs: no duplicate scheduling rows. Fourteen of those due questions mapped to twelve reliable concepts; 129 remained question-level. The new card therefore showed **12 concepts + 129 question-level items**, plus one separately identified personal card. Counts naturally change with time and attempts.

Old scheduling used `qbank_record_attempt_v2`, `qbank_apply_srm_event`, question-level SRM state and event history. None of those functions or historical rows were replaced. V2 wraps the canonical attempt function transactionally and stores its own knowledge-unit schedule and retrieval strength.

## Reliable knowledge units

Only an unambiguous finalized mapping from `pyq_concept_importance` is eligible. Subject is part of the concept key. Conflicting mappings fall back to the canonical question ID. The other canonical assignment table contained 586 draft model assignments, so it is deliberately excluded. No embeddings, text similarity or inferred relationships are used.

One unit is selected once initially. Later reviews prefer a different already-encountered question in that same reliable unit; an unmapped question never substitutes for another. Concept retrieval uses the original question prompt with answer choices initially hidden. No generated medical summaries are used. The concept label appears after submission only. Details expose actual stored statistics, encountered questions/platforms and recent mistake history.

## Exact scheduling rules

Ladder: **15 minutes → 1 day → 3 days → 7 days → 14 days → 30 days → 60 days**.

- Wrong answers always lapse, even if the learner subsequently selects KNEW IT. They return to 15 minutes and reset the spaced-success streak.
- Correct and strong advances one step when the preceding review was at least 20 hours ago. At the initial 15-minute step, strong success graduates to one day even during same-session relearning, without earning spaced-success credit.
- Correct partial/unsure moves back one step, capped at a maximum of three days; it earns no spaced-success credit.
- Immediate strong repeats at longer intervals do not advance or earn mastery credit.
- Two consecutive failures produce WEAK. Otherwise the default is LEARNING. Three qualifying spaced successes and at least seven days produce STABLE. Five and at least thirty days produce MASTERED. Mastered units remain scheduled, up to sixty days.
- One same-session retry per failed unit is inserted after three intervening retrievals when three remain. Late failures/very short sessions stay due at fifteen minutes instead of forcing immediate repetition.
- No Global Importance spacing multiplier is applied; retrieval evidence controls spacing.

Sessions offer 20, 30 or All Due. All Due reads bounded queue pages. Unselected units remain due. Canonical attempt event IDs prevent duplicate recording. Retry order and cursor are persisted with the session; resume restores recorded strength from V2 events. Individual attempts remain in universal history even when a session's current answer is replaced for a retry.

## Legacy preservation

There is no reset or bulk rewrite. Before a V2 retrieval, original due times and intervals are read directly. Existing question histories, bookmarks, review marks, confidence and mistake reasons remain intact. Legacy mastery is conservatively Learning/Weak until qualifying V2 retrieval evidence exists; this does not reset its interval. A later ordinary incorrect/unsure attempt can bring a unit back into Active Recall. An ordinary confident attempt cannot resurrect stale schedules of other members. Bookmark and Mark for Review do not enroll items by themselves.

V2 concept removal suppresses that Active Recall unit while retaining old per-question schedules/history. Smart Recall's existing selection remains independent. Personal recall cards are reported separately and their existing data is preserved; they are not silently converted into MCQs.

## Home, history and Analytics

Home starts Active Recall directly and retains Smart Recall, Continue Studying, Accuracy and Weak Areas. Redundant Recall/Recall Today/Review top-level links are hidden. Underlying routes remain available; question-level filters/daily limits remain under Advanced settings, and saved review lists remain under Analytics advanced analysis.

Test Mode retrieves at most four sessions with prominent subjects, platform, source-module names when available, score/count and date. Unfinished sessions show position rather than a misleading zero score. Separate history loads twenty at a time.

Analytics renders its shell before taxonomy metadata. Overview, Subjects, Weaknesses and Performance/History each request only their own dataset. Responses are cached by user and tab for sixty seconds and invalidated on learner changes. Slow responses cannot replace a newer page/account. Existing detailed PYQ/population exploration remains behind explicit advanced navigation, so capability is retained; those legacy advanced paths can still be more expensive.

## Database and files

New owner-RLS tables: `active_recall_units`, `active_recall_retrievals`. Read-only invoker view: `active_recall_reliable_map`.

New invoker RPCs: `qbank_active_recall_rows`, `qbank_active_recall_queue`, `qbank_active_recall_record`, `qbank_active_recall_manual`, `qbank_active_recall_detail`, `qbank_session_history`, `qbank_analytics_tab`.

Existing user/question and scheduling indexes are reused. New tables have their unique primary keys; the only additional index is `(user_id, occurred_at desc)` on V2 retrieval history. No existing source/taxonomy index or dataset was rebuilt.

Four applied migrations: `20261005110135`, `20261005111356`, `20261005113323`, `20261005114119`. Frontend: `app/app.js`, new `active-recall.js` and `active-recall-model.mjs`, scoped styles and entry-point version. Tests: `scripts/active-recall-test.mjs` and `scripts/active-recall-transaction-tests.sql`.

## Performance measurements

Authenticated database EXPLAIN ANALYZE, same project:

| Query | Time |
|---|---:|
| Previous Analytics overview snapshot | 4,495.290 ms |
| New smaller Analytics overview | 13.466 ms |
| New Active Recall Home summary | 48.328 ms |

The old snapshot scanned the usable corpus, joined source occurrences and aggregated attempts, including temporary I/O. Deeper tabs additionally loaded full population IDs and attempt histories into the browser. The new landing overview uses existing consolidated learner state. Its totals reconciled exactly: **521 attempts / 310 correct** in both canonical history and consolidated state.

Production-like isolated browser with a controlled 250 ms RPC delay: Overview usable in **251–254 ms**, cached revisit **0 ms** in these runs. These are fixture/browser measurements, not production network guarantees. No comparable end-to-end production-before measurement was captured; the before/after comparison above is database execution time.

## Validation

- 22 transactional database assertions passed under the authenticated role. Synthetic data rolled back: enrollment idempotency, fallback, failures, partial, maintenance, downgrade, retry idempotency, immediate graduation, optional annotation, bookmark/review independence, reliable grouping/variant rotation, preserved history, removal/re-entry and account isolation.
- Browser: direct Home start, 30 and All Due (35 fixture units), concept secrecy, retrieval-first choices, wrong-answer feedback, three intervening questions before retry, empty retry answer, reload restoring repeat cursor and recorded strength, lazy/cached tab requests, concept details, contextual four-session list, 20/15 history pagination, mobile overflow check.
- Existing Smart Recall/continuation browser suite passed, including exact question 23/40 resume, Active/Early persistence, rotation, pins, temporary focus and no concept leaks.
- Focused model suites passed: Active Recall, both Smart Recall suites, study-flow, session timers, GT rules and Global Importance.
- Source fingerprints match baseline: 61,047 questions, 65,998 source occurrences, 5,490 importance entries / **5,937 PYQ occurrences**. The unresolved image question is absent from reliable mappings.
- No real V2 learner records were created by testing; no user was signed out.
- Security advisors reported no findings on the new objects. Unrelated pre-existing findings were left unchanged.

Final resume and scoped-mobile visual verification are recorded in the accompanying local validation artifacts. Publication status is reported separately; database migrations being live does not imply the frontend is deployed.
