# Compact study UI pass

UI-only update based on production aa26717 (same deployed file tree as 9d06576). No database, taxonomy, source content, scheduling, media pipeline, or scoring changes.

## Presentation

- QBank and ordinary Test builders use compact platform and subject tiles, retaining checkbox multiselect and the existing cascading facets.
- Modules appear after subject selection; 12 per page. Original source-test checkboxes remain the selected-state source of truth. Existing population resolver and session builder still choose/order questions.
- Module rows show source title, subject, PYQ/QBank label and declared question count when available.
- The existing recent-session endpoint supplies up to four sessions. Exact single-module matches show last-session percent correct and correct/total, or in-progress position and Continue. These are session metrics, not full-module completion/accuracy. Unavailable metrics are omitted; no unseen/attempted estimates are invented.
- All, Unattempted and Incorrect actions call the existing practice/test builder. Continue uses existing exact-session resume.
- Optional filters move under More filters; systems/topics/subtopics with no available choices are hidden. Meaningful taxonomy remains selectable there.
- Test presets and Core BTR/PYQ module rows are compact. Their catalog/start handlers are unchanged.
- Incorrect / Saved is in primary navigation. Existing review, bookmarks, marked questions and Analytics tabs are unchanged.
- Global Importance opens with all subject summaries. Concept filters appear inside subject detail or Recall Today. Existing five actions and scoring remain unchanged. Returning to all subjects is not narrowed by stale detail filters.
- Existing recent history stays capped at four and retains View History. Home/Active Recall/Continue Studying logic is untouched.
- Section loading placeholder added to Global Importance; existing filter count/loading and action preparation states retained.

## Validation

Isolated Chrome checks with the actual frontend and fixture backend, not authenticated live production:
- 1366×800 desktop, 390×844 phone and 768×1024 tablet: no document horizontal overflow.
- Platform → subject → modules, subject multiselect, module selection, pagination and unavailable taxonomy hiding passed.
- Adapter fixture with DAMS/Core BTR labels: meaningful topic stays accessible; empty subtopic hidden; All/Unattempted/Incorrect/Continue dispatch to the expected callbacks.
- Real module Incorrect action reaches the existing population resolver with the correct status and source-test ID.
- Last-session fixture renders exactly 68% correct · 17/25; absent metrics omitted. Resume fixture shows Question 5/25.
- Core BTR section/collection expands with existing Browse and Start controls.
- Global Importance starts without the detail filter form, subject opens primary concepts with Unassigned fallback and five actions; bookmark, similar search empty state and Practice PYQs readiness pass.
- 22 actual Marrow source question payloads hydrate with four options, answer, explanation, source context and order; downloaded clinical images decode, table and long explanations render.
- Actual practice UI answer/confidence, bookmark and mark-for-review handlers pass against isolated learner state.
- Existing deterministic Global Importance, study flow, Smart Recall, Final Smart Recall, Active Recall, shared timer and imported-media tests pass.
- GT and Analytics implementations are untouched; no authenticated end-to-end GT/DAMS attempt or Analytics data audit was performed.
- No user sign-out, database writes, source/taxonomy changes or live deployment performed.

## Remaining latency and limits

Global Importance still reads all concept rows through its existing paged query before presenting subjects. QBank facet counts still wait for the existing backend resolver. No backend performance improvement is claimed. Module performance is limited to matching recent sessions; comprehensive per-module progress needs a separate task. Browser validation used an isolated session because connected-browser tooling failed; production public HTML baseline was checked, but authenticated live interaction remains a deployment check.

No reference screenshot files accompanied the request text, so the written compact study guidance and existing QBank Hub design system guided this pass.
