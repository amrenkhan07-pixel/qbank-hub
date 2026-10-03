# Original media repair — 3 October 2026

## Read-only audit, before implementation

The audited production baseline was `4b42544`. Source → parser → payload/database → hydration → active question and explanation → session resume → GT viewers were inspected before any production change. Production SQL calls were SELECTs only. Original HTML files remained read-only.

PrepLadder (`PREP_q_banks.html`), Marrow (`marrow_Previous_Year_Question_Papers.html`) and Core BTR (`COREBTR_Questions_BANKS.html`) embed question JSON with **HTTPS references in ordered `question_images` / `explanation_images` arrays**. Their compact size does not mean the binary pictures are embedded. No base64/data URLs, blob references, relative image paths, inline img/srcset/lazy/picture/background image markup was found in the question/option/explanation fields of those three exports. Marrow contains five query-bearing links; these were not assumed to be signed links. The shared importer preserves HTML and the separate media arrays. Marrow and Core BTR reuse PrepLadder's `canonical_payload` function. No source reclassification is needed.

The exact example occurs in Marrow Microbiology `MF5127` and `MF5170`. Their source payload SHA-256 values match the live database's `content_sha256` values. Four representative PrepLadder payload hashes also matched. The retained source therefore already contains the correct media for those existing IDs.

### Root causes

1. `hydrateHybridQuestions` already reconstructs both image arrays, but the ordinary question renderer used only `image_url` (the first stem image), and `explanationBlock` ignored `explanation_images` completely.
2. Older relational Cerebellum records also contain arrays that the normal renderer ignored.
3. `test_session_questions.question_snapshot` usually omitted the arrays: only 100 of 2,043 snapshots contained media-array keys. No snapshot contained base64 image data. An explanation could therefore remain broken after resume even if the live question renderer were fixed.
4. GT had separate image rendering and text-decoding paths. This change retains GT's entity decoding while routing its question, option and explanation content through the same safe renderer.
5. External availability is a separate problem. A sampled Core BTR URL returned HTTP 403; its bytes are not embedded in the HTML. Rendering cannot recover an inaccessible asset.

### Order limitation

The retained HTML export itself appends its separate image arrays after the stem/explanation. Empty paragraphs are not reliable image anchors. These arrays preserve image order but do not encode the former paragraph positions. The implementation preserves the order actually available in the source and does not invent positions. Real inline paragraph/image/paragraph markup is sanitized in place and remains interleaved, including for future imports.

## Inventory and storage decision

| Source | Unique question payloads | Questions with image references | Image references | Distinct URL strings |
| --- | ---: | ---: | ---: | ---: |
| PrepLadder | 22,844 | 9,569 | 19,286 | 18,355 |
| Marrow PYQ | 5,914 | 2,719 | 5,113 | 4,805 |
| Core BTR QBank | 14,066 | 3,702 | 4,300 | 2,442 |
| Cerebellum, live relational records | 418 | 188 | 244 | 242 |

Normal QBank total: **43,242 questions, 16,178 with image references**. The three large source exports contain **28,699 references / 25,602 distinct URL strings / 3,097 repeated references**. Cerebellum contributes 244 references / 242 URL strings. URL counts are not a claim of unique binary content: all remote assets were not downloaded or byte-hashed. GT is audited separately in `media-audit-results.json` and is not added to the QBank question total.

Existing database size: **172,887,187 bytes**. Questions relation: 40,927,232 bytes; payload-reference relation: 22,495,232 bytes; session-snapshot relation: 4,980,736 bytes (including indexes/TOAST as reported by PostgreSQL). The existing private `qbank-payloads` bucket has **1,545 objects / 34,602,948 stored bytes**, representing 165,671,025 uncompressed payload bytes. It holds compressed reference-bearing content, not mirrored copies of those image assets.

| Alternative | Additional Postgres storage | Additional binary-object storage | Decision |
| --- | --- | --- | --- |
| Reuse retained public, non-signed references; shared renderer | **0** | **0** | Chosen |
| Copy media arrays into every existing snapshot | Repeated reference JSON across 2,043 rows; unnecessary | 0 | Avoided; recover current question on demand |
| Mirror all images and hash-deduplicate them | Asset/reference index overhead | Potentially gigabytes, not measured | Not justified by the rendering defect |
| Embed base64 in questions/snapshots | Potentially gigabytes with repeated copies | 0 | Rejected |

Accessible sample images ranged from roughly 48 KB to 356 KB. Extrapolating this small, non-random sample to 25,602 URLs would give roughly 1.2–9.1 GB, **not a reliable full-mirror estimate**. No full mirror or bulk image download was performed. Asset hashing was used only for the initial access/size probes. Hash deduplication storage is unnecessary when zero assets are copied. The same URL is reused across questions, and inline/array duplication within a placement is suppressed.

## Architecture and existing records

`app/media-content.js` is the common safe renderer. It consumes the existing HTML and lightweight references, displays every stem/explanation image, supports image objects, lazy src/data-src/srcset/picture and explicit background-image positions, and never copies arbitrary styles or event handlers. It excludes scripts, iframes, embedded objects, SVG and unsafe URLs. Raster data images can render in memory, but none were found in these imports; this repair creates no base64 snapshots or image rows. Newly introduced embedded-image source formats would require a separate extraction-to-hashed-assets ingestion step before importing them and are not claimed as verified here.

Static public source URLs are reused. Expiring/authenticated third-party URL patterns, unresolved relative URLs and blob URLs are rejected rather than silently mapped to the app's origin. App-owned signed `question-media` URLs remain supported because the existing loader renews their first-party storage references. Third-party hosts remain outside the app's control; a source failure displays an explicit unavailable indicator.

Question images load lazily at the displayed question. QBank explanations add image elements only when opened. English/Hindi audio references use controls with `preload="none"`; video URLs are safe external links, not arbitrary embedded iframes. List/search queries do not fetch image binaries.

Existing saved sessions recover omitted arrays **for the visible question only**, from its unchanged question ID and existing payload. Recovery is read-only, guarded against duplicate requests, retryable, and ignored if the user leaves the view. Repeated visits to an already recovered question reuse its in-memory references. Existing payload caching remains in use. No historical snapshot is rewritten, and no media schema is required.

**Database backfill: 0 rows. Asset uploads: 0. Schema changes: none.** Future imports from these established source formats already create the required ordered references automatically through the shared importer; the ingestion contract test verifies this and verifies existing content hashes. Consequently the importer and its question-identity hashing were not changed.

## Verification

- Nine real retained source samples: both exact Microbiology cases, PrepLadder stem image, explanation image, multiple images, true no-media question, audio-only question, and two distinct Marrow questions sharing an image URL.
- 27 Practice/Recall/review content checks; unchanged original text and image order.
- 32 successful real-image decodes across desktop and 390px mobile; aspect-ratio/overflow checks; screenshot of the exact Microbiology explanation.
- Completed GT viewer exercised with source-format content and read-only answer controls.
- Existing snapshot arrays removed in the fixture, then recovered using SELECTs for one question only.
- No explanation image elements while collapsed; audio preload disabled.
- Inline order, inline/array duplicate suppression, lazy attributes, picture/srcset, background references, script/handler/iframe rejection, failed-image notice.
- Existing targeted Recall tests passed, including instant answer feedback, timer settings, bookmarks, marking, attempts, save retries and exit during navigation.
- Python ingestion contract: live content hashes unchanged; future reference-bearing HTML and array order preserved.

Production DB writes during audit/testing: **none**. Question IDs, platforms, source tests/order, occurrences, concept/family assignments, attempts, bookmarks, Recall schedules/history and Global Importance data were not altered. GT timing/scoring logic was not changed.

Known unrecovered sample: `assets.corebtr.com/question_explanation/7ba8f50d-6549-459c-bed6-0734512e3ad5.jpg` returned **403 Forbidden** without credentials. No access-control bypass was attempted. Other asset availability is not inferred from that one result; the full URL population was not probed. Lost pre-export paragraph anchors cannot be recovered from separate URL arrays.

Local source samples and screenshots remain outside the committed code. `test-question-media.cjs` accepts the audit sample JSON path; `test-media-import-contract.py` accepts the same path. Run browser tests with Playwright (`PLAYWRIGHT_PATH`) and an optional Chrome executable (`CHROME_PATH`).
