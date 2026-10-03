# Recall Today mix

The homepage shows an actual deduplicated preview alongside its saved focus. Default: 30 questions, targeting 12 Global Importance, 9 mistakes, 5 saved/review, 4 due/past. Largest-remainder rounding gives the stated 5/4 split. The preset uses 60% active and 40% early-exposure GI questions (7/5 at size 30). All four bucket percentages, recall size, focus, active/early lists and custom subjects can be edited. Preferences are versioned and stored per account on this device; no cross-device preference sync is claimed.

Candidates come only from the finalized `pyq_concept_importance` snapshot for GI, and existing owner-scoped learning/bookmark rows for personal buckets. No family assignment is required. GI queries are subject-scoped and ranked by importance score (equivalent to HIGH/MEDIUM/LOW tier thresholds), latest year, then occurrences. Personal mistakes prefer active subjects without excluding other subjects. Due and older attempted questions supply revision. Candidates must be usable, non-GT question rows. The known unresolved image question is excluded from every bucket.

Personal buckets reserve their distinct questions first; GI fills its active/early targets from remaining candidates. Missing places use selected-subject GI, mistakes, saved/review, then HIGH GI from all subjects. GI-only uses GI fallbacks only; mistakes-only never adds unrelated sources. Scarcity is shown explicitly. The selected set is interleaved without duplicates and exact reasons/counts are persisted in existing session `filters.smart_recall` for ready, question, and resumed-session screens.

Only Smart Recall may request 10/20/30/50 questions. Existing scheduled Recall retains its 20-question cap. Standard preparation, payload loading, session snapshots, answer recording, timers, bookmarks and history are reused. No source/taxonomy/score changes, database migrations, authentication changes or sign-outs.

Validation: `node scripts/smart-recall-test.mjs`, `node scripts/test-session-timers.mjs`, plus browser integration against the actual app with an isolated in-memory backend. Production-like tests do not alter the user's learning history.
