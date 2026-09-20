# Marrow PYQ writer validation — 2026-09-20

Status: **NO-GO for production import**. No production writes were made.

The dedicated writer prototype consumes only `import-reports/marrow-pyq-stage-v1.json.gz`. It rejects an altered SHA-256, unexpected counts, review/quarantine discrepancies, duplicate staged keys, or an unexpected artifact version. Its stable batch ID is `marrow-pyq-v1-20260920`.

The isolated SQLite implementation uses one transaction and checkpoint per subject (19 total), exact-key conflict checks, rerun skips, and batch-scoped rollback. It is a behavioral test of the intended write contract, **not** a production PostgreSQL adapter. There is no production apply or rollback command yet. Do not substitute the local commands for production commands.

## Isolated full-artifact result

- 342 source tests; 342 compact source payload objects.
- 5,914 Marrow content versions; 5,938 source occurrences.
- 5,852 new identities plus 28 pre-existing matched identities; 384 matched PrepLadder IDs total.
- 314 review occurrences (311 distinct Marrow content versions) remain separate from PrepLadder identities. No candidate was auto-merged.
- Exam occurrence counts: AIIMS 1,470; INI-CET 2,393; NEET-PG 2,075. Repeated source-ID groups: 56. No session label was invented.
- Second apply skipped all 19 subject batches, adding zero rows. Rollback restored every baseline table count. Reimport after rollback succeeded.
- Injected interruption after seven committed subjects: resume skipped seven and completed twelve. The final row digest equalled the uninterrupted import (`1259001fb8e6d967a073fdc438401528387d54ebda94c7083eaeb62f95ee6d2a`).
- Learner sentinel remained unchanged throughout. A shared/external identity link causes rollback to refuse and roll back its own transaction.

## Production read-only preflight

The dry-run used GET requests only against `flulljensjugfcxmeczu`. It authenticated, found zero existing Marrow tests and versions, confirmed the staged 22,844 total payload count and all 384 matched PrepLadder payload IDs, and wrote a read-only pre-import manifest to `/tmp/qbank-marrow-prod-preimport-readonly.json`. Current protected counts: questions 23,262; source tests 1,129; occurrences 23,118; attempts 220; test sessions 74; user question state 166; bookmarks 37. Writes: zero.

Projected import deltas: +342 source tests, +342 payload objects, +5,914 Marrow versions, +5,938 occurrences, +5,852 identities, plus identity links and review metadata. These are projections, not production results.

The current production schema has no verified Marrow-specific transactional write/rollback RPC. The existing generic import RPC does not provide the required occurrence/version contract. A PostgreSQL-compatible adapter must be implemented and tested on an isolated PostgreSQL database or approved Supabase branch before production import. No production apply/rollback command is available; treating the local SQLite flags as production commands is unsafe.

## Reproduce the local checks

```sh
python3 scripts/marrow_pyq_writer.py --local-db /tmp/qbank-marrow-isolated-v1.sqlite --apply-local
python3 scripts/marrow_pyq_writer.py --local-db /tmp/qbank-marrow-isolated-v1.sqlite --rollback-local
python3 scripts/marrow_pyq_writer.py --production-dry-run --backup-out /tmp/qbank-marrow-prod-preimport-readonly.json
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
```

The dry-run requires `SUPABASE_SERVICE_ROLE_KEY` in the environment and does not print it. The `/tmp` manifest is a checkpoint of counts and IDs, not a full production backup. The local pre-import manifest is adjacent to the isolated database as `*.preimport.json`.
