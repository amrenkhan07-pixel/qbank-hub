# Global Importance + Recall v1

Routes: `#/global-importance`, `#/importance-subject?subject=Medicine`, and `#/importance-recall`. Existing `#/recall` remains the scheduled-question queue.

The only taxonomy input is the finalized `pyq_concept_importance` snapshot: 5,490 subject-scoped concept entries, 5,937 occurrences. No family assignment is required. Null families display as Unassigned.

## Personalization

The invoker-security `pyq_concept_recall_v1` view reads only the signed-in user's `user_question_state`, concept bookmarks, and practice links. It uses mapped PYQs plus question IDs the user explicitly selected through concept practice. These links are personal associations, not canonical classifications. Attempts continue to be recorded by the existing practice/session implementation.

Recall priority is **0.45 × global importance + 0.35 × personal weakness + 0.20 × memory urgency**. Additive weights implement the stated intent that incorrect/overdue concepts rise in priority. Weakness is the wrong-attempt percentage, with a 20-point current-incorrect boost, capped at 100. New concepts have weakness/urgency zero. Overdue urgency starts at 50 and gains 5/day up to 100; otherwise days since last review scale to 100 over 30 days. No personal data is fabricated for new users.

Concept bookmarks have owner-only RLS. Question bookmarks, incorrect state, timers, session snapshots, and history continue through the existing flows. Existing session/attempt tables are not changed.

## Search

A GIN expression index covers existing usable, non-GT question stems, inline options and explanations. `gi_similar_questions_v1` is SECURITY INVOKER and accepts a finalized concept identity, not arbitrary SQL. It extracts lexical terms, ranks subject match, text relevance, shared terms, platform availability, recency, incorrect state and bookmarks. It does not assign taxonomy to results. It returns at most 100 questions (UI: 30).

Most hybrid questions store full options/explanations outside Postgres. Their stored stems are indexed; the external options/explanations load on demand through `loadQuestionsByIds` when a set is prepared. Explanation-only matches in those external payloads are not covered by v1. No bulk payload import or ordinary-question classification is performed.

Exam focus narrows concepts and PYQ practice. Ordinary QBank similarity results need not have PYQ exam tags. Source selects the contents of Mixed Recall/Review incorrect; Practice PYQs and Find similar QBank retain their explicitly named sources.

## Validation

`node scripts/global-importance-test.mjs` exercises the primary-concept model. Browser fixture tests cover direct concepts, Unassigned filtering, all concept actions, practice-ID handoff, bookmarks, recall reasons, and mobile layout. Live read-only authenticated-role checks validate 5,490 concepts/5,937 occurrences, exclusion of the unresolved image item, result retrieval, and user-state isolation.

The existing `scripts/qbank-validate.mjs` returns 333/340 both before and after this change: seven pre-existing checks fail (session total columns, five timer contracts, one cache-busting contract). No new failures were introduced. Live authenticated write/resume interactions require the user's normal signed-in app session; fixture tests do not write real learner history.

Database prerequisites: the three Global Importance v1 table/views created earlier. The two new migration files are additive and have been applied to the connected project. Frontend code is applied to the saved qbank-hub checkout; deployment is separate.
