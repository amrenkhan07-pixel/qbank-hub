# QBank Hub

A private, Supabase-backed medical QBank for practice, durable timed tests, review, and cross-device study.

## What is implemented

- Supabase email/password authentication, reset-password flow, persistent sessions, and sign-out.
- Responsive dashboard using real attempts, questions, bookmarks, review items, and test-session data.
- Filtered/randomized QBank practice, answers, explanations, question palette, bookmarks, private notes, and reports.
- Durable timed tests with a real deadline, autosaved answers/current position, stable question snapshots, resume on another device, automatic timeout submission, results, and history.
- An additive Supabase migration for learner data, test snapshots, review, basic taxonomy, PYQ fields, question media storage, indexes, RLS, and server-side test finalization.

## Safe setup

1. Inspect the live Supabase schema and data first. The current project was built against `questions`, `question_options`, `subjects`, `platforms`, and `question_attempts`; do not delete or rename them.
2. Review and apply [`supabase/migrations/202608250001_qbank_learning_features.sql`](supabase/migrations/202608250001_qbank_learning_features.sql) through the Supabase CLI or SQL editor. It stops early if `questions.id` is not a UUID, rather than making an unsafe schema assumption.
3. Review existing RLS policies for the five original tables. The migration protects every new user-owned table, but intentionally does not replace unknown existing policies.
4. Serve this directory as a static site or deploy it to Vercel. [`vercel.json`](vercel.json) requires no build step.

The checked-in Supabase URL and `sb_publishable_…` key are public client configuration only. Never add a service-role/secret key to this repository or browser code. To point at another project, provide a deployment-time `window.QBANK_CONFIG` matching [`app/config.example.js`](app/config.example.js) before `app/app.js` is loaded.

## Verification checklist

- Sign in, sign out, and request a password reset.
- Start a 10-question practice set; answer, bookmark, note, report, and revisit a question.
- Apply the migration, start a short timed test, refresh the page, then resume it; verify its countdown does not reset.
- Submit a test and verify its result/history appears from a second device using the same account.
- Confirm account A cannot read account B's bookmarks, notes, review queue, test sessions, or test answers.
