# Cerebellum full QBank import

The audited export contains 17,805 source occurrences across 19 subjects,263 folders and1,229 modules. Import SHA-256: `b80dc5c19f3443e9475a2565b40be11e247c0b1a0920d2831bf2c8cf6f7600c4`.

46 subject-scoped chunks retain whole modules and their original sequence/positions. Original question IDs and test IDs are retained in immutable payload source metadata; database uniqueness keys add build/position suffixes. No stem or semantic merging occurs. The 418 preexisting Cerebellum rows remain unchanged and are outside this import's totals.

Existing hybrid payload storage is reused: questions,question_topics,qbank_source_tests,qbank_source_occurrences,qbank_payload_objects andqbank_question_payloads. Every compressed object was downloaded and SHA-256 verified. Each chunk commits atomically through a service-role-only insert-only RPC. Replays check the manifest fingerprint and occurrence count. There are no canonical taxonomy, Global Importance or semantic-index writes.

Payload `source_original` exactly preserves the input question. Payload `media` records retain original URL,type,question/explanation placement,position,source field,status and audit warnings. Full question stems are present in the database; complete options/explanations/media remain in the established compressed payload format, ready for later indexing. Source-reference display labels were not synthesized.

2,802 question images,10,025 explanation images,2,495 video links and13 additional linked-media references are preserved. Twelve suspicious references,four sampled inaccessible references,six blank-option questions and66 possible missing-image cues are flagged. These flags overlap.74 questions are retained but `is_usable=false`;17,731 are practice eligible. All66 lexical image-cue candidates are conservatively held until source review; they are not asserted to be confirmed missing images. Unsampled external references remain unverified.

The Cerebellum-only renderer displays all images by section in array order and safe external video/media links. Essential question images must load before answer selection. Failures retain an original-source link and block scoring; no question is silently reduced to text. Media and warning metadata persist in session snapshots. Other platform rendering and timers retain their existing behavior. Folder metadata is paginated so full imports cannot disappear beyond the API row limit.

Validation: full database/payload comparison to the audited source,exact original-order and media-count reconciliation,unchanged fingerprints for protected existing data and importance/taxonomy tables,live resolver checks for11 subjects,isolated browser checks using actual payload fixtures and simulated learning writes,media unit tests,and existing timer/Recall tests. No real account was signed out or used for test attempts.
