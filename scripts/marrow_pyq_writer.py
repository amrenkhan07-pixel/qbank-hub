#!/usr/bin/env python3
"""Fail-closed staged Marrow PYQ writer with dry-run, explicit apply and rollback."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sqlite3
import urllib.parse
import urllib.request
import urllib.error
from collections import Counter, defaultdict
from pathlib import Path

BATCH_ID = "marrow-pyq-v1-20260920"
ARTIFACT_SHA256 = "c3ee2697542afacd49d3931c71ec05f010190394dd2196252ff0c0efc132f76a"
EXPECTED = {"staged_occurrences": 5938, "source_tests": 342,
            "marrow_content_versions": 5914, "new_canonical_identity_proposals": 5852}
EXPECTED_REVIEW = 314
EXPECTED_SUBJECTS = 19
DEFAULT_URL = "https://flulljensjugfcxmeczu.supabase.co"
PROJECT_REF = "flulljensjugfcxmeczu"
BUCKET = "qbank-payloads"


def stable_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def validate_production_url(url: str) -> str:
    normalized = url.rstrip("/")
    parsed = urllib.parse.urlparse(normalized)
    if parsed.scheme != "https" or parsed.hostname != f"{PROJECT_REF}.supabase.co":
        raise ValueError("wrong production Supabase project")
    return normalized


def load_artifact(path: Path) -> dict:
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != ARTIFACT_SHA256:
        raise ValueError(f"artifact checksum mismatch: {digest}")
    doc = json.loads(gzip.decompress(data))
    if doc.get("version") != "marrow-pyq-stage-v1" or not doc.get("read_only") or doc.get("production_writes") != 0:
        raise ValueError("unexpected artifact version or write state")
    summary = doc["summary"]
    if any(summary.get(k) != v for k, v in EXPECTED.items()):
        raise ValueError("staged count mismatch")
    if summary["operation_counts"].get("REVIEW_IDENTITY_CANDIDATE") != EXPECTED_REVIEW:
        raise ValueError("review count mismatch")
    if summary["operation_counts"].get("INVALID / QUARANTINE", 0) != 0:
        raise ValueError("quarantine count mismatch")
    if len({t["subject"] for t in doc["source_tests"]}) != EXPECTED_SUBJECTS:
        raise ValueError("subject count mismatch")
    if len(doc["source_tests"]) != 342 or len(doc["content_versions"]) != 5914 or len(doc["occurrences"]) != 5938:
        raise ValueError("artifact arrays disagree with summary")
    if sum(doc["summary"]["operation_counts"].values()) != 5938:
        raise ValueError("operation count mismatch")
    if len({o["occurrence_key"] for o in doc["occurrences"]}) != 5938:
        raise ValueError("duplicate staged occurrence key")
    if len({v["question_id"] for v in doc["content_versions"]}) != 5914:
        raise ValueError("duplicate staged content version")
    if len({t["id"] for t in doc["source_tests"]}) != 342:
        raise ValueError("duplicate staged source test")
    return doc


SCHEMA = """
pragma foreign_keys=on;
create table if not exists import_checkpoint(batch_id text, subject text, artifact_sha text, status text, primary key(batch_id,subject));
create table if not exists identities(id text primary key, origin_batch text);
create table if not exists identity_links(question_id text primary key, identity_id text not null references identities(id), platform text not null, origin_batch text);
create table if not exists source_tests(id text primary key, subject text not null, title text not null, exam text not null, year integer not null, origin_batch text);
create table if not exists payload_objects(id text primary key, source_test_id text not null references source_tests(id), sha256 text not null, origin_batch text);
create table if not exists marrow_versions(question_id text primary key, identity_id text not null references identities(id), subject text not null, content_hash text not null, payload_object_id text not null references payload_objects(id), payload_index integer not null, payload_json text not null, origin_batch text);
create table if not exists source_occurrences(occurrence_key text primary key, question_id text not null references marrow_versions(question_id), source_test_id text not null references source_tests(id), source_question_id text not null, position integer not null, exam text not null, year integer not null, session text, origin_batch text, unique(source_test_id,position));
create table if not exists identity_review(question_id text primary key references marrow_versions(question_id), reason text not null, candidates_json text not null, origin_batch text);
create table if not exists learner_sentinel(id integer primary key, value text not null);
"""


def open_local(path: Path, doc: dict) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), isolation_level=None)
    conn.executescript(SCHEMA)
    canonical = set()
    for v in doc["content_versions"]:
        if v["canonical_identity_already_exists"]:
            canonical.add((v["proposed_canonical_question_id"], v["matched_prepladder_question_id"]))
    conn.execute("begin immediate")
    for identity_id, question_id in sorted(canonical):
        conn.execute("insert or ignore into identities values(?,null)", (identity_id,))
        conn.execute("insert or ignore into identity_links values(?,?,?,null)", (question_id, identity_id, "PrepLadder"))
    conn.execute("insert or ignore into learner_sentinel values(1,'unchanged')")
    conn.execute("commit")
    return conn


def table_counts(conn: sqlite3.Connection) -> dict:
    names = ("identities", "identity_links", "source_tests", "payload_objects", "marrow_versions",
             "source_occurrences", "identity_review", "learner_sentinel", "import_checkpoint")
    return {name: conn.execute(f"select count(*) from {name}").fetchone()[0] for name in names}


def backup_manifest(conn: sqlite3.Connection, path: Path, doc: dict) -> dict:
    backup = path.with_suffix(".preimport.json")
    if backup.exists():
        prior = json.loads(backup.read_text())
        if prior["batch_id"] != BATCH_ID or prior["artifact_sha256"] != ARTIFACT_SHA256:
            raise ValueError("pre-import backup belongs to a different batch")
        return prior
    manifest = {"batch_id": BATCH_ID, "artifact_sha256": ARTIFACT_SHA256,
                "before_counts": table_counts(conn),
                "preexisting_identity_ids": [r[0] for r in conn.execute("select id from identities order by id")],
                "preexisting_link_question_ids": [r[0] for r in conn.execute("select question_id from identity_links order by question_id")],
                "preexisting_marrow_test_ids": [r[0] for r in conn.execute("select id from source_tests order by id")],
                "preexisting_marrow_occurrence_keys": [r[0] for r in conn.execute("select occurrence_key from source_occurrences order by occurrence_key")],
                "matched_prepladder_question_ids": sorted({v["matched_prepladder_question_id"] for v in doc["content_versions"] if v["matched_prepladder_question_id"]})}
    backup.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")))
    return manifest


def insert_checked(conn: sqlite3.Connection, table: str, key_column: str, key: str, columns: tuple, values: tuple) -> bool:
    found = conn.execute(f"select {','.join(columns)} from {table} where {key_column}=?", (key,)).fetchone()
    if found is not None:
        if found != values:
            raise ValueError(f"existing {table} row conflicts: {key}")
        return False
    placeholders = ",".join("?" for _ in columns)
    conn.execute(f"insert into {table}({','.join(columns)}) values({placeholders})", values)
    return True


def apply_local(conn: sqlite3.Connection, doc: dict, fail_after_subjects: int | None = None) -> dict:
    tests_by_subject, objects_by_subject, versions_by_subject, occ_by_subject = (defaultdict(list) for _ in range(4))
    test_subject = {t["id"]: t["subject"] for t in doc["source_tests"]}
    for t in doc["source_tests"]: tests_by_subject[t["subject"]].append(t)
    for obj in doc["payload_objects"]: objects_by_subject[test_subject[obj["source_test_id"]]].append(obj)
    for v in doc["content_versions"]: versions_by_subject[v["subject"]].append(v)
    for o in doc["occurrences"]: occ_by_subject[o["subject"]].append(o)
    completed = skipped = 0
    for subject in sorted(tests_by_subject):
        checkpoint = conn.execute("select artifact_sha,status from import_checkpoint where batch_id=? and subject=?", (BATCH_ID, subject)).fetchone()
        if checkpoint:
            if checkpoint != (ARTIFACT_SHA256, "complete"):
                raise ValueError(f"checkpoint conflict: {subject}")
            if conn.execute("select count(*) from source_tests where subject=? and origin_batch=?", (subject, BATCH_ID)).fetchone()[0] != len(tests_by_subject[subject]):
                raise ValueError(f"completed source-test batch changed: {subject}")
            if conn.execute("select count(*) from marrow_versions where subject=? and origin_batch=?", (subject, BATCH_ID)).fetchone()[0] != len(versions_by_subject[subject]):
                raise ValueError(f"completed content batch changed: {subject}")
            for v in versions_by_subject[subject]:
                row = conn.execute("select content_hash,identity_id from marrow_versions where question_id=?", (v["question_id"],)).fetchone()
                if row != (v["content_sha256"], v["proposed_canonical_question_id"]):
                    raise ValueError(f"completed version changed: {v['question_id']}")
            for o in occ_by_subject[subject]:
                row = conn.execute("select question_id,source_test_id,position,exam,year from source_occurrences where occurrence_key=?", (o["occurrence_key"],)).fetchone()
                if row != (o["question_id"], o["source_test_uuid"], o["question_order_within_test"], o["exam_family"], o["year"]):
                    raise ValueError(f"completed occurrence changed: {o['occurrence_key']}")
            skipped += 1
            continue
        conn.execute("begin immediate")
        try:
            for t in tests_by_subject[subject]:
                insert_checked(conn, "source_tests", "id", t["id"],
                               ("id", "subject", "title", "exam", "year", "origin_batch"),
                               (t["id"], subject, t["source_test_title"], t["exam_family"], t["year"], BATCH_ID))
            for obj in objects_by_subject[subject]:
                insert_checked(conn, "payload_objects", "id", obj["id"],
                               ("id", "source_test_id", "sha256", "origin_batch"),
                               (obj["id"], obj["source_test_id"], obj["sha256"], BATCH_ID))
            for v in versions_by_subject[subject]:
                identity = v["proposed_canonical_question_id"]
                conn.execute("insert or ignore into identities values(?,?)", (identity, BATCH_ID))
                prep_id = v["matched_prepladder_question_id"]
                if prep_id:
                    existing = conn.execute("select identity_id from identity_links where question_id=?", (prep_id,)).fetchone()
                    if existing and existing[0] != identity:
                        raise ValueError(f"PrepLadder identity conflict: {prep_id}")
                    if not existing:
                        conn.execute("insert into identity_links values(?,?,?,?)", (prep_id, identity, "PrepLadder", BATCH_ID))
                insert_checked(conn, "marrow_versions", "question_id", v["question_id"],
                               ("question_id", "identity_id", "subject", "content_hash", "payload_object_id", "payload_index", "payload_json", "origin_batch"),
                               (v["question_id"], identity, subject, v["content_sha256"], v["payload_object_id"],
                                v["payload_index"], json.dumps(v["payload"], sort_keys=True, separators=(",", ":")), BATCH_ID))
                conn.execute("insert or ignore into identity_links values(?,?,?,?)", (v["question_id"], identity, "Marrow", BATCH_ID))
                if v["review_reason"]:
                    candidates = [o["matched_prepladder_question_ids"] for o in occ_by_subject[subject] if o["question_id"] == v["question_id"]]
                    insert_checked(conn, "identity_review", "question_id", v["question_id"],
                                   ("question_id", "reason", "candidates_json", "origin_batch"),
                                   (v["question_id"], v["review_reason"], json.dumps(candidates[0] if candidates else []), BATCH_ID))
            for o in occ_by_subject[subject]:
                insert_checked(conn, "source_occurrences", "occurrence_key", o["occurrence_key"],
                               ("occurrence_key", "question_id", "source_test_id", "source_question_id", "position", "exam", "year", "session", "origin_batch"),
                               (o["occurrence_key"], o["question_id"], o["source_test_uuid"], o["source_question_id"],
                                o["question_order_within_test"], o["exam_family"], o["year"], o["session"], BATCH_ID))
            conn.execute("insert into import_checkpoint values(?,?,?,?)", (BATCH_ID, subject, ARTIFACT_SHA256, "complete"))
            conn.execute("commit")
        except Exception:
            conn.execute("rollback")
            raise
        completed += 1
        if fail_after_subjects is not None and completed >= fail_after_subjects:
            raise InterruptedError(f"injected interruption after {completed} committed subjects")
    return {"completed_subject_batches": completed, "skipped_subject_batches": skipped,
            "counts": table_counts(conn)}


def rollback_local(conn: sqlite3.Connection, backup: dict) -> dict:
    if backup["batch_id"] != BATCH_ID or backup["artifact_sha256"] != ARTIFACT_SHA256:
        raise ValueError("rollback manifest mismatch")
    conn.execute("begin immediate")
    try:
        for table in ("identity_review", "source_occurrences", "identity_links", "marrow_versions",
                      "payload_objects", "source_tests", "identities", "import_checkpoint"):
            if table == "identities":
                conn.execute("delete from identities where origin_batch=? and not exists(select 1 from identity_links l where l.identity_id=identities.id)", (BATCH_ID,))
                if conn.execute("select count(*) from identities where origin_batch=?", (BATCH_ID,)).fetchone()[0]:
                    raise ValueError("shared identity remains; rollback refused")
            else:
                conn.execute(f"delete from {table} where {'batch_id' if table == 'import_checkpoint' else 'origin_batch'}=?", (BATCH_ID,))
        after = table_counts(conn)
        if after != backup["before_counts"]:
            raise ValueError("rollback counts differ from pre-import backup")
        conn.execute("commit")
    except Exception:
        conn.execute("rollback")
        raise
    return {"restored": True, "counts": after}


def api_get(url: str, key: str, table: str, query: str) -> tuple[list, int]:
    request = urllib.request.Request(f"{url}/rest/v1/{table}?{query}",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "count=exact"}, method="GET")
    with urllib.request.urlopen(request, timeout=15) as response:
        rows = json.loads(response.read())
        content_range = response.headers.get("Content-Range", "")
    count = int(content_range.rsplit("/", 1)[-1]) if "/" in content_range and content_range.rsplit("/", 1)[-1].isdigit() else len(rows)
    return rows, count


def api_all(url: str, key: str, table: str, query: str) -> list:
    rows, offset = [], 0
    while True:
        page, _ = api_get(url, key, table, f"{query}&limit=1000&offset={offset}")
        rows.extend(page)
        if len(page) < 1000:
            return rows
        offset += len(page)


def independent_pyq_plan(doc: dict) -> dict:
    """Validate the staged V1 as independent Marrow content, without canonical merges."""
    tests = {row["id"]: row for row in doc["source_tests"]}
    versions = {row["question_id"]: row for row in doc["content_versions"]}
    objects = {row["id"]: row for row in doc["payload_objects"]}
    if len(tests) != 342 or len(versions) != 5914 or len(objects) != 342:
        raise ValueError("duplicate or missing production entity key")
    hierarchy = Counter()
    positions = set()
    reviews = 0
    for row in doc["occurrences"]:
        test = tests[row["source_test_uuid"]]
        version = versions[row["question_id"]]
        if (row["subject"], row["exam_family"], row["year"]) != (test["subject"], test["exam_family"], test["year"]):
            raise ValueError("occurrence/test subject or exam mismatch")
        if row["content_sha256"] != version["content_sha256"]:
            raise ValueError("occurrence/version content mismatch")
        position = (test["id"], row["question_order_within_test"])
        if position in positions:
            raise ValueError("duplicate source-test position")
        positions.add(position)
        hierarchy[(row["subject"], row["exam_family"], row["year"])] += 1
        reviews += row["operation"] == "REVIEW_IDENTITY_CANDIDATE"
    if reviews != EXPECTED_REVIEW or len(positions) != 5938:
        raise ValueError("review or occurrence plan mismatch")
    for row in versions.values():
        payload = row["payload"]
        if row["payload_object_id"] not in objects or row["first_source_test_uuid"] not in tests:
            raise ValueError("version object/test reference missing")
        if not payload.get("question_html") or not payload.get("explanation_html") or not payload.get("correct_keys") or not 2 <= len(payload.get("options") or []) <= 8:
            raise ValueError("incomplete question payload")
    return {
        "mode": "independent_marrow_pyq_no_prep_or_canonical_merge",
        "subjects": len({row["subject"] for row in tests.values()}),
        "exam_year_groups": len(hierarchy),
        "review_occurrences_kept_separate": reviews,
        "review_versions_kept_separate": sum(bool(row["review_reason"]) for row in versions.values()),
        "table_deltas": {
            "qbank_hybrid_import_runs": 19,
            "qbank_source_tests": 342,
            "storage_objects": 342,
            "qbank_payload_objects": 342,
            "questions": 5914,
            "qbank_question_payloads": 5914,
            "qbank_source_occurrences": 5938,
            "canonical_questions": 0,
            "canonical_question_versions": 0,
        },
    }


def production_payloads(doc: dict) -> tuple[dict[str, dict], dict[str, bytes]]:
    """Map the frozen artifact to 19 production manifests and verified gzip objects."""
    tests = {row["id"]: row for row in doc["source_tests"]}
    occurrences_by_question = defaultdict(list)
    for row in doc["occurrences"]:
        occurrences_by_question[row["question_id"]].append(row)
    versions_by_test = defaultdict(list)
    for row in doc["content_versions"]:
        versions_by_test[row["first_source_test_uuid"]].append(row)
    object_bytes = {}
    objects = {row["source_test_id"]: row for row in doc["payload_objects"]}
    for test_id, versions in versions_by_test.items():
        test = tests[test_id]
        raw = stable_json({"schema_version": 1, "platform": "Marrow", "subject": test["subject"],
                           "source_test": {"id": test["source_test_id"], "title": test["source_test_title"]},
                           "questions": [row["payload"] for row in versions]}).encode()
        compressed = gzip.compress(raw, compresslevel=9, mtime=0)
        expected = objects[test_id]
        if hashlib.sha256(compressed).hexdigest() != expected["sha256"] or len(compressed) != expected["stored_bytes"]:
            raise ValueError(f"payload object reconstruction mismatch: {test_id}")
        object_bytes[expected["object_path"]] = compressed

    tests_by_subject, objects_by_subject, versions_by_subject, occurrences_by_subject = (defaultdict(list) for _ in range(4))
    for row in doc["source_tests"]:
        tests_by_subject[row["subject"]].append({**row, "title": row["source_test_title"]})
    for row in doc["payload_objects"]:
        objects_by_subject[tests[row["source_test_id"]]["subject"]].append(row)
    for row in doc["content_versions"]:
        first = tests[row["first_source_test_uuid"]]
        payload = row["payload"]
        media = payload.get("media") or []
        candidates = sorted({candidate for occurrence in occurrences_by_question[row["question_id"]]
                             for candidate in occurrence.get("matched_prepladder_question_ids") or []})
        exam_key = {"NEET-PG": "neet_pg", "INI-CET": "inicet", "AIIMS": "aiims"}[first["exam_family"]]
        versions_by_subject[row["subject"]].append({
            **{key: row[key] for key in ("question_id", "subject", "content_sha256", "payload_object_id", "payload_index", "review_reason")},
            "source_question_id": row["source_question_id_first_seen"], "stem_excerpt": row["raw_stem"],
            "first_source_test_title": first["source_test_title"], "correct_option_keys": payload["correct_keys"],
            "option_count": len(payload["options"]), "is_multi_correct": len(payload["correct_keys"]) > 1,
            "media_status": "MEDIA_REFERENCED" if media else "NO_MEDIA",
            "has_question_media": any(item.get("placement") == "question" for item in media),
            "has_explanation_media": any(item.get("placement") == "explanation" for item in media),
            "has_audio": bool(payload.get("audio")), "has_video": bool(payload.get("video")),
            "audio_url": payload.get("audio") or "", "video_url": payload.get("video") or "",
            "exam_key": exam_key, "exam_year": first["year"], "exam_session": first["session"] or "",
            "candidate_question_ids": candidates,
        })
    for row in doc["occurrences"]:
        occurrences_by_subject[row["subject"]].append({
            **row, "source_test_id": row["source_test_uuid"],
            "question_position": row["question_order_within_test"],
            "exam_year": row["year"], "exam_session": row["session"] or "",
        })
    manifests = {}
    source_bytes = len(stable_json(doc).encode())
    for subject in sorted(tests_by_subject):
        subject_objects = objects_by_subject[subject]
        manifests[subject] = {
            "batch_id": BATCH_ID, "platform": "Marrow", "source_type": "PYQ", "subject": subject,
            "source_filename": doc["source_filename"], "source_sha256": doc["source_sha256"],
            "source_bytes": source_bytes, "importer_version": "marrow-pyq-independent-v1", "schema_version": 1,
            "source_test_count": len(tests_by_subject[subject]), "occurrence_count": len(occurrences_by_subject[subject]),
            "content_version_count": len(versions_by_subject[subject]), "payload_object_count": len(subject_objects),
            "payload_stored_bytes": sum(row["stored_bytes"] for row in subject_objects),
            "source_tests": tests_by_subject[subject], "objects": subject_objects,
            "versions": versions_by_subject[subject], "occurrences": occurrences_by_subject[subject],
        }
    if sum(m["occurrence_count"] for m in manifests.values()) != 5938:
        raise ValueError("production manifests lost staged occurrences")
    return manifests, object_bytes


def api_request(url: str, key: str, path: str, method: str = "GET", body: bytes | None = None,
                headers: dict | None = None) -> tuple[bytes, dict]:
    request = urllib.request.Request(url.rstrip("/") + path, data=body, method=method,
        headers={"apikey": key, "Authorization": f"Bearer {key}", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read(), dict(response.headers)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed ({error.code}): {detail[:1000]}") from error


def rpc(url: str, key: str, name: str, payload: dict) -> object:
    body, _ = api_request(url, key, f"/rest/v1/rpc/{name}", "POST", stable_json(payload).encode(),
                          {"Content-Type": "application/json"})
    return json.loads(body or b"null")


def create_production_backup(doc: dict, result: dict, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "affected-slice-manifest.json"
    if target.exists():
        existing = json.loads(target.read_text())
        if existing.get("artifact_sha256") != ARTIFACT_SHA256 or existing.get("batch_id") != BATCH_ID:
            raise ValueError("backup directory belongs to another import")
        return target
    manifest = {"batch_id": BATCH_ID, "artifact_sha256": ARTIFACT_SHA256, "project_ref": PROJECT_REF,
        "created_before_import": True, "preimport_counts": result["preimport_counts"],
        "preexisting_marrow_test_ids": result.get("preexisting_marrow_test_ids", []),
        "preexisting_marrow_question_ids": result.get("preexisting_marrow_question_ids", []),
        "planned_test_ids": sorted(row["id"] for row in doc["source_tests"]),
        "planned_question_ids": sorted(row["question_id"] for row in doc["content_versions"]),
        "planned_occurrence_keys": sorted(row["occurrence_key"] for row in doc["occurrences"])}
    target.write_text(stable_json(manifest))
    return target


def production_dry_run(doc: dict, url: str, key: str) -> dict:
    if not key:
        raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required for read-only dry-run")
    url = validate_production_url(url)
    plan = independent_pyq_plan(doc)
    manifests, _ = production_payloads(doc)
    platforms, _ = api_get(url, key, "platforms", "select=id,name&name=eq.Marrow&limit=2")
    if len(platforms) != 1:
        raise ValueError("Marrow platform must resolve uniquely")
    platform_id = platforms[0]["id"]
    tests = api_all(url, key, "qbank_source_tests", "select=id&platform_id=eq." + urllib.parse.quote(platform_id))
    tests_count = len(tests)
    payloads = api_all(url, key, "qbank_question_payloads", "select=question_id&platform_id=eq." + urllib.parse.quote(platform_id))
    payload_count = len(payloads)
    _, prep_count = api_get(url, key, "qbank_question_payloads", "select=question_id&limit=1")
    _, _ = api_get(url, key, "canonical_question_versions", "select=question_id&limit=1")
    expected_test_ids = {row["id"] for row in doc["source_tests"]}
    expected_question_ids = {row["question_id"] for row in doc["content_versions"]}
    if not {row["id"] for row in tests} <= expected_test_ids or not {row["question_id"] for row in payloads} <= expected_question_ids:
        raise ValueError("production contains non-staged Marrow keys")
    if prep_count != doc["db_snapshot"]["payloads"] + payload_count:
        raise ValueError("production changed since staging; refresh and restage before apply")
    owned = api_all(url, key, "qbank_import_batch_records",
                    "select=entity_type,entity_key&batch_id=eq." + urllib.parse.quote(BATCH_ID))
    expected_by_type = {
        "source_test": expected_test_ids,
        "payload_object": {row["id"] for row in doc["payload_objects"]},
        "question": expected_question_ids, "question_payload": expected_question_ids,
        "review_metadata": {row["question_id"] for row in doc["content_versions"] if row["review_reason"]},
        "source_occurrence": {row["id"] for row in doc["occurrences"]},
    }
    for row in owned:
        if row["entity_type"] != "import_run" and row["entity_key"] not in expected_by_type.get(row["entity_type"], set()):
            raise ValueError("batch ownership contains a non-staged entity")
    owned_keys = {(row["entity_type"], row["entity_key"]) for row in owned}
    if any(("source_test", row["id"]) not in owned_keys for row in tests) or any(("question_payload", row["question_id"]) not in owned_keys for row in payloads):
        raise ValueError("existing Marrow rows are not owned by this batch")
    protected = {}
    for table in ("questions", "qbank_source_tests", "qbank_source_occurrences",
                  "question_attempts", "test_sessions", "user_question_state", "bookmarks"):
        _, count = api_get(url, key, table, "select=*&limit=0")
        protected[table] = count
    rpc_results = [rpc(url, key, "qbank_commit_marrow_pyq_import", {"p_manifest": manifest, "p_dry_run": True})
                   for manifest in manifests.values()]
    if len(rpc_results) != 19 or any(row.get("status") != "dry_run" for row in rpc_results):
        raise ValueError("production RPC dry-run did not validate every subject batch")
    expected_counts = {entity_type: len(keys) for entity_type, keys in expected_by_type.items()}
    expected_counts["import_run"] = 19
    owned_counts = {entity_type: 0 for entity_type in expected_counts}
    for row in owned:
        if row["entity_type"] in owned_counts:
            owned_counts[row["entity_type"]] += 1
    remaining_deltas = {
        entity_type: expected_counts[entity_type] - owned_counts[entity_type]
        for entity_type in expected_counts
    }
    return {"authenticated": True, "writes": 0, "platform_id": platform_id,
            "existing_marrow_tests": tests_count, "existing_marrow_versions": payload_count,
            "existing_total_payloads": prep_count,
            "expected_new_tests": 342, "expected_new_versions": 5914,
            "expected_new_occurrences": 5938, "staged_canonical_identity_proposals_not_used": 5852,
            "review_candidates_kept_separate": 314,
            "preimport_counts": protected,
            "preexisting_marrow_test_ids": [row["id"] for row in tests],
            "preexisting_marrow_question_ids": [row["question_id"] for row in payloads],
            "rpc_subject_batches_validated": len(rpc_results),
            "remaining_deltas": remaining_deltas,
            "idempotent_noop": all(delta == 0 for delta in remaining_deltas.values()),
            "independent_pyq_plan": plan,
            "production_apply_ready": True}


def upload_objects(url: str, key: str, paths: list[str], object_bytes: dict[str, bytes]) -> list[str]:
    uploaded = []
    for path in paths:
        content = object_bytes[path]
        encoded = urllib.parse.quote(path, safe="/")
        try:
            existing, _ = api_request(url, key, f"/storage/v1/object/authenticated/{BUCKET}/{encoded}")
            if hashlib.sha256(existing).hexdigest() != hashlib.sha256(content).hexdigest():
                raise ValueError(f"existing storage object conflicts: {path}")
            continue
        except RuntimeError as error:
            if "(400)" not in str(error) and "(404)" not in str(error):
                raise
        api_request(url, key, f"/storage/v1/object/{BUCKET}/{encoded}", "POST", content,
                    {"Content-Type": "application/gzip", "x-upsert": "false", "Cache-Control": "31536000"})
        uploaded.append(path)
    return uploaded


def delete_storage_objects(url: str, key: str, paths: list[str]) -> None:
    if paths:
        api_request(url, key, f"/storage/v1/object/{BUCKET}", "DELETE",
                    stable_json({"prefixes": paths}).encode(), {"Content-Type": "application/json"})


def apply_production(doc: dict, url: str, key: str, batch: str, backup_dir: Path) -> dict:
    if batch != BATCH_ID:
        raise ValueError("exact production batch ID is required")
    preflight = production_dry_run(doc, url, key)
    backup = create_production_backup(doc, preflight, backup_dir)
    manifests, object_bytes = production_payloads(doc)
    results, uploaded_all = [], []
    for subject, manifest in manifests.items():
        uploaded_subject = []
        try:
            run = rpc(url, key, "qbank_begin_marrow_pyq_import", {"p_manifest": manifest})
            paths = [row["object_path"] for row in manifest["objects"]]
            uploaded_subject = upload_objects(url, key, paths, object_bytes)
            commit = rpc(url, key, "qbank_commit_marrow_pyq_import", {"p_manifest": manifest, "p_dry_run": False})
            uploaded_all.extend(uploaded_subject)
            results.append({"subject": subject, "run": run, "commit": commit, "uploaded": len(uploaded_subject)})
        except Exception:
            delete_storage_objects(url, key, uploaded_subject)
            raise
    return {"batch_id": batch, "backup_manifest": str(backup), "subject_batches": results,
            "uploaded_objects": len(uploaded_all)}


def rollback_production(url: str, key: str, batch: str) -> dict:
    if batch != BATCH_ID:
        raise ValueError("exact production batch ID is required")
    url = validate_production_url(url)
    if not key:
        raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required")
    result = rpc(url, key, "qbank_rollback_marrow_pyq_batch", {"p_batch_id": batch})
    delete_storage_objects(url, key, result.get("storage_object_paths") or [])
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, default=Path("import-reports/marrow-pyq-stage-v1.json.gz"))
    parser.add_argument("--local-db", type=Path)
    parser.add_argument("--apply-local", action="store_true")
    parser.add_argument("--rollback-local", action="store_true")
    parser.add_argument("--fail-after-subjects", type=int)
    parser.add_argument("--production-dry-run", "--dry-run-production", action="store_true")
    parser.add_argument("--apply-production", action="store_true")
    parser.add_argument("--batch")
    parser.add_argument("--rollback-batch")
    parser.add_argument("--backup-out", type=Path,
                        help="local read-only production pre-import manifest path")
    parser.add_argument("--url", default=DEFAULT_URL)
    args = parser.parse_args()
    doc = load_artifact(args.artifact)
    modes = sum(bool(x) for x in (args.production_dry_run, args.apply_production, args.rollback_batch,
                                  args.apply_local, args.rollback_local))
    if modes > 1:
        parser.error("choose exactly one apply, rollback or dry-run mode")
    if modes == 0 and not args.local_db:
        args.production_dry_run = True
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if args.apply_production:
        if not args.batch:
            parser.error("--apply-production requires --batch")
        backup_dir = args.backup_out or Path("import-reports/backups") / BATCH_ID
        result = apply_production(doc, args.url, key, args.batch, backup_dir)
    elif args.rollback_batch:
        result = rollback_production(args.url, key, args.rollback_batch)
    elif args.production_dry_run:
        if args.apply_local or args.rollback_local:
            parser.error("production dry-run cannot be combined with local writes")
        result = production_dry_run(doc, args.url, key)
        if args.backup_out:
            backup = create_production_backup(doc, result, args.backup_out)
            result["backup_manifest"] = str(backup)
    elif args.local_db:
        conn = open_local(args.local_db, doc)
        if args.apply_local:
            backup_manifest(conn, args.local_db, doc)
            result = apply_local(conn, doc, args.fail_after_subjects)
        elif args.rollback_local:
            backup = json.loads(args.local_db.with_suffix(".preimport.json").read_text())
            result = rollback_local(conn, backup)
        else:
            result = {"validated": True, "writes": 0, "counts": table_counts(conn)}
    else:
        result = {"validated": True, "writes": 0, "summary": doc["summary"]}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
