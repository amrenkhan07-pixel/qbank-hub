# Concept families and external classification bridge

The current editable baseline is `atlas-state.json`; the earlier batch files are immutable history. ENT is normalized to Otorhinolaryngology with an audit entry. Question IDs, primary concept text, confidence and needs_review remain unchanged. No primary concept is merged or approved.

Each registry concept has nullable `concept_family_id`. `concept_families` stores `concept_family_id`, `canonical_family_name`, `subject`, optional `system`, `aliases`, and `status`. Family imports must be draft and same-subject, and assign all canonical concepts exactly once. No family assignments have been inferred. Existing topic labels are display fallbacks only, not family assignments. Family metadata does not invalidate medical verifier stamps; changed concept identity/name/subject still does.

Use the Atlas buttons to export compact concepts and import assignments. Export displays the current `registry_revision` required in the return envelope:

```json
{"version":1,"registry_revision":"COPY DISPLAYED REVISION","families":[{"concept_family_id":"family-stable-id","canonical_family_name":"EXTERNALLY CLASSIFIED NAME","subject":"Medicine","system":"OPTIONAL SYSTEM","aliases":[],"status":"draft"}],"assignments":[{"concept_id":"EXISTING ID","concept_family_id":"family-stable-id"}]}
```

The example is a schema illustration, not an assigned medical family. Return all concepts once, preserving their IDs. Import rejects unknown IDs, duplicates, cross-subject assignments, stale registries, invalid status and incomplete coverage before mutation. Export a backup after browser imports; use that backup as STATE below. Browser storage and disk snapshots are distinct.

## Reusable command-line workflow

Run from the repository, using Node 22+ (or the desktop bundled Node executable). DATA is the source dataset JSON; STATE is a writable state JSON. Output files are compact JSON. No network or model is invoked.

```
node gt-taxonomy/bridge-cli.cjs export-unresolved DATA STATE classifier-input.json
node gt-taxonomy/bridge-cli.cjs import-classified DATA STATE externally-classified.json verifier-input.json
node gt-taxonomy/bridge-cli.cjs import-verifier DATA STATE external-verifier-results.json routing-counts.json
node gt-taxonomy/bridge-cli.cjs export-families DATA STATE concepts-for-families.json
node gt-taxonomy/bridge-cli.cjs import-families DATA STATE external-family-assignments.json
node gt-taxonomy/bridge-cli.cjs render DATA STATE gt-taxonomy/template.html gt-taxonomy/index.html
```

`import-classified` accepts the existing five-field array, rejects overwrites, preserves the supplied records in history, reuses exact canonical names/aliases within and before the batch, and creates only draft registry entries. It automatically prepares all imported questions for the external second pass, without the old 100-question export cap. External verifier JSON uses the existing VERIFIER.md contract: the engine validates revisions and reuse targets, then computes AUTO_ACCEPT / SOURCE_ISSUE / CLASSIFICATION_REVIEW. Classification imports alone remain pending verification. A source flag alone does not become a taxonomy disagreement. Semantic reuse still requires external verifier evidence; word similarity never automatically merges concepts. Registry expansion preserves still-valid prior decisions; nothing is auto-human-approved.

For a future source, prepare a packet with `version:1`, `dataset_id`, optional `platform`, and `questions` using the existing classifier fields. Every `question_id` must start with `dataset_id:`. IDs are never invented from source labels alone. Initialize separate files:

```
node gt-taxonomy/bridge-cli.cjs init future-source.json gt-taxonomy/atlas-state.json future-data.json future-state.json
```

This copies the reusable registry and families, but no prior question mappings. Then follow the same export/import/verifier commands. No Marrow data is classified or imported in this change.

## GT analytics release gate

This is a static taxonomy snapshot integration, using the existing authenticated `qbank_gt_state` RPC for completed attempts. No Supabase migration or production taxonomy write is required. The history RPC strips per-question outcomes, so the analytics button retrieves the complete finished attempt on demand. Its existing ownership enforcement is retained. The active exam module is unchanged and never loads taxonomy labels.

Before deployment:

1. Import the externally classified family assignments into STATE.
2. Obtain bindings from the seven committed live GT payload versions, with database test UUID, payload SHA-256, source test ID and ordered source question IDs. Do not substitute Atlas occurrence IDs for source question IDs or guess hashes.
3. Publish the snapshot, then deploy the two analytics modules and snapshot together:

```
node gt-taxonomy/bridge-cli.cjs publish gt-taxonomy/data.json STATE gt-payload-bindings.json gt-taxonomy/live-taxonomy.json
```

Binding envelope:

```json
{"version":1,"tests":[{"source_test_id":"SOURCE TEST ID","source_test_uuid":"DATABASE TEST UUID","payload_sha256":"64 LOWERCASE HEX CHARACTERS","question_ids":["SOURCE QUESTION ID IN POSITION 1"]}]}
```

Publisher requires complete family coverage, all GTs, exact source-question identity/order, and valid version hashes. Runtime joins database test UUID plus exact payload hash and refuses mismatches. Until a snapshot exists the analytics button reports that family assignments/publication are pending, without disrupting existing score history. Draft and pending-verification taxonomy remains visibly labeled; publication does not human-approve classifications.

Metrics use authoritative server outcomes: correct, incorrect, unattempted, and a separate answered-but-unscored category for exam rules such as INI-CET marking. Accuracy = correct / (correct + incorrect). Recurrence counts distinct corpus occurrences and distinct GTs, never repeat attempts. The completed view follows GT → Subject → Family (optional system) → Primary Concept → Question.

The existing GT response schema stores selected, marked and saved_at, not time per question. Average time is null/unavailable. The reducer accepts an explicit numeric `time_spent_ms` if a later trusted attempt contract supplies it; it never derives question time from timestamps or divides overall elapsed time among concepts. Adding true question timing later would require a separate capture/schema change, outside this task.

## Final family integration

Family assignment rows may also carry `subject`, `system`, `concept_family`, `confidence`, and `needs_review`. The bridge validates these values against the family and stores them unchanged in `family_assignments` and import history, separately from medical classification confidence. Production concepts expose `family_confidence` and `family_needs_review`; review flags remain draft.

Run `node scripts/integrate-gt-families.cjs` to convert the supplied array using the current registry revision, import it, publish against `gt-payload-bindings.json`, and write the recurrence/preservation report. The binding IDs were extracted from immutable payload files whose SHA-256 hashes match the seven committed production objects and exam answer keys. No question payload is regenerated.

Completed analytics has Subject → System → Family → Primary Concept → Question levels. Family recurrence sums all primary concepts in that subject-scoped family. The report also provides corpus-wide totals for identical system/family labels across subjects, without merging Atlas families or concepts. `.vercelignore` publishes only `live-taxonomy.json` from the Atlas directory.

The full Atlas HTML, template, source question dataset, editable Atlas state, and generated import envelope remain local-only and are not included in the production commit. Run import/reproduction commands in the existing Atlas worktree where those local inputs are available. The production commit includes only the compact question-content-free snapshot, original family classifications, bindings, report, and integration tooling.
