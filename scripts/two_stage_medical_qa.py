#!/usr/bin/env python3
"""Frozen medical adjudication and review-queue builder for the 150-item sample."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

FULL = Path("/tmp/qbank-two-stage-full-corpus-v1.json")
SAMPLE = Path("/tmp/qbank-two-stage-qa-150.json")
OUTPUT = Path("/tmp/qbank-two-stage-medical-qa-v1.json")
REVIEW = Path("/tmp/qbank-two-stage-review-v1.json")

# Adjudicated against one question only: “Does this label accurately represent
# the central medical concept being tested?”
INCORRECT = {
    "eb6e4e9d-7d25-5d63-b14a-76b85ad82a77": "explanation heading fragment",
    "57c7b8e1-5105-5338-b9c8-b3829b1229ea": "background therapy; question tests neostigmine with atropine",
    "2ce3d9ca-6370-50a5-bd7d-79cf4e99bd38": "background organism; question tests gamma-phage lysis",
    "8d5a1836-9a35-5223-bfce-c5435f64c1f6": "underspecified treatment label",
    "02e0e077-a1ca-5662-963a-5391cc096834": "background anatomy from a matching question",
    "58ae310a-724e-5090-a75f-ce04968985d4": "score-table sentence fragment",
    "360889ae-59b2-5e5c-b85f-15b7723eff32": "pronoun fragment",
    "ab89aa2d-2667-5879-b3ad-d10a34ec0989": "grammatical fragment",
    "fbda9243-633b-57f1-8db0-98cb7fab158d": "pronoun fragment",
    "1831d1eb-d48d-53f1-b2f8-7b3e9d935406": "background disease; question tests prognostic factor",
    "941f96a9-e685-59c5-bc8b-0e696b313cf3": "truncated disease name",
    "805e246f-fde5-59b9-803b-32189e8eb17f": "treatment sentence fragment",
    "decd8568-49bf-5ea1-8927-cbddd0608bad": "management sentence fragment",
    "76afb7d2-c96b-58c0-9d9e-8cfcd2c24da6": "mechanism instead of tested ulcer type",
    "1833b8ce-e20d-5e6b-96d5-bfc0433ace99": "background disease phase; question tests blue mantle sign",
    "f1f1b218-6072-50cb-9cae-416f9edbe8d7": "background diagnosis; question tests organism",
    "a299ee46-6f73-5499-a040-652631313ed6": "confirmation sentence fragment",
    "0bbf654b-90ec-5864-86d1-e0ce69921900": "background vaccine sentence fragment",
    "4edc6728-62c2-56c0-8e0f-ee52e17cf5e6": "disease scaffold; question tests enzyme deficiency",
    "467d7f91-5734-5d65-b188-037d17e8e5f5": "adverb fragment",
    "faae65ef-6912-56fd-bf09-20c0a524dcaf": "incomplete combination therapy",
    "76a65a87-395b-5a38-a6b5-91bbdd608ecc": "uncertainty fragment",
    "569d21d3-c4d9-51f3-9bd8-0ff168880186": "treatment prompt fragment",
    "fcbf1cf2-6420-58de-8b3a-398e439c76a7": "drops hepatitis E from the tested combined answer",
    "d2dc20eb-bca2-5de2-b226-49c5017b33c2": "background diagnosis; question tests culture medium",
    "4c213e21-e2c9-5077-a5b8-afcf7be6b80b": "drops one of two tested image diagnoses",
    "abc9bb46-793b-5d58-b4be-cfc662a20024": "manifestation instead of tested drug class",
    "dde3a810-11a5-50a4-b452-4eac1e150ad7": "test-description fragment instead of Durkan test",
}

SUSPICIOUS = re.compile(
    r"\b(?:this|consistent|associated|uncertain|inadequately|considered confirmed|"
    r"another vaccine|most appropriate|most reliable|diagnosis differential|"
    r"certain score|suggestive of|characteristic of|since)\b", re.I)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", type=Path, default=FULL)
    parser.add_argument("--sample", type=Path, default=SAMPLE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--review", type=Path, default=REVIEW)
    args = parser.parse_args()
    full = json.loads(args.full.read_text())
    sample = json.loads(args.sample.read_text())["items"]
    adjudicated = [{"question_id": x["question_id"], "correct": x["question_id"] not in INCORRECT,
                    "reason": INCORRECT.get(x["question_id"]), "label": x["generated_label"],
                    "subject": x["subject"], "qa_strata": x["qa_strata"]} for x in sample]

    repeated = [c for c in full["clusters"] if c["member_count"] > 1]
    cluster_sample = sorted(repeated, key=lambda c: hashlib.sha256(
        f"merge|{c['cluster_id']}".encode()).hexdigest())[:30]
    bad_cluster_labels = {"associated", "consistent", "this"}
    cluster_qa = []
    for cluster in cluster_sample:
        safe = cluster["normalized_label"].lower() not in bad_cluster_labels
        cluster_qa.append({"cluster_id": cluster["cluster_id"], "subject": cluster["subject"],
                           "label": cluster["normalized_label"], "member_count": cluster["member_count"],
                           "equivalent_merge": safe,
                           "reason": None if safe else "generic fragment merges medically distinct questions"})

    prior_review = json.loads(args.review.read_text())
    seen = set()
    suspicious = []
    for item in full["results"]:
        label = item.get("generated_label") or ""
        reasons = []
        if not label:
            continue
        if item["question_id"] in INCORRECT:
            reasons.append("medical_qa_failure")
        if SUSPICIOUS.search(label) or len(set(label.lower().split())) < len(label.split()):
            reasons.append("suspicious_label_shape")
        if item.get("negative"):
            reasons.append("negative_nonblank")
        if reasons and item["question_id"] not in seen:
            seen.add(item["question_id"]); suspicious.append({**item, "review_reasons": reasons})
    review = {"version": full["version"], "ambiguous_clusters": prior_review["ambiguous_clusters"],
              "suspicious_assignments": suspicious,
              "total": len(prior_review["ambiguous_clusters"]) + len(suspicious)}
    args.review.write_text(json.dumps(review, indent=2))

    correct = sum(x["correct"] for x in adjudicated)
    merge_correct = sum(x["equivalent_merge"] for x in cluster_qa)
    negative = [x for x in sample if x["negative"]]
    report = {"sample_size": len(sample), "correct": correct, "incorrect": len(sample)-correct,
              "precision_percent": round(100*correct/len(sample), 2),
              "negative_nonblank_sample_size": len(negative),
              "negative_precision_percent": None,
              "negative_note": "No negative/EXCEPT question received a label in the corpus.",
              "cluster_sample_size": len(cluster_qa), "cluster_correct": merge_correct,
              "cluster_merge_precision_percent": round(100*merge_correct/len(cluster_qa), 2),
              "systematic_errors": ["grammatical/incomplete fragments", "background facts or diseases",
                                    "answer specificity lost in multi-part and management questions",
                                    "generic fragments collapsing medically distinct questions"],
              "adjudications": adjudicated, "cluster_adjudications": cluster_qa}
    args.output.write_text(json.dumps(report, indent=2))
    print(json.dumps({k:v for k,v in report.items() if k not in {"adjudications","cluster_adjudications"}}, indent=2))
    print(f"Review queue: {review['total']}\nNo database rows were changed.")


if __name__ == "__main__":
    main()
