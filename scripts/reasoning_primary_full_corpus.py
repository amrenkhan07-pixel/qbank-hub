#!/usr/bin/env python3
"""Offline, resumable PRIMARY tested-concept reasoning run for PrepLadder."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from collections import Counter, defaultdict
from pathlib import Path

try:
    from reasoning_tested_concept_classifier import SYSTEM_PROMPT, load_offline_full
except ImportError:
    from scripts.reasoning_tested_concept_classifier import SYSTEM_PROMPT, load_offline_full

VERSION = "primary-tested-concept-reasoning-v1"
MODEL = "gpt-5.6-sol"
OUTPUT = Path("/tmp/qbank-reasoning-primary-full-v1.jsonl")
REPORT = Path("/tmp/qbank-reasoning-primary-full-v1-report.json")
SCHEMA = Path(__file__).with_name("reasoning_primary_batch_schema.json")
CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex"

NEGATIVE_PATTERNS = (
    re.compile(r"\b(?:except|incorrect|false)\b", re.I),
    re.compile(r"\bleast\s+likely\b", re.I),
    re.compile(r"\ball\s+(?:of\s+the\s+following\s+)?(?:are|is)\s+true\s+except\b", re.I),
    re.compile(r"\bwhich\b[\s\S]{0,160}\b(?:is|are|does|do|would|will|can|could)\b[\s\S]{0,40}\bnot\b", re.I),
)


def deterministic_negative(stem: str) -> bool:
    """Detect explicit question-level negation, never incidental clinical 'not'."""
    text = " ".join(stem.split())
    question_clause = re.split(r"[?]", text, maxsplit=1)[0]
    tail = question_clause[-260:]
    # Remove subordinate conditions before looking for question-level negation.
    # Example: "vaccine damaged if not refrigerated" is positive-intent.
    tail = re.sub(r"\bif\s+not\b", "if", tail, flags=re.I)
    if re.search(r"\b(?:has|have|had|is|was|were|are|do|does|did)\s+not\b", tail, re.I):
        # Explicit templates below override this guard. This excludes narrative
        # statements such as "has not healed" and "is not progressing".
        if not re.search(r"\bwhich\b[\s\S]{0,160}\b(?:is|are|does|do|would|will|can|could)\b[\s\S]{0,40}\bnot\b", tail, re.I):
            tail = re.sub(r"\b(?:has|have|had|is|was|were|are|do|does|did|will|would|can|could)\s+not\b", "", tail, flags=re.I)
    return any(pattern.search(tail) for pattern in NEGATIVE_PATTERNS)


def evidence_payload(item: dict) -> dict:
    return {
        "question_id": item["question_id"], "subject": item["subject"],
        "source_test": item["source_test"], "stem": item["stem"],
        "options": item["options"], "correct_answer": item["correct_answer"],
        "explanation": item["explanation"],
        "negative_question": deterministic_negative(item["stem"]),
    }


def content_key(item: dict) -> str:
    return hashlib.sha256((VERSION + "|" + MODEL + "|" + json.dumps(
        evidence_payload(item), sort_keys=True, ensure_ascii=False,
    )).encode()).hexdigest()


def normalize_primary(value: str) -> str:
    value = value.lower().replace("’", "'")
    value = re.sub(r"\bsickle[ -]?cell\b", "sickle cell", value)
    value = re.sub(r"\bvaso[ -]?occlusive\b", "vaso occlusive", value)
    value = re.sub(r"\bmyocardial infarction\b", "mi", value)
    value = re.sub(r"\bcomputed tomography\b", "ct", value)
    value = re.sub(r"\bmagnetic resonance imaging\b", "mri", value)
    value = re.sub(r"[^a-z0-9+]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def prompt_for(path: Path, count: int) -> str:
    return f"""You are the blind reasoning-based medical tested-concept classifier.
Read only {path}. Do not inspect any other file, gold set, taxonomy, or prior classifier output.
For every one of the {count} questions, reason from subject, source-test context, stem, options,
correct answer, first substantive explanation, and the supplied deterministic negative flag.
{SYSTEM_PROMPT}
Output PRIMARY tested concept, optional experimental BROADER concept, and HIGH/MEDIUM/LOW
confidence. Preserve every question_id and subject exactly and output all {count} once."""


def classify_batch(batch_index: int, items: list[dict], retries: int = 2) -> dict:
    payload = {"items": [evidence_payload(x) for x in items]}
    with tempfile.TemporaryDirectory(prefix=f"qbank-primary-{batch_index:04d}-") as directory:
        directory = Path(directory)
        input_path, output_path = directory / "input.json", directory / "output.json"
        input_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        last_error = ""
        for attempt in range(retries + 1):
            started = time.perf_counter()
            process = subprocess.run([
                CODEX, "exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only",
                "--skip-git-repo-check", "-C", str(directory), "-m", MODEL,
                "--output-schema", str(SCHEMA), "-o", str(output_path),
                prompt_for(input_path, len(items)),
            ], text=True, capture_output=True, timeout=900)
            elapsed = time.perf_counter() - started
            if process.returncode == 0 and output_path.exists():
                try:
                    result = json.loads(output_path.read_text())["items"]
                    expected = {x["question_id"] for x in items}
                    if len(result) == len(items) and {x["question_id"] for x in result} == expected:
                        tokens = re.findall(r"tokens used\s*\n?\s*([\d,]+)", process.stderr + process.stdout, re.I)
                        return {"batch": batch_index, "items": result, "seconds": elapsed,
                                "tokens": int(tokens[-1].replace(",", "")) if tokens else None,
                                "attempts": attempt + 1}
                    last_error = "output ID/cardinality mismatch"
                except (json.JSONDecodeError, KeyError) as error:
                    last_error = str(error)
            else:
                last_error = (process.stderr or process.stdout)[-1000:]
        raise RuntimeError(f"batch {batch_index} failed after {retries + 1} attempts: {last_error}")


def load_cache(path: Path) -> dict[str, dict]:
    cached = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                cached[row["content_key"]] = row
    return cached


def run(output: Path, report: Path, batch_size: int, concurrency: int, limit: int | None = None) -> dict:
    evidence = load_offline_full()
    if limit:
        evidence = evidence[:limit]
    cache = load_cache(output)
    missing = [x for x in evidence if content_key(x) not in cache]
    batches = [missing[i:i + batch_size] for i in range(0, len(missing), batch_size)]
    started = time.perf_counter()
    lock = threading.Lock()
    new_rows = 0
    batch_metrics = []
    with output.open("a") as handle, concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(classify_batch, i, batch): batch for i, batch in enumerate(batches)}
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            source = {x["question_id"]: x for x in futures[future]}
            rows = []
            for prediction in result["items"]:
                item = source[prediction["question_id"]]
                rows.append({"question_id": item["question_id"], "content_key": content_key(item),
                             "classifier_version": VERSION, "model": MODEL,
                             "deterministic_negative": deterministic_negative(item["stem"]),
                             "prediction": prediction})
            with lock:
                for row in rows:
                    handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
                handle.flush()
                new_rows += len(rows)
                batch_metrics.append({k: result[k] for k in ("batch", "seconds", "tokens", "attempts")})
                print(json.dumps({"completed": new_rows, "remaining": len(missing) - new_rows,
                                  "batch": result["batch"], "seconds": round(result["seconds"], 2)}), flush=True)
    elapsed = time.perf_counter() - started
    final_cache = load_cache(output)
    results = [final_cache[content_key(x)] for x in evidence]
    predictions = [x["prediction"] for x in results]
    primary = [x for x in predictions if x["primary_tested_concept"]]
    broader_only = [x for x in predictions if not x["primary_tested_concept"] and x.get("broader_concept")]
    clusters = defaultdict(list)
    subjects = {x["question_id"]: x["subject"] for x in evidence}
    for row in primary:
        clusters[(subjects[row["question_id"]], normalize_primary(row["primary_tested_concept"]))].append(row["question_id"])
    summary = {
        "version": VERSION, "read_only": True, "processed": len(results),
        "primary_nonblank": len(primary), "broader_only": len(broader_only),
        "useful_coverage_percent": round(100 * (len(primary) + len(broader_only)) / len(results), 2),
        "blanks": len(results) - len(primary) - len(broader_only),
        "unique_normalized_primary": len(clusters),
        "confidence": dict(Counter(x["confidence"] for x in predictions)),
        "deterministic_negative": sum(x["deterministic_negative"] for x in results),
        "runtime_seconds": round(elapsed, 3),
        "throughput_per_second": round(len(missing) / elapsed, 3) if elapsed else 0,
        "cached_skipped": len(results) - len(missing), "new_predictions": len(missing),
        "batch_size": batch_size, "concurrency": concurrency,
        "tokens_reported": sum(x["tokens"] or 0 for x in batch_metrics),
        "token_reporting_batches": sum(x["tokens"] is not None for x in batch_metrics),
        "batches": len(batches), "retried_batches": sum(x["attempts"] > 1 for x in batch_metrics),
        "production_writes": 0,
    }
    report.write_text(json.dumps({"summary": summary, "clusters": [
        {"subject": k[0], "normalized_primary": k[1], "question_ids": v}
        for k, v in sorted(clusters.items())
    ]}, indent=2, ensure_ascii=False) + "\n")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--report", type=Path, default=REPORT)
    parser.add_argument("--batch-size", type=int, default=40)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 8 or not 1 <= args.batch_size <= 60:
        raise SystemExit("concurrency must be 1..8 and batch size 1..60")
    print(json.dumps(run(args.output, args.report, args.batch_size, args.concurrency, args.limit), indent=2))


if __name__ == "__main__":
    main()
