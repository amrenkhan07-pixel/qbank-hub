# Marrow PYQ production write-contract trace

Input is exclusively `import-reports/marrow-pyq-stage-v1.json.gz` (SHA-256 `c3ee2697542afacd49d3931c71ec05f010190394dd2196252ff0c0efc132f76a`). No source HTML is needed at apply time. Import batch: `marrow-pyq-v1-20260920`.

## Existing working path

`scripts/prepladder_import.py` validates project/credential and table/bucket access, calls `qbank_begin_prepladder_import`, uploads and verifies private gzip payload objects, then calls `qbank_commit_prepladder_import` once per subject. The commit RPC owns the database transaction: it inserts source tests, payload-object metadata, questions, question-payload indexes and occurrences, checks their relationships and protected learner counts, then marks the import run/objects committed. The Python wrapper removes only newly uploaded objects if commit fails.

This is not yet generic: both begin and commit functions in `202609020005_prepladder_bulk_import.sql` reject any platform other than `PrepLadder`; commit also writes PrepLadder-specific `source_collection`, `source_type`, and source-subject assumptions. Neither function creates canonical identities/version links or retains Marrow review-candidate metadata. The SQLite `scripts/marrow_pyq_writer.py` contract uses simplified local tables and cannot be applied to production tables directly.

## Exact artifact-to-production mapping

| Production entity | Staged input | Planned new rows | Ownership / uniqueness |
| --- | --- | ---: | --- |
| `qbank_hybrid_import_runs` | one manifest per subject | 19 | unique source SHA, platform, subject, parser and schema version; must identify this batch |
| `qbank_source_tests` | `source_tests` | 342 | deterministic UUID and `stable_key`; unique platform/subject/source-test ID |
| Private `qbank-payloads` objects | `payload_objects` plus `content_versions[].payload` | 342 | deterministic path and compressed SHA; preserve Marrow explanations/media refs |
| `qbank_payload_objects` | `payload_objects` | 342 | object path unique; FK to run and source test |
| `questions` | `content_versions` | 5,914 | deterministic Marrow question UUID; Marrow/PYQ fields only; no learner rows |
| `qbank_question_payloads` | `content_versions` | 5,914 | question ID and platform/subject/content SHA uniqueness; object/index FK |
| `qbank_source_occurrences` | `occurrences` | 5,938 | occurrence key unique; source-test/position unique when current; exam/year/session/source ID/order retained |
| `canonical_questions` | `proposed_canonical_question_id` | 5,852 | reuse 28 already-existing canonical IDs; never auto-merge review candidates |
| `canonical_question_versions` | Marrow versions plus unmatched PrepLadder matches | 6,270 | 5,914 Marrow links + 356 as-yet-unlinked PrepLadder links; question ID unique and canonical sequence unique |
| Review metadata | `review_reason`, occurrence candidate IDs | 311 version records / 314 occurrences | must remain linked to Marrow identity without automatic PrepLadder merge |

The 384 exact-core PrepLadder matches include 28 already linked to canonical identities and 356 needing a new canonical identity and link. The 314 review occurrences represent 311 distinct Marrow versions; all receive independent Marrow identities. The 28 multiple-exact-match occurrences are never guessed. Repeated Marrow source IDs remain distinct occurrences, not additional content versions.

## Blocking prerequisites for a safe apply

1. A Marrow-aware per-subject PostgreSQL transaction/RPC is required. Reusing the current PrepLadder RPC unchanged is impossible because of its platform guard and hard-coded values. Independent REST writes would not preserve the tested atomic-batch behavior.
2. The transaction must create canonical identities/version links and store review-candidate provenance; the current PrepLadder RPC does neither. For each canonical identity, version sequence allocation and pre-existing-link conflicts must be checked atomically.
3. Production rollback ownership must be recorded across all inserted tables and private storage paths. Existing tables generally have no import-batch column; run ID covers some payload/occurrence records, but not `questions`, source tests or canonical links. Deleting by projected IDs without checking external references would be unsafe.
4. The new RPC/rollback must be validated on disposable PostgreSQL or a Supabase branch before any production apply. The existing isolated SQLite test proves staging semantics, not the production SQL contract.

Until these prerequisites are met, there is no safe `--apply-production` or `--rollback-batch` command. The current production dry-run remains read-only; it cannot certify unavailable write/rollback functions. **NO-GO** for actual production import.
