# PrepLadder Concept V1 persistence and recovery

Status: production application pending. The immutable input is
`/tmp/qbank-safe-v1-filter.json`, SHA-256
`f5b760e4834e746693349c20369b72a78b6235098d5308af027fb7c28772f6a2`,
and classifier/filter version `safe-v1-filter-2026-09-14`.

The migration creates only `prepladder_concept_v1_concepts` and
`prepladder_concept_v1_assignments`. Both are service-only, RLS-enabled, and
contain no stem, options, explanation, source HTML, or learner data. The writer
accepts exactly 1,355 unique rows and performs the whole upsert in one database
transaction. Re-running the same artifact is a no-op and reports 1,355 skipped.

Before applying, run `python3 scripts/persist_safe_v1.py`. This verifies every
question reference, snapshots source/learner counts, checks existing links, and
exports the existing canonical concept tables beneath
`/tmp/qbank-safe-v1-production-backups/<UTC timestamp>/`.

After applying the migration, run
`python3 scripts/persist_safe_v1.py --apply`. The output checkpoint and the
complete compact assignment export are written beside the pre-write backup.

## Rollback

Rollback is version-scoped and must run in one transaction. It does not touch
questions, source occurrences, options, payloads, or any learner table:

```sql
begin;
delete from public.prepladder_concept_v1_assignments
where classifier_version = 'safe-v1-filter-2026-09-14';
delete from public.prepladder_concept_v1_concepts
where classifier_version = 'safe-v1-filter-2026-09-14'
  and not exists (
    select 1 from public.prepladder_concept_v1_assignments a
    where a.normalized_concept_ref = prepladder_concept_v1_concepts.normalized_concept_ref
      and a.classifier_version = prepladder_concept_v1_concepts.classifier_version
  );
commit;
```

Verify the protected source/learner counts against `manifest.json` after any
rollback. Dropping the dedicated tables or migration objects is not required
to deactivate this version and should not be used as routine cleanup.
