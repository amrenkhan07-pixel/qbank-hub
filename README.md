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

## Permanent HTML import workflow

The importer is separate from the browser application. It parses HTML locally,
resolves taxonomy against Supabase, classifies each row as `NEW`,
`EXACT EXISTING MATCH`, `POSSIBLE DUPLICATE`, `INVALID`, or `CONFLICT`, and writes
a machine-readable report under `import-reports/`. Dry-run never calls a write
endpoint.

One-time database preparation (review before applying):

```bash
supabase db push
```

The additive `202608280003_qbank_import_pipeline.sql` migration adds fingerprint
metadata, an RLS-protected import manifest, uniqueness constraints, and the
service-role-only transactional import RPC. It does not import content.

Mandatory dry run for every source:

```bash
SUPABASE_URL='https://PROJECT.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='runtime-only-secret' \
python3 scripts/qbank_import.py '/absolute/path/source.html' \
  --dry-run --platform Cerebellum --subject Anatomy \
  --source-collection 'Cerebellum Anatomy'
```

Never put the service-role key in this repository, a browser file, shell
history, or an import report. `--snapshot` can replace live access in tests.
When a source needs different markup selectors, copy
`scripts/import-profiles/generic.example.json`, adjust it, and pass `--profile`.

After manually reviewing a zero-blocker dry run, actual import requires all
safety gates and automatically runs importer tests plus the complete database
validation suite:

```bash
SUPABASE_URL='https://PROJECT.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='runtime-only-secret' \
DATABASE_URL='postgresql://runtime-only-connection' \
python3 scripts/qbank_import.py '/absolute/path/source.html' \
  --import --confirm-import --platform Cerebellum --subject Anatomy \
  --source-collection 'Cerebellum Anatomy'
```

Any possible duplicate, conflict, invalid structure, unresolved Platform or
Subject, or failing preflight test refuses the import. The database RPC uses one
transaction and checks question/option structure, taxonomy mappings, counts,
and protected learner-state counts before commit. Afterward, verify the actual
authenticated Platform → Subject → System → Topic → Subtopic UI cascade.

The PrepLadder pilot importer performs its remote preflight before hashing or
parsing the large source file. It verifies source readability/format, the exact
Supabase project, a runtime-only service-role or secret credential, Data API
access to every hybrid migration table, and the private payload bucket. It does
not use or wait for a localhost browser session:

```bash
SUPABASE_URL='https://flulljensjugfcxmeczu.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='runtime-only-secret' \
python3 scripts/prepladder_import.py \
  --source '/absolute/path/PREP_q_banks.html' \
  --import --acknowledge 'IMPORT PREPLADDER ANAESTHESIA ONLY'
```

If any prerequisite is wrong, the command exits with `IMPORT PREFLIGHT FAILED
before parsing` and does not generate payloads, upload objects, or change the
database. Never save the secret in the repository, frontend, report, or shell
history; supply it through a secure runtime secret mechanism.
