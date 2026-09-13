# Fast explanation-first classification

The old v2 classifier normalizes and scores every alias in a subject for every
question. It also flattens a large positive-explanation selection into one
evidence channel. This both dilutes the opening teaching point and makes runtime
grow with the complete vocabulary.

`fast_explanation_classifier.py` instead compiles an inverted alias index once.
A confident, non-broad Source-Test Topic is locked and cannot be changed by
question content; matching candidates are considered only beneath that Topic.
Broad, ambiguous, and unmapped Source Tests require strong explanation-plus-stem
evidence or remain unresolved. It ranks the first two substantive
explanation teaching points before the stem. The correct answer is weak evidence
for ordinary questions and is excluded for EXCEPT/NOT/negative stems.

The command is read-only. It writes a JSON report and a JSONL checkpoint under
`/tmp`, supports `--resume`, and queues only unresolved or suspicious negative
cases. It cannot update QBank data.

Benchmark the immutable 1,000-question cohort:

```sh
python3 scripts/fast_explanation_classifier.py
```

Prepare the remaining PrepLadder corpus without applying it:

```sh
python3 scripts/fast_explanation_classifier.py --full --resume
```

This full-corpus command must be run only after explicit approval. A separate,
reviewed persistence step is intentionally required after its dry-run report
passes safety gates.
