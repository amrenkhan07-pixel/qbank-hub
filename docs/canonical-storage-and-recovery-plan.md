# Canonical storage and recovery plan

Measured 2026-09-13 before any further classification. This plan preserves source content, source-test ordering, learner history, the 150-question pilot, and every draft/review artifact.

## Current footprint

| Area | Measured size |
| --- | ---: |
| PostgreSQL database | 83.85 MiB (87.92 MB) |
| External compressed QBank payload objects | 21.53 MiB (22.57 MB), 1,129 objects |
| Canonical/taxonomy tables and indexes | 9.12 MiB |
| Draft/review-only canonical artifacts | 3.58 MiB |
| Production canonical identities, versions and assignments | 0.84 MiB |
| Source-test normalization | 2.48 MiB |
| Review-only concept relationships | 0.15 MiB |

Largest relations are `questions` (21.44 MiB), `qbank_source_occurrences` (16.84 MiB), `qbank_question_payloads` (11.55 MiB), and `test_session_questions` (3.31 MiB). The session-question snapshot averages 1,872 bytes of JSON per row and is the clearest long-term learner-history growth risk.

## Growth model

The current pilot stores verbose evidence in both pilot rows and concept-assignment provenance. Repeating that pattern across 23,262 questions would add approximately 85–110 MB. Retaining full draft sample/evidence rows per question as well would raise the estimate to approximately 125–160 MB.

The compact production model stores IDs and small state codes in assignments, references one run-level provenance record, retains detailed evidence only for low-confidence/ambiguous/overridden/reviewed cases, and allows secondary paths only where medically justified. Measured compact rows are 72 bytes for canonical identity, 152 bytes for content version, 97 bytes for taxonomy assignment, and 96 bytes for concept assignment before indexes/page overhead. With 5–10% true secondary paths, the current 23k corpus is projected to add approximately 23–29 MB.

Assumptions for later imports:

- 120 Grand Tests at 200 questions each: about 24,000 occurrences. If 70% reuse known content, approximately 35–45 MB database plus 20–30 MB compressed object storage; all-unique worst case approximately 70–85 MB database plus 20–30 MB object storage.
- BTR, DAMS, Marrow and additional PYQ sources: for 60,000–100,000 occurrences and 30,000–60,000 genuinely new content versions after exact reuse, approximately 130–240 MB database plus 30–90 MB compressed object storage. PYQ labels that reference existing occurrences should add only about 1–5 MB.
- Learner history: attempts/SRM events are expected to consume about 0.25–0.4 KB per row including indexes. One million rows of either is about 250–400 MB. One active state row for each current question is about 7–12 MB. At the current measured layout, 100,000 session-question snapshots would consume about 225 MiB and should be addressed separately before large multi-user growth.

These are planning ranges, not quotas. Every import must record before/after relation sizes and stop on unexpected amplification.

## Data disposition

Keep in production:

- taxonomy versions/nodes, canonical concepts and review-only concept relationships;
- canonical question identities/content-version links;
- primary taxonomy/concept assignments plus genuine secondary paths;
- run-level classification provenance and compact approved source-test mappings.

Keep but compact after approval:

- source-test proposals and rules until Canonical Taxonomy v1 is approved;
- assignment provenance as a classification-run reference rather than repeated JSON;
- detailed evidence only for low-confidence, ambiguous, content-override, or human-review cases.

Archive after Canonical Taxonomy v1 approval and a successful restore drill:

- draft samples, draft evidence, draft rules and pilot evidence;
- source-test proposals/rules after compact mappings and reviewer overrides are exported.

Safe to drop now: none of the draft or review data. The migration removes only four byte-identical redundant indexes (3.97 MiB total) while retaining their constraint-backed or actively used equivalents.

Investigate before any later removal: `canonical_taxonomy_node_relations` versus `canonical_concept_relationships`. Their provenance and consumers have not yet been proven equivalent.

## Backup and recovery

Git is the schema/code record, not a data backup. Create stable release tags for Core v1, taxonomy draft, and eventual taxonomy approval; keep every migration and a schema-only dump after approved migrations.

Before every import, and weekly while classification/review is active:

1. Generate `scripts/qbank-backup-manifest.sql` and retain the count/checksum output.
2. Create encrypted data-only logical dumps separately for learner tables and canonical/review tables.
3. Retain the compressed payload-object manifest and an external copy of object storage/import sources.
4. Monthly, create a full logical database dump plus storage snapshot.
5. Keep at least one encrypted local copy and one independent off-device/cloud copy.
6. Quarterly, restore into an isolated scratch Postgres instance and compare every manifest count and checksum before declaring the backup usable.

Learner backups must include attempts, state, notes, flags, SRM events, sessions, session questions, test answers and history. Canonical backups must include versions, nodes, concepts, relationships, identities, content-version links, assignments, draft evidence/reviews, source-test proposals/reviews, and classification runs. Never test recovery against production.

## Gates before classification expands

- The compact storage validation and complete QBank validation both pass.
- Questions, occurrences, options, attempts, sessions, learner state, and the 150-question pilot match the pre-run manifest.
- No stems/options/explanations are copied into compact canonical tables.
- Source-test mappings store IDs only and at most one current primary mapping.
- Detailed evidence remains sparse and exception-only.
- Normal QBank startup continues to use server-bounded counts and does not fetch the corpus.
- A fresh recoverable backup and matching manifest exist before each production batch.
