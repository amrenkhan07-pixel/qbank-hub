# GT Practice Mode and shared QBank timers

Practice GTs preserve the existing exam sections and question order while allowing pause/resume. The server freezes effective elapsed time, rejects answers while paused, and preserves completed-section locks. Strict Exam Mode remains unpausable. The existing one-active-attempt-per-paper constraint is retained; finish the active attempt before switching modes on that paper.

Normal QBank question and total timers use one millisecond clock. Manual pauses and answer-review pauses freeze both. Timer snapshots persist locally and in the session row, including across refresh and route navigation. Legacy sessions without snapshots fall back to recorded answer time; historical unrecorded pauses cannot be reconstructed precisely.

Migration: 20260923100022_gt_practice_shared_timers.sql (applied). No question imports, taxonomy, importance, or spaced-repetition changes.

Validation: shared-clock unit tests; existing GT rules and lifecycle tests; JavaScript syntax checks; isolated PostgreSQL migration compilation and 12 existing strict-mode checks; rollback-only SQL tests for pause ownership, idempotency, section locks, finalization, and normal-session completion. Browser checks cover practice pause/refresh/resume, section advancement and previous-section lock, strict NEET mode without pause, normal QBank pause across navigation/refresh, server-only timer recovery, and zero runtime errors.
