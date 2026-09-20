# Marrow PYQ source audit — read only

Source: `/Users/moirashams/Downloads/marrow_Previous_Year_Question_Papers.html` (17 MiB; SHA-256 `8daf62f67903333ed9b9056092fed5c84a5ca3be26a9ad49c46fae964a004bbc`). Parsed the embedded `FOLDER_TREE` and `TESTS_LIST`, not rendered DOM. No import, classifier, model calls, Supabase writes, or learner-state changes.

## Exact source inventory

**342 tests, 5,938 question occurrences, 19 subjects.** The source has 20 folder spellings because Obstetrics & Gynecology occurs once with `&` and 17 times with `and`; the audit treats these as one subject but preserves original folder paths and titles.

| Subject | Tests | Questions |
|---|---:|---:|
| Anaesthesia | 18 | 115 |
| Anatomy | 18 | 319 |
| Biochemistry | 18 | 310 |
| Community Medicine | 18 | 399 |
| Dermatology | 18 | 163 |
| ENT | 18 | 161 |
| Forensic Medicine | 18 | 246 |
| Medicine | 18 | 573 |
| Microbiology | 18 | 431 |
| Obstetrics & Gynecology | 18 | 505 |
| Ophthalmology | 18 | 213 |
| Orthopedics | 18 | 200 |
| Pathology | 18 | 479 |
| Pediatrics | 18 | 254 |
| Pharmacology | 18 | 463 |
| Physiology | 18 | 316 |
| Psychiatry | 18 | 134 |
| Radiology | 18 | 134 |
| Surgery | 18 | 523 |

| Exam family | Tests | Questions |
|---|---:|---:|
| AIIMS | 76 | 1,470 |
| NEET-PG | 152 | 2,075 |
| INI-CET | 114 | 2,393 |

| Exam/year | Tests | Questions |
|---|---:|---:|
| AIIMS 2017 | 19 | 391 |
| AIIMS 2018 | 19 | 380 |
| AIIMS 2019 | 19 | 306 |
| AIIMS 2020 | 19 | 393 |
| NEET-PG 2018 | 19 | 297 |
| NEET-PG 2019 | 19 | 295 |
| NEET-PG 2020 | 19 | 284 |
| NEET-PG 2021 | 19 | 200 |
| NEET-PG 2022 | 19 | 199 |
| NEET-PG 2023 | 19 | 200 |
| NEET-PG 2024 | 19 | 400 |
| NEET-PG 2025 | 19 | 200 |
| INI-CET 2021 | 19 | 399 |
| INI-CET 2022 | 19 | 595 |
| INI-CET 2023 | 19 | 399 |
| INI-CET 2024 | 19 | 400 |
| INI-CET 2025 | 19 | 400 |
| INI-CET 2026 | 19 | 200 |

Title parsing recognizes both `Ini Cet` and `Inicet`; it preserves `Aiims` as AIIMS, including the 2020 title containing parenthetical `Ini Cet`. `Neet` is NEET-PG. Year is the explicit title year. Combined `(May & Nov)` or `(May And Nov Ini Cet)` is retained only in the raw source title; individual question session is null, never invented. Per-question provenance retains source test ID/title and 1-based position.

## Data quality

- Missing stems/options/answer keys/explanations, malformed question objects, option/answer conflicts, blank option text, and unusual option counts: **0 each**. All 5,938 have exactly four options. Genuine multi-correct: **0**.
- Question image: 1,468 questions / 1,468 references. Explanation image: 2,161 questions / 3,659 references. Overall 5,127 media references, 4,805 distinct URLs. Video/audio: **0**. References are external HTTP(S) URLs, not embedded image objects; availability/rights were not tested.
- Duplicate source question IDs: 56 ID groups, causing 57 extra occurrences. No repeated ID has conflicting full content. The same 56 groups account for 57 exact normalized full-content repeats. Identical full content under different IDs: **0**. Two additional duplicate groups emerge if explanation is excluded.
- `FOLDER_TREE` declared counts matched parsed tests/questions.

## Local overlap estimate, not a production dedupe decision

Compared deterministic normalized hashes against an existing **incomplete local PrepLadder PYQ payload cache** (1,127 cached test objects, 7,400 PYQ occurrences). This is not a live database snapshot and lacks source-question IDs, so exact cross-platform ID overlap is **unknown**; do not claim it is zero.

- Exact normalized stem + options + answer + explanation overlap: **0** occurrences.
- Same stem + options + answer, but different explanation: **419 occurrences / 417 distinct Marrow payloads**. These are strong common-question candidates, not identical content versions.
- Stem-only candidates: **295 occurrences / 290 distinct payloads**; require review before identity linking.
- No match on these cheap keys: **5,224 occurrences / 5,174 distinct payloads**. Some may match the missing PrepLadder cache material.
- Within Marrow: 5,938 occurrences but **5,881 distinct full payloads**; the 57 repeated occurrences should not duplicate payload text.

Existing schema already has ordered `qbank_source_occurrences`, `exam_year`, `exam_session`, `exam_tags`, and `canonical_questions` → `canonical_question_versions` for global identity with distinct platform content versions. The current PrepLadder importer is platform-specific and recognizes PYQ titles differently; using it unchanged would lose Marrow exam semantics. A later Marrow importer must map source type `PYQ`, platform `Marrow`, family/year (for example `exam_tags` = `['NEET-PG']`), source title/ID/path, position, and media. Keep exam metadata outside Topic/Subtopic/Concept. A 419-row common-question candidate may link two content versions to one canonical identity after validation; only a truly identical full payload would need an occurrence-only link. No such cross-platform full-payload match was confirmed here.

Raw Global Importance evidence can later count target exam/year, recency, repeated years/exams, and independent-platform recurrence. AIIMS remains historical; NEET-PG and INI-CET are target-exam signals. Do not calculate a score or combine these with personal weakness yet.

## Exactly 20-question dry smoke

Selected deterministically from this HTML: 19 subjects, AIIMS 9 / NEET-PG 5 / INI-CET 6; seven strong overlap candidates, seven stem-only candidates, six new/unverified; 19 with question images and 20 with explanation images. The audit re-parsed each source question and verified question ID, stem presence, all options/correct keys, explanation presence, media references, family/year, original source test/1-based order, normalized dedupe hashes, and JSON payload round-trip. **20/20 passed.** No learner state was read or written.

Smoke source IDs: `MD2323`, `MF5308`, `MD7870`, `MF5309`, `MF2263`, `MF0827`, `MA0630`, `MF1253`, `MA1541`, `MD4621`, `MD6620`, `MA1186`, `MF5272`, `MC4362`, `MG1028`, `MF5021`, `MB9227`, `MD0669`, `MD6794`, `MF5099`. Full local row audit: `/tmp/qbank-marrow-pyq-audit.json` (regenerable by `scripts/marrow_pyq_audit.py`).

## Storage projection and decision

The 5,938 canonicalized source payloads total **16,365,087 bytes uncompressed**; packing all 342 test payloads with deterministic gzip yields **4,532,805 bytes (4.32 MiB)** in object storage before dedupe/refinement. Unique Marrow full payloads total about **16.31 MB uncompressed**. Media-reference JSON is about **0.88 MB uncompressed**, already inside those payloads; extra mirrored image-object storage is **0 now** and cannot be estimated from URLs without fetching them. About 5,174 distinct payloads are unmatched in the available cache, 290 need stem-only review, and 417 have strong same-question/different-explanation evidence. Metadata/index overhead for 342 tests, 5,938 occurrences, and up to 5,881 versions is provisionally **a few MiB**; combined database/object growth is roughly **8–12 MiB**, excluding any future mirrored image bytes. Exact database growth needs a staged migration/import measurement.

**NO-GO for direct full ingestion with the existing PrepLadder importer.** GO for the next, separately authorized staged Marrow PYQ importer after preserving exam-family metadata and validating cross-platform identity/version rules. This audit made no production change.
