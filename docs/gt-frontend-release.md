# GT frontend release

Reuses the seven production Core BTR GTs and existing GT RPCs. No backend migrations, imports, taxonomy, Global Importance, SRM or normal QBank timer changes.

Preserves INI-CET 4 × 50 × 45 minutes and NEET-PG 2025 format 5 × 40 × 42 minutes. The incompatible 180-question option remains disabled for existing 200-question papers.

Fixes a GT-only race where an obsolete asynchronous load could replace/cancel the current interval during overlapping authentication/route renders. Each attempt owns its interval and obsolete loads cannot install timers. Analytics adds elapsed time from existing timestamps.

Validation: scripts/test-gt-rules.mjs and scripts/test-gt-lifecycle.mjs. Actual frontend tested against production RPCs using a temporary account: both presets start, save, resume, auto-advance and lock previous sections; final expiry submits and displays results; history shows scores, accuracy, time used and section results. Only the temporary account’s timestamps were accelerated to test boundaries; normal timers/rules were unchanged. The account and its test history are removed after production verification.

Unrelated local artifacts are preserved in a named Git stash. The prior Global Importance app wiring is also backed up outside the release at /tmp/gt-release/app-with-importance.js.
