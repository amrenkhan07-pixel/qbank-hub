# Recall performance and timer — 26 September 2026

Baseline production commit: `96d4751e9ee3b980e281f135d93c966db1ba18c1`.

## Scope and bottlenecks

Targeted inspection covered `app/app.js` QBank/Recall loading and solving helpers, `session-timers.js`, the obsolete `fixes.js` observer, and GT timer entry points. No corpus, occurrence map, or canonical graph was loaded; no taxonomy, SRM, ingestion, or database migration was changed.

- Recall fetched all seven startup metadata sources, including source-test lists and topic metadata that its landing page does not use.
- An unnecessary unfiltered facet RPC ran even for All platforms. Identical facet/count requests were not shared.
- Up to 500 queue entries were requested and every selected question, option, explanation and session snapshot was hydrated before the first question. Recall now asks the existing server queue for at most 20 questions per batch. Priority and daily SRM settings are unchanged; remaining questions stay due.
- Navigation wrote the answer, updated the old session position, then updated the new position before drawing. Recall now deduplicates unchanged answer writes, omits the old-position update, and draws after the answer is saved while the new position is syncing. Saving failures remain retryable.
- `fixes.js` attached a body-wide mutation observer and a permanent 500ms scan, duplicating retired timer behavior. The main page no longer loads this script. Shared timer text changes only when its displayed value changes.
- Authentication token refresh used to trigger an unnecessary rerender and metadata reset. Only a change of user identity now resets those caches.

## Changes and limits

Recall loads just subjects/platforms initially, with shared metadata requests. Facets are reused for 30 seconds and QBank counts for 15 seconds, with bounded caches and invalidation after learner mutations. Payload downloads share an in-flight promise and a checksum-keyed, eight-object decoded cache. Solving controls guard concurrent mutations; stale Recall responses cannot replace another route. Exit immediately stops the Recall clock and prevents an in-flight navigation from restoring the solving screen.

Explanation HTML remains rendered only after View explanation, and explanation images remain lazy. The existing compressed hybrid payload object is still the download unit: a selected question may require its containing source-test object. This pass does not repack content or introduce new APIs. Large explicitly selected non-Recall tests keep their existing exact-set snapshot behavior.

## Controlled before/after measurement

A synthetic browser fixture used 40 due relational questions, All platforms / All subjects / All Due, 60ms simulated latency per request plus response-size cost at 2 MB/s. Same fixture and filter in both versions. Cold load includes metadata, queue, ready-set preparation and session start; human time between clicks is excluded. Before renders 40 questions; after starts the first 20-question batch.

| Measurement | Before | After |
| --- | ---: | ---: |
| First solving question | 764 ms | 630 ms |
| Initial requests | 17 | 11 |
| Initial response bytes | 506,658 | 253,609 |
| Next, all writes complete | 185 ms | 126 ms |
| Next, visible question | 185 ms (render follows final write) | 64 ms |
| Next requests | 3 | 2 |
| Next response bytes | 6 | 4 |

These are controlled fixture measurements, **not measured production-account latency**. The native browser connector failed before session access, so the user's authenticated queue could not be profiled. Compressed hybrid object transfer sizes and real network/database latency remain unmeasured.

## Recall timer

- Uses the shared clock with a configurable per-question limit; unchanged default for other modes is 50 seconds.
- Recall defaults to 50 seconds; Off / 50 sec / 55 sec is available on the queue, ready screen and solving screen.
- Preference is stored per user in localStorage; the session's selected duration uses its existing `target_seconds_per_question` column. Local clock checkpoints preserve Recall's setting on resume.
- A new unanswered question starts a fresh countdown. Answered questions retain their recorded elapsed time.
- Expiry visibly shows “Time’s up — continue when ready”. It does not submit, skip, or disable answering.
- Off hides the countdown and still records elapsed time for analytics.

## Timer coverage

| Mode | Timer support |
| --- | --- |
| Recall solving | Off / 50 / 55 sec, advisory expiry |
| Normal QBank Practice | Shared 50-sec question + total timer; existing Pause/Resume |
| Custom, revision, PYQ, Core BTR regular tests | Shared question + total timer; existing behavior unchanged |
| GT strict Exam Mode | Server-authoritative section/exam timing; no pause, unchanged |
| GT Practice Mode | Existing section/exam timer with Pause/Resume, unchanged |
| Browse questions / completed-answer review | Untimed |
| Personal recall-card authoring | No solving timer in the authoring UI |

## Targeted verification

`test-recall-performance.cjs` passed: bounded queue, default timer, 55-second expiry without skip/submit, question reset, Off elapsed-time analytics, deferred explanation DOM, bookmarks/marks, incorrect attempt recording, automatic unsure confidence on correct-answer navigation, deduplicated saves, failed-save retry, facet/payload request coalescing, exit during navigation, and preference persistence. Existing `test-session-timers.mjs` passed pause/resume, serialization and expiry regressions. JavaScript syntax and diff whitespace checks passed. No broad browser suite or parallel agents were used.

The fixture uses Playwright (`PLAYWRIGHT_PATH` can identify an installed package) and optional `CHROME_PATH`. Run from the repository root. It only serves and mocks local data. Detailed counts are in `recall-performance-results.json`.
