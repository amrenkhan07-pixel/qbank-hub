# PrepLadder concept-classification strategic freeze

Status: **full-corpus reasoning classification parked**. Do not resume the 22,808-question sweep or try to fill blank concepts as a prerequisite for studying. This is a product-priority decision, not a failed cache or a mandate to redesign the classifier.

## Assets retained

- All 22,808 usable PrepLadder questions keep their original Platform → Subject → Source Test/module → ordered question structure. Missing canonical Concept is acceptable.
- The 1,355 trusted SAFE_V1 links remain the initial canonical concept seed. Frozen source artifact: `import-reports/prepladder-safe-v1-filter-20260920.json` (SHA-256 `f5b760e4834e746693349c20369b72a78b6235098d5308af027fb7c28772f6a2`). This freeze neither writes nor rolls back those links.
- The frozen 76-question reasoning gold benchmark is retained at `import-reports/prepladder-reasoning-frozen-gold-76-20260920.json` (SHA-256 `a0c49204ed3be996223a208d31076d51a24ddb9859eca614e67a7d1c4d3caeec`). Accepted PRIMARY result: 74/76 = 97.37%; BROADER is not part of V1.
- Exactly 2,616 valid, unique read-only reasoning results were checkpointed at `import-reports/prepladder-primary-reasoning-paused-20260920.jsonl` (SHA-256 `3dee986a6dbe5eca799ab5b27cc48c59e9c7b69297b8c538890794a0fde5f3b6`). The original append-only checkpoint remains `/tmp/qbank-reasoning-primary-full-v1.jsonl`. These results are staged evidence, **not** automatically trusted or persisted concepts. The remaining 20,192 questions are deliberately unprocessed.
- Existing classifier scripts, review tools, canonical tables, relationship layer, source material, and learner/SRM data are retained. Do not delete or overwrite their caches/checkpoints as part of this freeze.

## Going-forward policy

Deep concept reasoning is selective: prioritize NEET-PG and INI-CET PYQs, Grand Tests, Core BTR, curated subject tests, user-wrong/bookmarked/repeatedly missed questions, high-yield material, and cross-source recurrences. Generic QBank questions may stay at Platform → Subject → Source Test/module → question. The 1,355 SAFE_V1 links and future high-value evidence can support Ultra SRM while the user studies.

During future ingestion retain raw Global Importance evidence (exam occurrences and year, GT/BTR/curated-test presence, independent-platform recurrence) separately from personal weakness (wrong count, uncertainty, SRM lapses). Do not compute a final composite score yet. Cross-platform agreement should grow concepts from independent evidence, not from exhaustive classification of near-duplicate generic questions.

Priority order: stabilize normal QBank; ingest NEET-PG and INI-CET PYQs; then Grand Tests, Core BTR, curated tests, and useful DAMS/Marrow material; collect importance evidence; selectively classify; then freeze development and study. No ingestion is authorized by this note.

## Credit and safety guardrails

No thousands of reasoning calls without explicit authorization and a usage estimate. Reuse existing hashes and checkpoints; use small smoke tests; avoid broad repository scans and unnecessary parallel workers. The full PrepLadder runner is intentionally parked even though it remains available for reproducibility. No Supabase, schema, frontend, learner, or SRM changes were made for this freeze.

Next exact task: **NEET-PG + INI-CET PYQ ingestion**, after a separate request and source-data review.
