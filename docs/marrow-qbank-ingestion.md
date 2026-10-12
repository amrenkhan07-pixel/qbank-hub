# Marrow QBank source ingestion — October 2026

The ordinary Marrow QBank and trusted Marrow PYQ layer are separate collections. The supplied `marrow_qb.html` SHA-256 is `ccca4d0c95e20538469b1b438e0cfa51ffbd4c9a902ed25968b40626081faec8`.

## Production results

- 16,187 source occurrences; 16,186 subject-scoped question records; 19 subjects; 835 tests; 43 committed, resumable chunks.
- 16,183 practice-ready records. MA8669, MA8644, and MC2245 are preserved but excluded because the source refers to an absent visual.
- No missing stems/options/answers/explanations; no multiple-correct questions in this source. Correct-option arrays and the existing multi-answer mechanism are preserved.
- One exact same-subject repeated source ID reuses its record. Two cross-subject repeats retain separate subject-scoped records. Source order and all occurrences remain reconstructable.
- MB3590 has 53 NUL padding characters omitted only from its lightweight PostgreSQL stem. Its original payload is lossless.

## Collection identity boundary

The existing unique key is `(platform_id, source_question_id)`. QBank keys include a collection namespace: `QB:<raw-source-id>@<subject/content-identity-hash>`. Deterministic UUIDs also include `marrow-qbank-v1`, subject, source ID, and normalized content identity. Original raw IDs remain in payload/occurrence metadata, where overlap is allowed.

The additive `marrow_qbank_collection_identity_check` constraint enforces the QBank source type, collection name, platform, and `QB:` key shape. The service-role-only `qbank_commit_marrow_qbank_chunk` function uses INSERT only, never UPDATE/DELETE/ON CONFLICT UPDATE. Collisions fail atomically rather than overwriting PYQs. Existing chunk manifests must match their stored fingerprint before a retry is accepted.

All 1,443 overlapping raw IDs coexist with distinct PYQ and QBank UUIDs. Ten individual examples are recorded in the audit artifacts. Transactional tests proved that unscoped QBank keys and inserts colliding with a PYQ primary key are rejected.

The 5,914 PYQ records were not inserted, updated, or deleted. Before/after fingerprints match for all prior questions, options, source occurrences, tests, payload metadata, canonical decisions, and all three Global Importance aggregates. Global Importance remains 5,490 entries / 5,937 occurrences. Learner state and attempts also match their pre-import fingerprints.

## Media

8,556 references: 2,704 question images and 5,852 explanation references. Three are non-content tracking URLs, retained as provenance but omitted from rendering. All 8,533 unique clinical image URLs were retrieved and validated; content hashing yields 7,985 distinct binaries.

7,831 JPEG/PNG/WebP binaries are archived in the existing private `question-media` bucket (1,433,845,320 bytes). The 154 distinct GIFs remain on their verified original URLs and are cached locally; the existing bucket does not accept GIFs. No animation is converted or discarded. Original URLs, placement, and position remain in the payload.

The small app change resolves storage paths in batches of 100 for selected questions only. Signing failures fall back to original URLs. Other platforms retain their existing media behavior. No signed URL or privileged key is written into source payloads or client source.

Question payloads occupy 7,718,646 compressed bytes across 43 private objects. The four principal database relations grew by approximately 33.9 MB including indexes; physical allocation is not an exact per-import billing measure.

## Validation

- Every staged record, payload reference, test, and occurrence compared to production.
- Entire source reconciled for text/options/correct keys/explanations/media/order.
- Deterministic rerun dry-check: zero new records, zero new occurrences, zero conflicts.
- Actual app verification: 22 representative questions across 19 subjects, real clinical images (including live private storage), tables, long explanations, source context, desktop/mobile, bookmark/review and canonical attempt calls.
- Database learner checks used a synthetic user inside a rolled-back transaction; no actual learner history changed.
- Media resolver tests cover batching, deduplication, source immutability, tracking omission, and fallback. Existing timer checks pass.

Full reproducible scripts, source manifests, checkpoint logs, failures/recoveries, and validation outputs are retained in the project workspace under `artifacts/marrow-qbank-ingestion/`. Original HTML remains unchanged.

All available source content is accounted for and imported. Three absent source visuals prevent calling the entire corpus fully practice-ready; exclude those records from downstream indexing until resolved. The remaining 16,183 records are indexing-ready.

Semantic indexing was NOT performed in this task.
