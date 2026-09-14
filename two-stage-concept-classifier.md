# Two-stage tested-concept classifier

This experiment replaces taxonomy lookup with two deliberately separate steps.

1. Generate a concise medical entity from the stem and first substantive teaching paragraphs. Negative/EXCEPT questions, fragments, propositions, background entities, and answer–teaching conflicts stay blank.
2. Normalize exact lexical equivalents only within the same Subject. Near/overlapping labels are not auto-merged; they enter the local HTML review queue.

The classifier never reads or writes the existing Concept vocabulary. Benchmark mode is fixture-only and writes its report to `/tmp/qbank-two-stage-concept-benchmark-v1.json`. It has no production persistence path.

Run the benchmark:

```sh
python3 scripts/two_stage_concept_classifier.py --offline
```

Review ambiguous clusters (if any):

```sh
python3 scripts/two_stage_review_server.py --port 4176
```

Then open `http://127.0.0.1:4176`.

## Why the earlier approaches failed

- Source-Test mapping treated broad publishing containers as if they were tested concepts.
- Canonical alias matching reused a contaminated vocabulary containing Topic/Subtopic labels and unsafe aliases.
- Free phrase extraction captured grammatical fragments, treatments, background facts, and negative-answer inversions.
- Hybrid voting did not repair bad candidates: multiple correlated text channels could agree on the same wrong or overly broad label.

## Gate

The frozen 127-question clinician-reviewed benchmark must reach at least 90% precision among nonblank labels and avoid every known regression. Blanks are allowed. Passing this gate means the approach is eligible for a separate read-only full-corpus dry run; it does not authorize production persistence.
