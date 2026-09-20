#!/usr/bin/env python3
"""Build and run a read-only, model-reasoned tested-concept benchmark.

The runner intentionally keeps independent medical gold labels separate from
model output. It never reads or writes Supabase and cannot run a full corpus.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import time
import urllib.request
from pathlib import Path
from typing import Optional

from prepladder_import import PLATFORM, deterministic_uuid, sha256_bytes, stable_json

FIXTURE = Path("/tmp/qbank-fast-fixture.json")
FULL_EVIDENCE = Path("/tmp/qbank-two-stage-full-corpus-v1.json")
PAYLOAD_CACHE = Path("/tmp/qbank-canonical-batch-payload-cache")
BENCHMARK = Path("/tmp/qbank-reasoning-concept-benchmark-76.json")
OUTPUT = Path("/tmp/qbank-reasoning-concept-output.jsonl")
REPORT = Path("/tmp/qbank-reasoning-concept-report.json")
SCHEMA_VERSION = "tested-concept-reasoning-v1"
KNOWN_REGRESSION_IDS = frozenset({
    "4c25a524-1d0f-50b5-93cf-e8b4c39c1839", "c976304f-542f-558e-b8d5-def598c0ee0c",
    "0ad6da3f-79ae-5846-99ae-ace7dea13e1d", "99715fde-e802-5fbf-b9e5-2d9524ee2542",
    "742d05f3-85a8-5509-8660-aa9cdaa795ad", "086a8deb-69b3-5349-a006-9f9fbf1a77a8",
    "c6eccc99-7cad-5a8a-ad8f-630c86effdf8", "f9adfc14-4824-5a3b-bb3a-64525e184c56",
    "8eed4b71-5679-553e-8093-98b3944d1e53", "016d29d6-2a27-5e81-a7d7-b27a3f1ce0b0",
    "6196af7c-40fa-5370-b3b4-10a72d498be1", "185c16f2-8c09-52d9-9058-08d5820be8f9",
})

OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "subject": {"type": "string"},
        "primary_tested_concept": {"type": ["string", "null"]},
        "broader_concept": {"type": ["string", "null"]},
        "confidence": {"type": "string", "enum": ["HIGH", "MEDIUM", "LOW"]},
        "evidence_basis": {
            "type": "string",
            "enum": ["STEM", "EXPLANATION", "ANSWER", "COMBINATION"],
        },
        "negative_question": {"type": "boolean"},
        "needs_review": {"type": "boolean"},
    },
    "required": [
        "subject", "primary_tested_concept", "broader_concept", "confidence",
        "evidence_basis", "negative_question", "needs_review",
    ],
}

SYSTEM_PROMPT = """You are classifying the exact medical concept or skill tested by one exam question.
First reason from the question itself; do not search or force any existing taxonomy label.
Distinguish disease from its diagnostic test/sign, staging/grading/prognostic factor, mechanism,
adverse effect, indication, organism-identification method, or management step. Use the deepest
defensible concept. For NOT/EXCEPT/false/incorrect questions, never make the incorrect answer the
concept. If the primary target is unclear, return null primary and the safest broader concept.
Keep labels concise noun phrases, medically equivalent across learning platforms, and free of
source names, answer scaffolds, and explanatory prose."""


def normalize_question(row: dict) -> dict:
    return {
        "question_id": row["question_id"],
        "subject": row["subject"],
        "source_test": row.get("source_title", ""),
        "stem": row.get("stem_text", ""),
        "options": row.get("all_options_text", ""),
        "correct_answer": row.get("correct_answer_text", ""),
        "explanation": row.get("positive_explanation_text", ""),
        "negative_question": row.get("polarity") == "negative",
        "is_pyq": bool(row.get("is_pyq")),
        "has_media": bool(row.get("has_media")),
        "gold": {"status": "PENDING_INDEPENDENT_MEDICAL_REVIEW", "primary": None, "broader": None},
    }


def plain(value) -> str:
    from html import unescape
    text = re.sub(r"<script\b[^>]*>[\s\S]*?</script>", " ", str(value or ""), flags=re.I)
    text = re.sub(r"<style\b[^>]*>[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<br\s*/?>|</(?:p|li|div|h[1-6]|tr)>", "\n", text, flags=re.I)
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", text))).strip()


def evidence_key(subject: str, source: str, stem: str) -> str:
    return "|".join((evidence_clean(subject), evidence_clean(source), evidence_clean(stem)))


def evidence_clean(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", plain(value).lower()).strip()


def first_substantive_explanation(value: str) -> str:
    parts = [x.strip() for x in re.split(r"(?<=[.!?])\s+", plain(value)) if len(x.strip()) >= 20]
    return " ".join(parts[:3])[:2400]


def load_offline_full() -> list[dict]:
    """Reconstruct evidence from existing local artifacts; never contacts Supabase."""
    prior = json.loads(FULL_EVIDENCE.read_text())["results"]
    prior_by_id = {x["question_id"]: x for x in prior}
    metadata = {evidence_key(x["subject"], x["source_test"], x["stem"]): x for x in prior}
    by_subject_stem = {}
    by_subject_prefix = {}
    for row in prior:
        by_subject_stem.setdefault((evidence_clean(row["subject"]), evidence_clean(row["stem"])), []).append(row)
        by_subject_prefix.setdefault((evidence_clean(row["subject"]), evidence_clean(row["stem"])[:120]), []).append(row)
    items = {}
    for filename in sorted(glob.glob(str(PAYLOAD_CACHE / "*.json"))):
        payload = json.loads(Path(filename).read_text())
        source = payload.get("source_test") or {}
        source_title = source.get("title", "") if isinstance(source, dict) else str(source)
        subject = payload.get("subject", "")
        for question in payload.get("questions", []):
            stem = plain(question.get("question_html"))
            content_hash = sha256_bytes(stable_json(question).encode("utf-8"))
            question_id = deterministic_uuid("question", f"{PLATFORM}|{subject}|{content_hash}")
            row = prior_by_id.get(question_id)
            key = evidence_key(subject, source_title, stem)
            if not row:
                row = metadata.get(key)
            if not row:
                candidates = by_subject_stem.get((evidence_clean(subject), evidence_clean(stem)), [])
                if len(candidates) == 1:
                    row = candidates[0]
            if not row:
                candidates = by_subject_prefix.get((evidence_clean(subject), evidence_clean(stem)[:120]), [])
                if len(candidates) == 1:
                    row = candidates[0]
            if not row:
                continue
            options = question.get("options") or []
            option_text = " | ".join(
                plain(x.get("html") or x.get("text") or x.get("option_html") or x.get("value") or x)
                if isinstance(x, dict) else plain(x) for x in options
            )
            items[row["question_id"]] = {
                "question_id": row["question_id"], "subject": subject,
                "source_test": source_title, "stem": stem, "options": option_text,
                "correct_answer": plain(question.get("correct_answer_source")),
                "explanation": first_substantive_explanation(question.get("explanation_html")),
                "negative_question": bool(row.get("negative")),
                "is_pyq": bool(row.get("is_pyq")),
                "has_media": bool(question.get("media")),
                "gold": {"status": "PENDING_INDEPENDENT_MEDICAL_REVIEW", "primary": None, "broader": None},
            }
    if len(items) != 22808:
        raise RuntimeError(f"Offline evidence cache resolved {len(items)}/22808 questions")
    return list(items.values())


def stable_rank(tag: str, question_id: str) -> str:
    return hashlib.sha256(f"{tag}|{question_id}".encode()).hexdigest()


def build_benchmark(fixture: Path = FIXTURE, output: Path = BENCHMARK, size: int = 76) -> dict:
    rows = load_offline_full()
    chosen: list[dict] = []
    by_id: dict[str, dict] = {}

    def mark(row: dict, tag: str) -> None:
        if row["question_id"] not in by_id:
            copy = {**row, "strata": []}
            by_id[row["question_id"]] = copy
            chosen.append(copy)
        if tag not in by_id[row["question_id"]]["strata"]:
            by_id[row["question_id"]]["strata"].append(tag)

    def ensure(pool: list[dict], count: int, tag: str) -> None:
        matching = sum(x["question_id"] in {p["question_id"] for p in pool} for x in chosen)
        for row in sorted(pool, key=lambda x: stable_rank(tag, x["question_id"])):
            if matching >= count or len(chosen) >= size:
                break
            if row["question_id"] not in by_id:
                mark(row, tag); matching += 1
            elif tag not in by_id[row["question_id"]]["strata"]:
                mark(row, tag)

    # Regression identifiers affect selection only; no historical label is read.
    regression_rows = [x for x in rows if x["question_id"] in KNOWN_REGRESSION_IDS]
    if len(regression_rows) != len(KNOWN_REGRESSION_IDS):
        raise RuntimeError("The fixture does not contain every known historical regression")
    for row in sorted(regression_rows, key=lambda x: x["question_id"]):
        mark(row, "known_regression")
    for subject in sorted({x["subject"] for x in rows}):
        ensure([x for x in rows if x["subject"] == subject], 1, f"subject:{subject}")
    ensure([x for x in rows if x["negative_question"]], 18, "negative")
    management_words = ("treatment", "management", "drug of choice", "next step", "most appropriate")
    ensure([x for x in rows if any(w in x["stem"].lower() for w in management_words)], 12, "management")
    staging_words = ("stage", "grade", "grading", "prognostic")
    ensure([x for x in rows if any(w in x["stem"].lower() for w in staging_words)], 8, "staging_or_grading")
    organism_test_words = ("identify", "identification", "test", "assay", "culture", "organism")
    ensure([x for x in rows if any(w in x["stem"].lower() for w in organism_test_words)], 8, "organism_vs_test")
    ensure([x for x in rows if x["is_pyq"]], 18, "pyq_or_broad")
    ensure(rows, size, "straightforward_or_fill")
    if len(chosen) != size or len({x["subject"] for x in chosen}) != 19:
        raise RuntimeError("Unable to construct the balanced 76-question benchmark")
    manifest = {
        "version": SCHEMA_VERSION,
        "read_only": True,
        "gold_policy": "Independent clinician-authored primary/broader labels required; prior classifier labels excluded.",
        "items": chosen,
    }
    output.write_text(json.dumps(manifest, indent=2))
    return manifest


def content_key(item: dict, model: str) -> str:
    payload = {k: item[k] for k in ("subject", "source_test", "stem", "options", "correct_answer", "explanation", "negative_question")}
    return hashlib.sha256((SCHEMA_VERSION + "|" + model + "|" + json.dumps(payload, sort_keys=True)).encode()).hexdigest()


def request_body(item: dict, model: str) -> dict:
    evidence = {k: item[k] for k in ("subject", "source_test", "stem", "options", "correct_answer", "explanation", "negative_question")}
    return {
        "model": model,
        "instructions": SYSTEM_PROMPT,
        "input": json.dumps(evidence, ensure_ascii=False),
        "text": {"format": {"type": "json_schema", "name": "tested_concept", "strict": True, "schema": OUTPUT_SCHEMA}},
    }


def parse_response(data: dict) -> dict:
    if data.get("output_text"):
        return json.loads(data["output_text"])
    for block in data.get("output", []):
        for part in block.get("content", []):
            if part.get("type") == "output_text":
                return json.loads(part["text"])
    raise ValueError("Responses API returned no output_text")


def run(benchmark: Path, output: Path, model: str, api_key: str) -> dict:
    items = json.loads(benchmark.read_text())["items"]
    cached = {}
    if output.exists():
        for line in output.read_text().splitlines():
            if line.strip():
                row = json.loads(line); cached[row["content_key"]] = row
    started = time.perf_counter(); calls = 0
    with output.open("a") as handle:
        for item in items:
            key = content_key(item, model)
            if key in cached:
                continue
            req = urllib.request.Request(
                "https://api.openai.com/v1/responses",
                data=json.dumps(request_body(item, model)).encode(),
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=180) as response:
                raw = json.load(response)
            record = {"question_id": item["question_id"], "content_key": key, "model": model,
                      "classification": parse_response(raw), "usage": raw.get("usage", {})}
            handle.write(json.dumps(record) + "\n"); handle.flush(); calls += 1
    return {"questions": len(items), "new_calls": calls, "seconds": round(time.perf_counter() - started, 3)}


def evaluate(benchmark: Path, output: Path, report: Path) -> dict:
    items = json.loads(benchmark.read_text())["items"]
    pending = [x for x in items if x["gold"]["status"] != "VERIFIED"]
    if pending:
        raise SystemExit(f"Cannot score: {len(pending)}/{len(items)} items lack independent VERIFIED medical gold labels")
    predictions = {x["question_id"]: x for x in map(json.loads, output.read_text().splitlines())}
    # Exact normalized matches are deliberately strict; synonym equivalence must be resolved in gold review.
    norm = lambda x: " ".join((x or "").lower().replace("-", " ").split())
    scored = []
    for item in items:
        pred = predictions[item["question_id"]]["classification"]; gold = item["gold"]
        scored.append({"question_id": item["question_id"], "negative": item["negative_question"],
                       "primary_correct": norm(pred["primary_tested_concept"]) == norm(gold["primary"]),
                       "broader_correct": norm(pred["broader_concept"]) == norm(gold["broader"]),
                       "primary_assigned": pred["primary_tested_concept"] is not None,
                       "broader_assigned": pred["broader_concept"] is not None})
    def precision(field: str, assigned: str) -> Optional[float]:
        subset = [x for x in scored if x[assigned]]
        return round(100 * sum(x[field] for x in subset) / len(subset), 2) if subset else None
    result = {"version": SCHEMA_VERSION, "questions": len(scored),
              "primary_precision_percent": precision("primary_correct", "primary_assigned"),
              "primary_coverage_percent": round(100 * sum(x["primary_assigned"] for x in scored) / len(scored), 2),
              "broader_precision_percent": precision("broader_correct", "broader_assigned"),
              "useful_coverage_percent": round(100 * sum(x["primary_assigned"] or x["broader_assigned"] for x in scored) / len(scored), 2)}
    report.write_text(json.dumps(result, indent=2)); return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-benchmark", action="store_true")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--evaluate", action="store_true")
    parser.add_argument("--model")
    parser.add_argument("--benchmark", type=Path, default=BENCHMARK)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--report", type=Path, default=REPORT)
    args = parser.parse_args()
    if args.build_benchmark:
        print(json.dumps({"items": len(build_benchmark(output=args.benchmark)["items"]), "path": str(args.benchmark)}, indent=2))
    if args.run:
        key = os.environ.get("OPENAI_API_KEY")
        if not args.model or not key:
            raise SystemExit("--run requires --model and OPENAI_API_KEY")
        print(json.dumps(run(args.benchmark, args.output, args.model, key), indent=2))
    if args.evaluate:
        print(json.dumps(evaluate(args.benchmark, args.output, args.report), indent=2))


if __name__ == "__main__":
    main()
