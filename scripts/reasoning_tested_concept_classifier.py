#!/usr/bin/env python3
"""Build and run a read-only, model-reasoned tested-concept benchmark.

The runner intentionally keeps independent medical gold labels separate from
model output. It never reads or writes Supabase and cannot run a full corpus.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Optional

FIXTURE = Path("/tmp/qbank-fast-fixture.json")
BENCHMARK = Path("/tmp/qbank-reasoning-concept-benchmark-200.json")
OUTPUT = Path("/tmp/qbank-reasoning-concept-output.jsonl")
REPORT = Path("/tmp/qbank-reasoning-concept-report.json")
SCHEMA_VERSION = "tested-concept-reasoning-v1"

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


def stable_rank(tag: str, question_id: str) -> str:
    return hashlib.sha256(f"{tag}|{question_id}".encode()).hexdigest()


def build_benchmark(fixture: Path = FIXTURE, output: Path = BENCHMARK, size: int = 200) -> dict:
    rows = [normalize_question(x) for x in json.loads(fixture.read_text())["evidence"]]
    chosen: list[dict] = []
    seen: set[str] = set()

    def take(pool: list[dict], count: int, tag: str) -> None:
        for row in sorted(pool, key=lambda x: stable_rank(tag, x["question_id"])):
            if row["question_id"] not in seen and len([x for x in chosen if tag in x["strata"]]) < count:
                row = {**row, "strata": [tag]}; chosen.append(row); seen.add(row["question_id"])

    # Guarantee every subject, then deliberately stress the requested failure classes.
    for subject in sorted({x["subject"] for x in rows}):
        take([x for x in rows if x["subject"] == subject], 1, f"subject:{subject}")
    take([x for x in rows if x["negative_question"]], 40, "negative")
    take([x for x in rows if x["is_pyq"]], 35, "pyq_or_broad")
    take([x for x in rows if x["has_media"]], 25, "image_or_media")
    management_words = ("treatment", "management", "drug of choice", "next step")
    take([x for x in rows if any(w in x["stem"].lower() for w in management_words)], 25, "management")
    test_words = ("stage", "grade", "prognostic", "identify", "test", "assay", "culture")
    take([x for x in rows if any(w in x["stem"].lower() for w in test_words)], 25, "test_stage_grade")
    take(rows, size - len(chosen), "diverse_fill")
    chosen = chosen[:size]
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
