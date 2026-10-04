# Three targeted study-flow fixes

## Presentation
Smart Recall's ready preview and question banner show only subject, validated importance tier and fixed selection labels. Concept-practice titles and topic/subtopic summaries are hidden before answering. The answer panel reveals the stored primary concept after submission (including multi-select). No source or classification metadata is deleted.

## Coverage rotation
`smart_recall_concept_coverage` is keyed by account, exam focus, subject and finalized concept ID. A session assignment records recent exposure; a submitted correct answer marks the concept covered. Previewing, skipping or choosing a multi-select option before submission does not count as covered. A one-time backfill recovers existing saved Recall decisions without rewriting history.

For each subject and exam focus, the candidate query selects uncovered HIGH concepts first; only after those are covered does it move to MEDIUM, then LOW. Within the current tier, never-assigned and least-recently-exposed concepts precede recent assignments. A deterministic account/date/concept hash breaks equal-priority ties. After every eligible concept is covered, least-recent exposure drives resurfacing across tiers. Importance scores are not changed.

One primary concept contributes at most one Global Importance question per plan, regardless of its PYQ count. Mistakes, bookmarks and due buckets retain their existing eligibility and scheduling; these are reserved first and overlapping concepts are suppressed from the GI allocation. The active/early target remains 60/40. Optional families are not required. Smart Recall currently uses exam focus All; concept-launched Recall preserves its existing exam selection.

The server returns at most 50 candidates per subject, with usable question IDs only, excluding the unresolved image item and GT questions. No attempt-history scan was added to page loading. Coverage is protected by owner RLS and authenticated-only read functions; writes are tied to existing session/answer triggers.

## Resume and Continue Learning
Existing account-owned `test_sessions`, `test_session_questions` and `test_answers` remain the source of truth, including position, frozen order and selected filters. Resume always takes precedence; its card now describes the saved study context. No new continuation table or device-only state was added.

When the latest completed ordinary QBank session fully answers a single source module, Continue Learning offers the next usable module with the same platform, subject and source path, using explicit source sequence. A single common module can be inferred from saved occurrence membership when no module filter was recorded. Partial module completion, ambiguous membership/order, or an exhausted sequence does not invent a next module. GT and concept-practice sessions are excluded.

## Validation
- SQL rollback fixtures: coverage progression, successful completion, exam/account isolation, partial-module guard, explicit next-module sequence, and saved question position.
- Browser with isolated account state and real imported payloads: Enterobius label absent before answering and present afterward; actual browser reload resumes question 23/40; Resume outranks Continue; Continue opens server-selected source module.
- Unit checks: duplicate concept suppression, mistake exception, safe metadata and study labels.
- Existing Smart Recall quota/60-40, Global Importance model, shared timer and GT rules tests pass.
- Existing GT lifecycle harness fails the same timer assertion on both production baseline and this change; GT implementation files are unchanged.
- Before/after fingerprints match for 61,047 questions, 65,998 source occurrences, and all 5,490 importance entries (5,937 PYQ occurrences).

Production account authentication was not altered or signed out. No classification, ingestion, media, source, PYQ score or GT implementation changes.
