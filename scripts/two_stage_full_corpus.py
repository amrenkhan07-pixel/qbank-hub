#!/usr/bin/env python3
"""Read-only full-corpus runner and deterministic QA sampler.

This module deliberately imports the accepted classifier unchanged. It reads
PrepLadder rows through the existing REST helpers and writes JSON artifacts only
under /tmp; there is no database mutation code path.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from scripts import canonical_batch_classifier as legacy
from scripts import fast_explanation_classifier as fast
from scripts.hybrid_consensus_classifier import MEDICAL_QA_INCORRECT, REGRESSION_IDS
from scripts.two_stage_concept_classifier import VERSION, first_stage, label_key, second_stage

REPORT = Path("/tmp/qbank-two-stage-full-corpus-v1.json")
QA = Path("/tmp/qbank-two-stage-qa-150.json")
REVIEW = Path("/tmp/qbank-two-stage-review-v1.json")


def compact_record(item: dict) -> dict:
    return {
        "content_id": item["question_id"],
        "concept_ref": item.get("cluster_id"),
        "classifier": VERSION,
        "confidence": item["confidence"],
        "provenance": "stem+teaching_excerpt",
        "review_state": "pending" if item.get("review_reasons") else "unreviewed",
    }


def qa_sample(results: list[dict], clusters: list[dict], size: int = 150) -> list[dict]:
    """Deterministic coverage of required QA strata, then subject-balanced fill."""
    labeled = [x for x in results if x["generated_label"]]
    selected: dict[str, dict] = {}

    def take(rows, count, salt):
        ordered = sorted(rows, key=lambda x: hashlib.sha256(
            f"{salt}|{x['question_id']}".encode()).hexdigest())
        for row in ordered:
            if len([x for x in selected.values() if salt in x["qa_strata"]]) >= count:
                break
            copy = selected.setdefault(row["question_id"], {**row, "qa_strata": []})
            if salt not in copy["qa_strata"]:
                copy["qa_strata"].append(salt)

    take([x for x in labeled if x["negative"]], 15, "negative")
    take([x for x in labeled if x.get("is_pyq") or "pyq" in x["source_test"].lower()
          or any(w in x["source_test"].lower() for w in ("grand test", "integrated", "revision"))], 30, "broad_pyq")
    take([x for x in labeled if x["question_id"] in REGRESSION_IDS
          or x["question_id"] in MEDICAL_QA_INCORRECT], 20, "historical_failure")
    repeated_ids = {qid for c in clusters if c["member_count"] > 1 for qid in c["question_ids"]}
    take([x for x in labeled if x["question_id"] in repeated_ids], 35, "repeated_cluster")
    take(labeled, 50, "random")

    by_subject = defaultdict(list)
    for row in labeled:
        by_subject[row["subject"]].append(row)
    for subject in sorted(by_subject):
        if not any(x["subject"] == subject for x in selected.values()):
            take(by_subject[subject], 1, f"subject:{subject}")
    ordered = sorted(labeled, key=lambda x: hashlib.sha256(
        f"fill|{x['question_id']}".encode()).hexdigest())
    for row in ordered:
        if len(selected) >= size:
            break
        selected.setdefault(row["question_id"], {**row, "qa_strata": ["balanced_fill"]})
    return list(selected.values())[:size]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, default=REPORT)
    parser.add_argument("--qa", type=Path, default=QA)
    parser.add_argument("--review", type=Path, default=REVIEW)
    args = parser.parse_args()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        raise SystemExit("SUPABASE_SERVICE_ROLE_KEY is required")
    before = json.loads(Path("/tmp/qbank-canonical-batch-1000.json").read_text())
    metadata, _ = fast.load_rows(key, True, before)
    hydrated, payload_objects = legacy.hydrate(key, metadata)
    started = time.perf_counter()
    results = []
    metadata_by_id = {x["question_id"]: x for x in metadata}
    for row in hydrated:
        item = first_stage(row)
        source = metadata_by_id[row["question_id"]]
        item["is_pyq"] = bool(source.get("is_pyq"))
        results.append(item)
    clusters, ambiguous = second_stage(results)
    elapsed = time.perf_counter() - started
    suspicious = []
    for item in results:
        reasons = []
        if not item["generated_label"]:
            continue
        if item["confidence"] < .92:
            reasons.append("low_confidence_nonblank")
        if item["negative"]:
            reasons.append("negative_nonblank")
        if item["question_id"] in MEDICAL_QA_INCORRECT:
            reasons.append("historical_failure_pattern")
        if reasons:
            item["review_reasons"] = reasons
            suspicious.append(item)
    review = {"version": VERSION, "ambiguous_clusters": ambiguous,
              "suspicious_assignments": suspicious,
              "total": len(ambiguous) + len(suspicious)}
    args.review.write_text(json.dumps(review, indent=2))
    sample = qa_sample(results, clusters)
    args.qa.write_text(json.dumps({"version": VERSION, "sample_size": len(sample),
                                   "items": sample}, indent=2))
    labeled = [x for x in results if x["generated_label"]]
    negatives = [x for x in results if x["negative"]]
    compact = [compact_record(x) for x in labeled]
    compact_bytes = sum(len(json.dumps(x, separators=(",", ":")).encode()) for x in compact)
    summary = {
        "processed": len(results), "nonblank": len(labeled),
        "coverage_percent": round(100 * len(labeled) / len(results), 2),
        "blank": len(results) - len(labeled), "unique_clusters": len(clusters),
        "ambiguous_clusters": len(ambiguous), "review_queue": review["total"],
        "negative_questions": len(negatives),
        "negative_assigned": sum(bool(x["generated_label"]) for x in negatives),
        "negative_blank": sum(not x["generated_label"] for x in negatives),
        "classification_seconds": round(elapsed, 4),
        "classification_questions_per_second": round(len(results) / elapsed, 1),
        "payload_objects_read": payload_objects,
        "qa_sample_size": len(sample),
        "compact_bytes": compact_bytes,
        "compact_bytes_per_nonblank": round(compact_bytes / len(compact), 1) if compact else 0,
    }
    report = {"version": VERSION, "read_only": True, "production_writes": 0,
              "summary": summary, "clusters": clusters, "results": results}
    args.report.write_text(json.dumps(report, indent=2))
    print(json.dumps(summary, indent=2))
    print(f"Report: {args.report}\nQA: {args.qa}\nReview: {args.review}\nNo database rows were changed.")


if __name__ == "__main__":
    main()
