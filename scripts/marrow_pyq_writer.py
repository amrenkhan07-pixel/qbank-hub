#!/usr/bin/env python3
"""Fail-closed Marrow PYQ writer: isolated SQLite validation and production dry-run only.

No production apply adapter exists. The local database exercises the intended
subject-transaction, checkpoint, idempotency and rollback contract.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sqlite3
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

BATCH_ID = "marrow-pyq-v1-20260920"
ARTIFACT_SHA256 = "c3ee2697542afacd49d3931c71ec05f010190394dd2196252ff0c0efc132f76a"
EXPECTED = {"staged_occurrences": 5938, "source_tests": 342,
            "marrow_content_versions": 5914, "new_canonical_identity_proposals": 5852}
EXPECTED_REVIEW = 314
EXPECTED_SUBJECTS = 19
DEFAULT_URL = "https://flulljensjugfcxmeczu.supabase.co"


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


def production_dry_run(doc: dict, url: str, key: str) -> dict:
    if not key:
        raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required for read-only dry-run")
    url = url.rstrip("/")
    platforms, _ = api_get(url, key, "platforms", "select=id,name&name=eq.Marrow&limit=2")
    if len(platforms) != 1:
        raise ValueError("Marrow platform must resolve uniquely")
    platform_id = platforms[0]["id"]
    tests, tests_count = api_get(url, key, "qbank_source_tests", "select=id&platform_id=eq." + urllib.parse.quote(platform_id) + "&limit=1")
    payloads, payload_count = api_get(url, key, "qbank_question_payloads", "select=question_id&platform_id=eq." + urllib.parse.quote(platform_id) + "&limit=1")
    _, prep_count = api_get(url, key, "qbank_question_payloads", "select=question_id&limit=1")
    _, _ = api_get(url, key, "canonical_question_versions", "select=question_id&limit=1")
    if tests_count != 0 or payload_count != 0 or prep_count != doc["db_snapshot"]["payloads"]:
        raise ValueError("production changed since staging; refresh and restage before apply")
    matched_ids = sorted({v["matched_prepladder_question_id"] for v in doc["content_versions"]
                          if v["matched_prepladder_question_id"]})
    found_ids = set()
    for start in range(0, len(matched_ids), 50):
        chunk = matched_ids[start:start + 50]
        query = "select=question_id&question_id=in.(" + ",".join(chunk) + ")&limit=50"
        rows, _ = api_get(url, key, "qbank_question_payloads", query)
        found_ids.update(r["question_id"] for r in rows)
    if found_ids != set(matched_ids):
        raise ValueError("matched PrepLadder payload IDs changed since staging")
    protected = {}
    for table in ("questions", "qbank_source_tests", "qbank_source_occurrences",
                  "question_attempts", "test_sessions", "user_question_state", "bookmarks"):
        _, count = api_get(url, key, table, "select=*&limit=0")
        protected[table] = count
    return {"authenticated": True, "writes": 0, "platform_id": platform_id,
            "existing_marrow_tests": tests_count, "existing_marrow_versions": payload_count,
            "existing_total_payloads": prep_count,
            "expected_new_tests": 342, "expected_new_versions": 5914,
            "expected_new_occurrences": 5938, "expected_new_identity_proposals": 5852,
            "review_candidates_kept_separate": 314,
            "matched_prepladder_ids_verified": len(found_ids),
            "preimport_counts": protected,
            "production_apply_ready": False,
            "reason": "No branch-validated Postgres apply adapter or rollback yet"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, default=Path("import-reports/marrow-pyq-stage-v1.json.gz"))
    parser.add_argument("--local-db", type=Path)
    parser.add_argument("--apply-local", action="store_true")
    parser.add_argument("--rollback-local", action="store_true")
    parser.add_argument("--fail-after-subjects", type=int)
    parser.add_argument("--production-dry-run", action="store_true")
    parser.add_argument("--backup-out", type=Path,
                        help="local read-only production pre-import manifest path")
    parser.add_argument("--url", default=DEFAULT_URL)
    args = parser.parse_args()
    doc = load_artifact(args.artifact)
    if args.production_dry_run:
        if args.apply_local or args.rollback_local:
            parser.error("production dry-run cannot be combined with local writes")
        result = production_dry_run(doc, args.url, os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""))
        if args.backup_out:
            manifest = {"batch_id": BATCH_ID, "artifact_sha256": ARTIFACT_SHA256,
                        "project_url": args.url, "read_only": True, "production": result,
                        "matched_prepladder_question_ids": sorted({v["matched_prepladder_question_id"]
                            for v in doc["content_versions"] if v["matched_prepladder_question_id"]}),
                        "preexisting_canonical_identity_ids": sorted({v["proposed_canonical_question_id"]
                            for v in doc["content_versions"] if v["canonical_identity_already_exists"]}),
                        "preexisting_marrow_test_ids": [], "preexisting_marrow_occurrence_keys": []}
            args.backup_out.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")))
            result["backup_manifest"] = str(args.backup_out)
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
