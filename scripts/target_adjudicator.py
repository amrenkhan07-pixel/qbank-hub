#!/usr/bin/env python3
"""Question-target adjudication for existing nonblank Concept candidates only.

The accepted first-stage extractor is intentionally not imported or modified.
Input rows must already contain a nonblank generated_label plus stem/teaching.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from collections import Counter, defaultdict
from pathlib import Path

VERSION = "question-target-adjudicator-v1"
INPUT = Path("/tmp/qbank-two-stage-qa-150.json")
OUTPUT = Path("/tmp/qbank-target-adjudicator-benchmark-v1.json")

GENERIC = {
    "associated", "characterized", "classic", "consistent", "diagnosis",
    "seen", "this", "treatment", "uncertain", "inadequately",
}
BAD_START = re.compile(
    r"^(?:this|associated|consistent|classic|seen|characteri[sz]ed|treatment|"
    r"diagnosis|uncertain|inadequately|considered|another|most appropriately)\b", re.I)
ANSWER_LINE = re.compile(
    r"^\s*Correct\s+(?:answer|option)\s*:?\s*(?:[A-D]\s*[).:-]?\s*)?(.+?)(?=\s+Correct\s+(?:Answer|Option)|$)",
    re.I | re.S,
)
SECOND_ANSWER = re.compile(
    r"Correct\s+(?:Answer|Option)\s*:?\s*(?:[A-D]\s*[).:-]?\s*)?(.+?)(?=(?:\.|\n)\s+[A-Z]|$)",
    re.I | re.S,
)


def normalize_label(value: str | None) -> str | None:
    if not value:
        return None
    value = re.sub(r"\s+", " ", value).strip(" .,:;-_")
    value = re.sub(r"^(?:a|an|the)\s+", "", value, flags=re.I)
    value = value.replace("’", "'")
    words = value.split()
    if not 1 <= len(words) <= 10 or len(value) < 3:
        return None
    low_words = set(re.findall(r"[a-z]+", value.lower()))
    if not low_words or low_words <= GENERIC or BAD_START.search(value):
        return None
    if re.fullmatch(r"(?:[A-D0-9,.+\-/ ]|and|or)+", value, re.I):
        return None
    if words[-1].lower() in {"a", "an", "and", "by", "for", "of", "the", "with"}:
        return None
    return value.lower()


def extract_correct_answer(teaching: str) -> str | None:
    text = (teaching or "").strip()
    match = ANSWER_LINE.search(text) or SECOND_ANSWER.search(text)
    if not match:
        return None
    answer = match.group(1).strip()
    # The first line is sometimes followed immediately by prose when punctuation
    # is missing. Prefer the compact answer before common explanation openings.
    answer = re.split(
        r"\s+(?:The patient|The clinical|The image|This patient|Based on|Explanation:|"
        r"is the correct|is characterized|typically|occurs due|refers to)\b",
        answer, maxsplit=1, flags=re.I)[0]
    return normalize_label(answer)


def same_label(left: str | None, right: str | None) -> bool:
    def key(value):
        return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip() if value else ""
    a, b = key(left), key(right)
    return bool(a and b and (a == b or a in b or b in a))


def adjudicate(item: dict) -> dict:
    candidate = normalize_label(item.get("generated_label"))
    answer = extract_correct_answer(item.get("teaching", ""))
    negative = bool(item.get("negative")) or bool(re.search(
        r"\b(?:except|not|incorrect|false)\b", item.get("stem", ""), re.I))
    if negative:
        action, final, reason, confidence = "BLANK", None, "negative_or_except", 0.0
    elif not answer:
        action, final, reason, confidence = "BLANK", None, "no_precise_answer_target", 0.0
    elif same_label(candidate, answer):
        action, final, reason, confidence = "CONFIRM", answer, "candidate_matches_answer_target", .98
    else:
        action, final, reason, confidence = "REPLACE", answer, "answer_is_question_target", .96
    return {
        **item, "adjudicator_version": VERSION, "original_candidate": item.get("generated_label"),
        "parsed_correct_answer": answer, "action": action, "final_label": final,
        "adjudication_reason": reason, "final_confidence": confidence,
    }


def cluster(items: list[dict]) -> tuple[list[dict], list[dict]]:
    groups = defaultdict(list)
    for item in items:
        if item["final_label"]:
            key = re.sub(r"[^a-z0-9]+", " ", item["final_label"]).strip()
            groups[(item["subject"], key)].append(item)
    clusters = []
    for (subject, key), members in sorted(groups.items()):
        cid = hashlib.sha256(f"{subject}|{key}".encode()).hexdigest()[:16]
        clusters.append({"cluster_id": cid, "subject": subject, "normalized_label": key,
                         "member_count": len(members),
                         "question_ids": [x["question_id"] for x in members]})
        for item in members:
            item["final_cluster_id"] = cid
    ambiguous = []
    by_subject = defaultdict(list)
    for c in clusters: by_subject[c["subject"]].append(c)
    for subject, rows in by_subject.items():
        for i, left in enumerate(rows):
            for right in rows[i+1:]:
                a, b = left["normalized_label"], right["normalized_label"]
                if a != b and (f" {a} " in f" {b} " or f" {b} " in f" {a} "):
                    ambiguous.append({"subject": subject, "left": left, "right": right,
                                      "reason": "overlapping_post_adjudication_labels"})
    return clusters, ambiguous


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=INPUT)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    source = json.loads(args.input.read_text())
    rows = source.get("items", source.get("results", []))
    if any(not x.get("generated_label") for x in rows):
        raise SystemExit("Target adjudicator accepts nonblank candidates only")
    started = time.perf_counter()
    results = [adjudicate(x) for x in rows]
    clusters, ambiguous = cluster(results)
    elapsed = time.perf_counter() - started
    actions = Counter(x["action"] for x in results)
    summary = {"processed": len(results), "confirmed": actions["CONFIRM"],
               "replaced": actions["REPLACE"], "blanked": actions["BLANK"],
               "final_nonblank": actions["CONFIRM"] + actions["REPLACE"],
               "retained_percent": round(100*(actions["CONFIRM"]+actions["REPLACE"])/len(results), 2),
               "clusters": len(clusters), "ambiguous_clusters": len(ambiguous),
               "seconds": round(elapsed, 4),
               "questions_per_second": round(len(results)/elapsed, 1)}
    report = {"version": VERSION, "read_only": True, "summary": summary,
              "clusters": clusters, "ambiguous_clusters": ambiguous, "results": results}
    args.output.write_text(json.dumps(report, indent=2))
    print(json.dumps(summary, indent=2)); print(args.output)


if __name__ == "__main__":
    main()
