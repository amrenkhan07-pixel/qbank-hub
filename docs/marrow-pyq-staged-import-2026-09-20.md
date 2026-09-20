# Marrow PYQ staged import — production not authorized

Input: `marrow_Previous_Year_Question_Papers.html`, SHA-256 `8daf62f67903333ed9b9056092fed5c84a5ca3be26a9ad49c46fae964a004bbc`. The completed source audit is `marrow-pyq-source-audit-2026-09-20.md`; it was not rerun for medical classification. `scripts/marrow_pyq_stage.py` reads embedded `FOLDER_TREE`/`TESTS_LIST` and emits deterministic local data only. No reasoning model, taxonomy, frontend, learner, or production write path is invoked.

## Read-only live baseline and stage result

The current Supabase project is `flulljensjugfcxmeczu`. Read-only checks found 22,844 existing payloads, 1,129 PrepLadder source tests, 23,118 current source occurrences, 1,150 canonical version links, and **zero Marrow tests, payloads, or occurrences**. Every one of the 384 uniquely matched PrepLadder question IDs was confirmed to exist live; 28 already have canonical identity links. Protected-table baselines: 220 attempts, 74 sessions, 166 user-question-state rows, 37 bookmarks. Database before import: 92,458,131 bytes. These are baselines, not proof of a future write.

The saved artifact is `import-reports/marrow-pyq-stage-v1.json.gz` (SHA-256 `c3ee2697542afacd49d3931c71ec05f010190394dd2196252ff0c0efc132f76a`). It contains all source tests, raw/normalized stems, options, answer/explanation HTML, media URL metadata, content versions, identity proposals, and ordered occurrences. No image was downloaded. Its 342 local per-test payload objects total 4,538,219 bytes; the artifact can regenerate them without re-parsing the HTML.

| Stage measure | Count |
|---|---:|
| Source occurrences staged | 5,938 / 5,938 |
| Source tests | 342 |
| New Marrow raw content versions | 5,914 |
| New canonical identity proposals | 5,852 |
| Of those, Marrow-only identities | 5,496 |
| Existing PrepLadder question versions uniquely matched | 384 |
| Matches already linked to global canonical identity | 28 |
| Matches needing a new identity linking PrepLadder + Marrow versions | 356 |
| New Marrow occurrences proposed | 5,938 |
| Exact already present | 0 |
| Invalid/quarantined | 0 |

Per-occurrence proposed operations: `NEW_IDENTITY_NEW_VERSION` 5,219; `EXISTING_IDENTITY_NEW_MARROW_VERSION` 384; `EXISTING_MARROW_VERSION_NEW_OCCURRENCE` 21; `REVIEW_IDENTITY_CANDIDATE` 314. These sum to 5,938. The review reason breakdown is 286 stem-only matches and 28 multiple exact-core PrepLadder matches. Review candidates get a separate Marrow identity proposal; **no weak PrepLadder merge is proposed**. They can be ingested as independent source questions and reviewed later. Twenty-four byte-identical Marrow repeats share one raw version; the source's other 33 repeated-ID occurrences have formatting differences and retain distinct raw versions. All 57 repeated occurrences remain represented.

The local cache had 22,844 PrepLadder payloads, exactly matching the live payload count. This guards against an incomplete cache count but does not prove every cached payload is unchanged; a fresh read-only snapshot and per-ID conflict check remain mandatory before any write.

## Storage and structure

No table migration is required for this staged representation: existing `qbank_source_tests`, `qbank_question_payloads`, `qbank_payload_objects`, `qbank_source_occurrences`, `canonical_questions`, and `canonical_question_versions` can hold it. Use `Marrow` platform, `PYQ` source type, `exam_tags` for AIIMS/NEET-PG/INI-CET, explicit `exam_year`, null session for combined/unclear titles, the exact raw source title/test ID/path, and 1-based question position. Canonical identity remains independent of platform content versions, so PrepLadder explanations are never overwritten. No Topic/Subtopic/Concept assignment is required.

The 342 gzip payload objects are **4.33 MiB**; the standalone staged artifact is **6.37 MiB**. With 5,914 question/payload rows, 5,938 occurrence rows, 5,852 proposed new identities, canonical version links, tests and indexes, projected database growth is roughly **8–16 MiB**, plus **4.33 MiB** of object storage (about **12–20 MiB combined**). No mirrored-image bytes are included; external URLs are referenced only. Actual size must be measured after an authorized staged import.

## Prepared write contract — not executed

The current production RPC is PrepLadder-specific and **must not** be used for Marrow. A future dedicated writer should consume the frozen artifact, refresh live IDs/hashes and protected-table counts, and run at most one subject per transaction (19 resumable subject batches). Within each transaction: lock the Marrow subject; verify source hash, version/occurrence IDs and existing rows; create or skip source tests and the pending import run; confirm uploaded object hashes/lengths; insert only absent Marrow content versions; create/link canonical identities without changing any existing PrepLadder content; insert ordered occurrence rows with family/year/title provenance; verify per-test positions, foreign keys and counts; and atomically mark the batch committed. Existing rows with mismatching hashes/metadata must abort, never overwrite. Repeat with the same stable keys must skip, not duplicate.

Before and after every subject batch compare question/source counts and all protected learner counts (attempts, sessions, state, bookmarks); sample bounded QBank/PYQ queries and verify normal startup does not preload the 5,938 rows. Recovery is version/source-hash scoped: restore from a pre-import backup or, in one transaction after reference checks, remove only Marrow occurrences, Marrow content versions/object references and newly created canonical links/identities from this import run. Never touch PrepLadder versions or learner rows. External object uploads need a manifest-backed deletion plan only after database rollback is verified.

**Production status: NO-GO today.** The artifact and read-only reconciliation are ready, but no dedicated transactional Marrow writer or branch-tested rollback exists. The next separately authorized step is to implement and test that writer against these existing tables, take a fresh live snapshot, then obtain explicit approval before any production import. There is deliberately **no executable production `--apply` command** in this commit. To regenerate the local object files from the saved artifact only:

```sh
PYTHONPATH=scripts python3 scripts/marrow_pyq_stage.py --rehydrate-artifact import-reports/marrow-pyq-stage-v1.json.gz --object-dir /tmp/qbank-marrow-payload-objects-v1
```

No changes to frontend loading or server-bounded pagination were made. Any future PYQ view must continue to use bounded filters/pagination.
