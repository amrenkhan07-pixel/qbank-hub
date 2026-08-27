# QBank Hub

A private, Supabase-backed medical learning application for focused practice, tests, review, active recall, analytics, and personal content.

## What is implemented

- Supabase email/password authentication, reset-password flow, persistent sessions, and sign-out.
- Six study-focused areas: Home, QBank, Test, Review, Analytics, and My Bank.
- Dependent, multi-select Platform → Subject → Topic → Subtopic filters, with optional System metadata.
- Sanitized rich question/explanation rendering, persistent bookmarks and review marks, confidence/error feedback, and a fixed 50-second question target.
- Durable Practice/Test sessions with stable question order, frequent progress saves, resume, results, and history.
- Deterministic recall scheduling, actionable review/analytics, personal MCQs/cards/notes/tags, and protected learning-state reset.

## Safe setup

1. Inspect the live Supabase schema and data first. The current project was built against `questions`, `question_options`, `subjects`, `platforms`, and `question_attempts`; do not delete or rename them.
2. Apply [`supabase/migrations/202608250001_qbank_learning_features.sql`](supabase/migrations/202608250001_qbank_learning_features.sql) first if it is not already present in the project.
3. Review and apply [`supabase/migrations/202608270001_learning_interface_foundation.sql`](supabase/migrations/202608270001_learning_interface_foundation.sql). It is additive and maps any existing child-topic relationships into the new subtopic layer without deleting imported data.
4. Review RLS/Data API access after applying migrations. Newer Supabase projects may require explicit Data API exposure; the migration includes authenticated grants and owner-scoped RLS for new learner tables.
5. Serve this directory over HTTP or deploy it to Vercel. Do not use `file://` as the production-equivalent preview because ES modules require an HTTP origin.

Local preview:

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

Then open `http://127.0.0.1:4173/`.

The checked-in Supabase URL and `sb_publishable_…` key are public client configuration only. Never add a service-role/secret key to this repository or browser code. To point at another project, provide a deployment-time `window.QBANK_CONFIG` matching [`app/config.example.js`](app/config.example.js) before `app/app.js` is loaded.

## Verification checklist

- Sign in, sign out, and request a password reset.
- Select multiple platforms and subjects; confirm topics/subtopics narrow to the selected hierarchy.
- Start a 10-question practice set; answer, view the formatted explanation, bookmark, mark, note, and revisit a question.
- Start a test, answer several questions, refresh, then resume at the saved position.
- Submit a test and verify its result/history appears from a second device using the same account.
- Create a personal MCQ and select `My Content` in QBank/Test.
- Confirm reset clears only personal learning state and never deletes imported questions.
- Confirm account A cannot read account B's bookmarks, notes, learning state, personal content, test sessions, or test answers.

## Fail-safe validation

Run the deterministic frontend fixtures and source-contract checks:

```bash
node scripts/qbank-validate.mjs
```

Run the same checks plus the read-only aggregate database invariants after an import or non-destructive migration:

```bash
DATABASE_URL='postgresql://…' node scripts/qbank-validate.mjs --database
```

The command prints one concise `PASS` or `FAIL` line per invariant and exits non-zero if any check fails. It uses aggregates and stable synthetic fixtures; it does not alter real learner state or enumerate filter permutations. The imported-question floor is currently 418 in `scripts/qbank-validation.sql`; after a verified import, raise that floor to the newly accepted imported count so a later non-destructive migration cannot silently reduce it.
