#!/usr/bin/env python3
"""Verify, back up, atomically persist, and verify frozen PrepLadder SAFE_V1 links."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.parse
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from taxonomy_draft_classifier import SUPABASE_URL, chunks, in_filter, request

ARTIFACT = Path("/tmp/qbank-safe-v1-filter.json")
ARTIFACT_SHA256 = "f5b760e4834e746693349c20369b72a78b6235098d5308af027fb7c28772f6a2"
VERSION = "safe-v1-filter-2026-09-14"
EXPECTED = 1355
DEFERRED = 1399
BACKUP_ROOT = Path("/tmp/qbank-safe-v1-production-backups")


def count_table(key: str, table: str, query: str = "") -> int:
    headers = {"Prefer": "count=exact", "Range": "0-0"}
    path = f"/rest/v1/{table}?select=*{query}"
    # Use urllib directly because count is returned in Content-Range, not JSON.
    import urllib.request
    req = urllib.request.Request(
        SUPABASE_URL + path,
        headers={"apikey": key, "Authorization": f"Bearer {key}", **headers},
    )
    with urllib.request.urlopen(req, timeout=90) as response:
        return int(response.headers["Content-Range"].split("/")[-1])


def load_rows() -> tuple[list[dict], set[str]]:
    raw = ARTIFACT.read_bytes()
    if hashlib.sha256(raw).hexdigest() != ARTIFACT_SHA256:
        raise RuntimeError("SAFE_V1 artifact checksum mismatch")
    data = json.loads(raw)
    if data.get("version") != VERSION or data.get("read_only") is not True:
        raise RuntimeError("SAFE_V1 artifact identity mismatch")
    safe, deferred = data["safe_v1"], data["deferred"]
    cluster_labels = {
        row["cluster_id"]: (row["subject"], row["normalized_label"])
        for row in data["safe_clusters"]
    }
    if len(safe) != EXPECTED or len(deferred) != DEFERRED:
        raise RuntimeError("SAFE_V1/deferred cardinality mismatch")
    safe_ids = {row["question_id"] for row in safe}
    deferred_ids = {row["question_id"] for row in deferred}
    if len(safe_ids) != EXPECTED or safe_ids & deferred_ids:
        raise RuntimeError("SAFE_V1 IDs are duplicated or overlap DEFERRED")
    output = []
    for row in safe:
        evidence = "+".join(sorted(row.get("evidence") or [])) or "none"
        provenance = f"{row['action'].lower()}|{row['adjudication_reason']}|{evidence}"
        if row.get("is_pyq"):
            provenance += "|pyq"
        if row.get("negative"):
            provenance += "|negative"
        cluster_subject, cluster_label = cluster_labels[row["final_cluster_id"]]
        if cluster_subject != row["subject"]:
            raise RuntimeError("SAFE_V1 cluster subject mismatch")
        output.append({
            "question_id": row["question_id"],
            "normalized_concept_ref": row["final_cluster_id"],
            "classifier_version": VERSION,
            "subject": cluster_subject,
            "normalized_label": cluster_label,
            "confidence": row["final_confidence"],
            "provenance_summary": provenance[:120],
            "review_status": "safe_v1",
        })
    refs = {(r["normalized_concept_ref"], r["subject"], r["normalized_label"]) for r in output}
    if len({r[0] for r in refs}) != len(refs):
        raise RuntimeError("One normalized concept ref maps to multiple labels or subjects")
    return output, deferred_ids


def snapshot(key: str) -> dict:
    tables = (
        "questions", "qbank_source_tests", "qbank_source_occurrences",
        "qbank_question_payloads", "question_attempts", "test_sessions",
        "test_session_questions", "test_answers", "user_question_state",
        "qbank_srm_events", "question_notes", "bookmarks",
    )
    return {table: count_table(key, table) for table in tables}


def fetch_all(key: str, table: str, select: str, limit: int = 1000) -> list[dict]:
    result = []
    offset = 0
    while True:
        page = request(key, f"/rest/v1/{table}?select={select}&order=id&limit={limit}&offset={offset}")
        result.extend(page)
        if len(page) < limit:
            return result
        offset += limit


def write_backup(key: str, before: dict, rows: list[dict]) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = BACKUP_ROOT / stamp
    target.mkdir(parents=True, exist_ok=False)
    exports = {
        "canonical_medical_concepts": fetch_all(
            key, "canonical_medical_concepts",
            "id,taxonomy_version_id,stable_code,subject_name,canonical_name,status"
        ),
        "canonical_question_concept_assignments": fetch_all(
            key, "canonical_question_concept_assignments",
            "id,canonical_question_id,taxonomy_version_id,canonical_concept_id,is_primary,is_current,classifier_name,classifier_version,confidence"
        ),
    }
    for name, payload in exports.items():
        (target / f"{name}.json").write_text(json.dumps(payload, separators=(",", ":")))
    manifest = {
        "created_at": stamp,
        "project_ref": urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0],
        "artifact_sha256": ARTIFACT_SHA256,
        "classifier_version": VERSION,
        "expected_rows": len(rows),
        "integrity_before": before,
        "exports": {name: len(payload) for name, payload in exports.items()},
    }
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return target


def verify_question_ids(key: str, rows: list[dict]) -> None:
    found = set()
    for batch in chunks([row["question_id"] for row in rows], 80):
        result = request(key, f"/rest/v1/questions?select=id&id={in_filter(batch)}")
        found.update(row["id"] for row in result)
    if len(found) != EXPECTED:
        raise RuntimeError(f"Only {len(found)}/{EXPECTED} SAFE_V1 question IDs resolve")


def verify_existing_conflicts(key: str, rows: list[dict]) -> int:
    canonical_ids = []
    for batch in chunks([row["question_id"] for row in rows], 80):
        linked = request(
            key,
            f"/rest/v1/canonical_question_versions?select=canonical_question_id,question_id&question_id={in_filter(batch)}",
        )
        canonical_ids.extend(row["canonical_question_id"] for row in linked)
    active = 0
    for batch in chunks(canonical_ids, 80):
        active += len(request(
            key,
            f"/rest/v1/canonical_question_concept_assignments?select=id&is_current=eq.true&canonical_question_id={in_filter(batch)}",
        ))
    # Existing canonical-taxonomy links are independent and may coexist. A
    # conflicting SAFE_V1-version row, however, must stop the run.
    try:
        existing = request(key, f"/rest/v1/prepladder_concept_v1_assignments?select=question_id,normalized_concept_ref,classifier_version&classifier_version=eq.{VERSION}&limit=2000")
    except RuntimeError as exc:
        if "PGRST205" in str(exc) or "404" in str(exc):
            existing = []
        else:
            raise
    expected = {row["question_id"]: row["normalized_concept_ref"] for row in rows}
    conflicts = [row for row in existing if expected.get(row["question_id"]) not in (None, row["normalized_concept_ref"])]
    if conflicts:
        raise RuntimeError(f"Found {len(conflicts)} conflicting existing SAFE_V1 links")
    return active


def call_checkpoint(key: str) -> dict:
    return request(key, "/rest/v1/rpc/prepladder_concept_v1_checkpoint", "POST", {})


def verify_persisted(key: str, rows: list[dict], deferred_ids: set[str]) -> dict:
    assignments = request(key, f"/rest/v1/prepladder_concept_v1_assignments?select=question_id,normalized_concept_ref,classifier_version,confidence,provenance_summary,review_status&classifier_version=eq.{VERSION}&limit=2000")
    concepts = request(key, f"/rest/v1/prepladder_concept_v1_concepts?select=normalized_concept_ref,classifier_version,subject,normalized_label&classifier_version=eq.{VERSION}&limit=2000")
    expected = {r["question_id"]: r for r in rows}
    actual = {r["question_id"]: r for r in assignments}
    concept_refs = {r["normalized_concept_ref"] for r in concepts}
    if len(assignments) != EXPECTED or len(actual) != EXPECTED:
        raise RuntimeError("Post-write assignment cardinality/uniqueness failed")
    if deferred_ids & set(actual):
        raise RuntimeError("DEFERRED rows were written")
    for question_id, row in actual.items():
        wanted = expected.get(question_id)
        if not wanted or row["normalized_concept_ref"] != wanted["normalized_concept_ref"]:
            raise RuntimeError("Post-write assignment mismatch")
        if row["normalized_concept_ref"] not in concept_refs:
            raise RuntimeError("Unresolved normalized concept reference")
        if row["classifier_version"] != VERSION or row["review_status"] != "safe_v1":
            raise RuntimeError("Post-write version/review state mismatch")
    return {"assignments": len(assignments), "concepts": len(concepts), "deferred_written": 0}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not key:
        raise SystemExit("SUPABASE_SERVICE_ROLE_KEY is required")
    rows, deferred_ids = load_rows()
    verify_question_ids(key, rows)
    before_integrity = snapshot(key)
    canonical_links = verify_existing_conflicts(key, rows)
    backup = write_backup(key, before_integrity, rows)
    report = {
        "project_ref": urllib.parse.urlparse(SUPABASE_URL).hostname.split(".")[0],
        "artifact_sha256": ARTIFACT_SHA256,
        "expected": EXPECTED,
        "deferred": DEFERRED,
        "resolved_question_ids": EXPECTED,
        "preexisting_canonical_links": canonical_links,
        "integrity_before": before_integrity,
        "backup_path": str(backup),
        "write_executed": False,
    }
    if not args.apply:
        print(json.dumps(report, indent=2))
        return 0
    before_db = call_checkpoint(key)
    started = time.perf_counter()
    write_result = request(
        key, "/rest/v1/rpc/persist_prepladder_concept_v1", "POST", {"rows_json": rows}
    )
    elapsed = time.perf_counter() - started
    verification = verify_persisted(key, rows, deferred_ids)
    after_integrity = snapshot(key)
    if before_integrity != after_integrity:
        changed = {k: (before_integrity[k], after_integrity[k]) for k in before_integrity if before_integrity[k] != after_integrity[k]}
        raise RuntimeError(f"Protected learner/source counts changed: {changed}")
    after_db = call_checkpoint(key)
    checkpoint = {
        **report,
        "write_executed": True,
        "write_result": write_result,
        "runtime_seconds": elapsed,
        "verification": verification,
        "integrity_after": after_integrity,
        "db_before": before_db,
        "db_after": after_db,
    }
    (backup / "postwrite-checkpoint.json").write_text(json.dumps(checkpoint, indent=2) + "\n")
    assignments = request(key, f"/rest/v1/prepladder_concept_v1_assignments?select=question_id,normalized_concept_ref,classifier_version,confidence,provenance_summary,review_status&classifier_version=eq.{VERSION}&limit=2000")
    (backup / "prepladder_concept_v1_assignments.json").write_text(json.dumps(assignments, separators=(",", ":")))
    print(json.dumps(checkpoint, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
