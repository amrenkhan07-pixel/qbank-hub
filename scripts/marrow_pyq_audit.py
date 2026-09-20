#!/usr/bin/env python3
"""Read-only audit and 20-row import smoke for a combined Marrow PYQ export."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Optional

from prepladder_import import canonical_payload, clean_text, correct_keys, extract_folder_tree, iter_source_tests, stable_json

TITLE = re.compile(r"\b(Aiims|Neet|Ini\s*Cet)\s+(20\d{2})\b", re.I)


def subject_name(value: str) -> str:
    key = re.sub(r"[^a-z]", "", value.casefold())
    if key == "obstetricsandgynecology":
        return "Obstetrics & Gynecology"
    if key == "anesthesia":
        return "Anaesthesia"
    return value.strip()


def exam_metadata(title: str) -> dict:
    match = TITLE.search(title)
    if not match:
        raise ValueError(f"unparsed exam/year title: {title}")
    token = re.sub(r"\s+", "", match.group(1).casefold())
    exam = {"aiims": "AIIMS", "neet": "NEET-PG", "inicet": "INI-CET"}[token]
    # Combined May/Nov titles do not identify an individual question's session.
    return {"exam": exam, "year": int(match.group(2)), "session": None, "raw_title": title}


def normalized(value: object) -> str:
    value = unicodedata.normalize("NFKC", html.unescape(clean_text(value))).casefold()
    return re.sub(r"\s+", " ", re.sub(r"[^\w]+", " ", value)).strip()


def match_key(payload: dict, include_explanation: bool = False) -> str:
    parts = [normalized(payload["question_html"]),
             [(x["key"], normalized(x["html"])) for x in payload["options"]],
             payload["correct_keys"]]
    if include_explanation:
        parts.append(normalized(payload["explanation_html"]))
    return hashlib.sha256(stable_json(parts).encode()).hexdigest()


def existing_index(cache: Path) -> dict:
    result = {"source_ids": set(), "strict": set(), "core": set(), "stem": set(), "pyq_questions": 0,
              "cache_files": 0, "questions": 0}
    for path in sorted(cache.glob("*.json")):
        data = json.loads(path.read_text())
        result["cache_files"] += 1
        title = str(data.get("source_test", {}).get("title") or "")
        is_pyq = "previous year questions" in title.casefold()
        for q in data.get("questions") or []:
            result["questions"] += 1
            if not is_pyq:
                continue
            result["pyq_questions"] += 1
            result["source_ids"].add(str(q.get("source_question_id") or ""))
            result["strict"].add(match_key(q, True))
            result["core"].add(match_key(q))
            result["stem"].add(normalized(q["question_html"]))
    return result


def audit(source: Path, cache: Optional[Path] = None) -> dict:
    tree = extract_folder_tree(source)
    declared = {str(t["id"]): t for folder in tree.get("folders") or [] for t in folder.get("tests") or []}
    prior = existing_index(cache) if cache else None
    subjects, years, exams, quality, options = defaultdict(Counter), defaultdict(Counter), defaultdict(Counter), Counter(), Counter()
    id_rows, core_rows, strict_rows = defaultdict(list), defaultdict(list), defaultdict(list)
    tests, rows, payload_bytes = [], [], 0
    for test in iter_source_tests(source):
        test_id, title = str(test.get("id") or ""), str(test.get("title") or "")
        subject = subject_name(str((test.get("path") or [""])[0]))
        meta = exam_metadata(title)
        qs = test.get("questions") or []
        if test_id not in declared or int(declared[test_id].get("num_questions") or 0) != len(qs):
            quality["tree_or_declared_count_mismatch"] += 1
        if not isinstance(qs, list):
            quality["malformed_test_questions"] += 1
            continue
        tests.append({"source_test_id": test_id, "title": title, "subject": subject, **meta, "questions": len(qs)})
        subjects[subject]["tests"] += 1
        exams[meta["exam"]]["tests"] += 1
        years[f'{meta["exam"]} {meta["year"]}']["tests"] += 1
        for position, q in enumerate(qs, 1):
            subjects[subject]["questions"] += 1
            exams[meta["exam"]]["questions"] += 1
            years[f'{meta["exam"]} {meta["year"]}']["questions"] += 1
            if not isinstance(q, dict):
                quality["malformed_question_objects"] += 1
                continue
            qid = str(q.get("id") or "")
            payload = canonical_payload(q)
            keys = correct_keys(q)
            nopt = len(q.get("options") or [])
            options[nopt] += 1
            if not qid:
                quality["missing_question_id"] += 1
            if not clean_text(q.get("raw_text") or q.get("text")):
                quality["missing_stem"] += 1
            if not nopt:
                quality["missing_options"] += 1
            if not keys:
                quality["missing_correct_answer"] += 1
            if not clean_text(q.get("explanation")):
                quality["missing_explanation"] += 1
            if nopt < 2 or nopt > 8:
                quality["unusual_option_count"] += 1
            if len(keys) > 1:
                quality["multi_correct"] += 1
            labels = [str(o.get("label") or "").upper() for o in q.get("options") or []]
            if len(labels) != len(set(labels)) or any(k not in labels for k in keys):
                quality["answer_or_option_key_conflict"] += 1
            if any(not clean_text(o.get("text")) for o in q.get("options") or []):
                quality["blank_option_text"] += 1
            for field in ("question_images", "explanation_images"):
                if q.get(field):
                    quality[f"with_{field}"] += 1
                    quality[f"{field}_references"] += len(q[field])
            for field in ("video", "audio"):
                if q.get(field):
                    quality[f"with_{field}"] += 1
            strict, core = match_key(payload, True), match_key(payload)
            id_rows[qid].append((test_id, position, strict))
            strict_rows[strict].append((qid, test_id, position))
            core_rows[core].append((qid, test_id, position))
            payload_bytes += len(stable_json(payload).encode())
            decision = "NEW_OR_UNVERIFIED"
            if prior:
                if strict in prior["strict"]:
                    decision = "EXACT_NORMALIZED_CONTENT_OVERLAP"
                elif core in prior["core"]:
                    decision = "SAME_STEM_OPTIONS_ANSWER"
                elif normalized(payload["question_html"]) in prior["stem"]:
                    decision = "STEM_ONLY_CANDIDATE"
                elif qid in prior["source_ids"]:
                    decision = "SOURCE_ID_ONLY_CANDIDATE"
            rows.append({"question_id": qid, "test_id": test_id, "position": position, "subject": subject,
                         **meta, "correct_keys": keys, "option_count": nopt,
                         "stem_ok": bool(clean_text(q.get("raw_text") or q.get("text"))),
                         "explanation_ok": bool(clean_text(q.get("explanation"))),
                         "question_images": len(q.get("question_images") or []),
                         "explanation_images": len(q.get("explanation_images") or []),
                         "video": bool(q.get("video")), "audio": bool(q.get("audio")),
                         "strict_key": strict, "core_key": core, "dedupe_decision": decision,
                         "payload_bytes": len(stable_json(payload).encode())})
    qid_dup = {k: v for k, v in id_rows.items() if len(v) > 1}
    strict_dup = {k: v for k, v in strict_rows.items() if len(v) > 1}
    diff_id = {k: v for k, v in strict_dup.items() if len({x[0] for x in v}) > 1}
    decisions = Counter(x["dedupe_decision"] for x in rows)
    return {"source": str(source), "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "total_tests": len(tests), "total_questions": len(rows), "total_subjects": len(subjects),
            "subjects": dict(sorted(subjects.items())), "exams": dict(sorted(exams.items())),
            "exam_years": dict(sorted(years.items())), "quality": dict(quality),
            "option_counts": dict(sorted(options.items())),
            "duplicate_question_id_groups": len(qid_dup), "duplicate_question_id_extra_occurrences": sum(len(v)-1 for v in qid_dup.values()),
            "duplicate_id_conflicting_content_groups": sum(len({x[2] for x in v}) > 1 for v in qid_dup.values()),
            "strict_content_duplicate_groups": len(strict_dup), "strict_content_duplicate_extra_occurrences": sum(len(v)-1 for v in strict_dup.values()),
            "identical_content_different_id_groups": len(diff_id),
            "core_content_duplicate_groups": sum(len(v)>1 for v in core_rows.values()),
            "dedupe_decisions": dict(decisions), "existing_cache": {k:v for k,v in prior.items() if not isinstance(v,set)} if prior else None,
            "raw_payload_bytes": payload_bytes, "tests": tests, "rows": rows}


def smoke(report: dict) -> list[dict]:
    """Fixed spread: all exams, many subjects, media, and overlap candidates."""
    rows = report["rows"]
    chosen, seen, subjects = [], set(), set()
    def rank(r: dict) -> tuple:
        return (-(r["question_images"] > 0), -(r["explanation_images"] > 0),
                r["test_id"], r["position"])
    def take(candidates: list[dict]) -> None:
        for r in sorted(candidates, key=rank):
            key = (r["test_id"], r["position"])
            if key not in seen:
                chosen.append(r); seen.add(key); subjects.add(r["subject"]); return
        raise ValueError("cannot fill 20-row smoke")
    categories = ("SAME_STEM_OPTIONS_ANSWER", "NEW_OR_UNVERIFIED", "STEM_ONLY_CANDIDATE")
    for index, exam in enumerate(("AIIMS", "NEET-PG", "INI-CET")):
        candidates = [r for r in rows if r["exam"] == exam and r["subject"] not in subjects]
        preferred = [r for r in candidates if r["dedupe_decision"] == categories[index]]
        take(preferred or candidates)
    for index, subject in enumerate(report["subjects"]):
        if subject not in subjects:
            candidates = [r for r in rows if r["subject"] == subject]
            preferred = [r for r in candidates if r["dedupe_decision"] == categories[index % 3]]
            take(preferred or candidates)
    take([r for r in rows if r["subject"] not in subjects or r["question_images"] or r["explanation_images"]])
    assert len(chosen) == 20
    return chosen


def verify_smoke(source: Path, selected: list[dict]) -> None:
    """Exercise the parse -> payload -> occurrence -> serialize path without writes."""
    targets = {(r["test_id"], r["position"]): r for r in selected}
    found = set()
    for test in iter_source_tests(source):
        test_id = str(test.get("id") or "")
        for position, question in enumerate(test.get("questions") or [], 1):
            key = (test_id, position)
            if key not in targets:
                continue
            expected = targets[key]
            assert str(question.get("id") or "") == expected["question_id"]
            payload = canonical_payload(question)
            roundtrip = json.loads(stable_json(payload))
            assert roundtrip == payload
            assert match_key(roundtrip, True) == expected["strict_key"]
            assert match_key(roundtrip) == expected["core_key"]
            assert roundtrip["correct_keys"] == expected["correct_keys"]
            assert len(roundtrip["options"]) == expected["option_count"]
            assert len([m for m in roundtrip["media"] if m["placement"] == "question"]) == expected["question_images"]
            assert len([m for m in roundtrip["media"] if m["placement"] == "explanation"]) == expected["explanation_images"]
            assert bool(roundtrip["video"]) == expected["video"]
            assert bool(roundtrip["audio"]) == expected["audio"]
            assert exam_metadata(str(test["title"]))["exam"] == expected["exam"]
            assert exam_metadata(str(test["title"]))["year"] == expected["year"]
            assert subject_name(str((test.get("path") or [""])[0])) == expected["subject"]
            found.add(key)
    assert found == set(targets)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--prepladder-cache", type=Path)
    parser.add_argument("--output", type=Path, default=Path("/tmp/qbank-marrow-pyq-audit.json"))
    args = parser.parse_args()
    report = audit(args.source, args.prepladder_cache)
    report["smoke"] = smoke(report)
    verify_smoke(args.source, report["smoke"])
    report["smoke_verified"] = len(report["smoke"])
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({k:v for k,v in report.items() if k not in ("rows", "tests", "subjects", "exam_years", "smoke")}, indent=2))
    print(f"smoke={len(report['smoke'])} output={args.output}")


if __name__ == "__main__":
    main()
