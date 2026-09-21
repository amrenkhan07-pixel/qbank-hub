#!/usr/bin/env python3
"""Fail-closed, resumable Core BTR production writer. Dry-run is the default."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import urllib.parse
from collections import defaultdict
from pathlib import Path

try:
    from .marrow_pyq_writer import api_all, api_get, api_request, delete_storage_objects, rpc, stable_json
except ImportError:
    from marrow_pyq_writer import api_all, api_get, api_request, delete_storage_objects, rpc, stable_json

BATCH_ID = "core-btr-v1-20260922"
ARTIFACT_SHA256 = "c9f5de705de40ef4d07608e90003b1752eae18616725c3c049acf9781ea32817"
PROJECT_REF = "flulljensjugfcxmeczu"
DEFAULT_URL = f"https://{PROJECT_REF}.supabase.co"
BUCKET = "qbank-payloads"
IMPORTER_VERSION = "core-btr-writer-v1"


def validate_url(url: str) -> str:
    normalized = url.rstrip("/")
    if urllib.parse.urlparse(normalized).hostname != f"{PROJECT_REF}.supabase.co":
        raise ValueError("wrong production Supabase project")
    return normalized


def load_artifact(path: Path) -> dict:
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != ARTIFACT_SHA256:
        raise ValueError(f"artifact checksum mismatch: {digest}")
    doc = json.loads(gzip.decompress(data))
    summary = doc.get("summary") or {}
    expected = {"source_tests": 284, "source_occurrences": 19137, "unique_content": 14066,
                "effective_top_level_sections": 27, "quarantine": 0, "payload_objects": 67}
    if doc.get("version") != "core-btr-stage-v1" or not doc.get("read_only") or doc.get("production_writes") != 0:
        raise ValueError("unexpected Core BTR artifact identity")
    if any(summary.get(key) != value for key, value in expected.items()):
        raise ValueError("Core BTR staged counts changed")
    if len(doc["source_tests"]) != 284 or len(doc["content_versions"]) != 14066 or len(doc["occurrences"]) != 19137:
        raise ValueError("Core BTR artifact arrays disagree with summary")
    if any(x["source_path"][:2] == ["Neurology", "Cardiovascular System"] for x in doc["source_tests"]):
        raise ValueError("Cardiovascular System remains nested under Neurology")
    return doc


def version_row(version: dict) -> dict:
    payload = version["payload"]
    media = payload.get("media") or []
    q_media = any(x.get("placement") == "question" for x in media)
    e_media = any(x.get("placement") == "explanation" for x in media)
    return {
        "question_id": version["question_id"], "subject": version["analytics_subject"],
        "source_question_id": version["source_question_id_first_seen"],
        "content_sha256": version["content_sha256"],
        "stem_excerpt": payload["question_html"][:1000],
        "correct_option_keys": payload["correct_keys"], "option_count": len(payload["options"]),
        "is_multi_correct": len(payload["correct_keys"]) > 1,
        "media_status": "MEDIA_REFERENCED" if media else "NO_MEDIA",
        "has_question_media": q_media, "has_explanation_media": e_media,
        "has_audio": bool(payload.get("audio")), "has_video": bool(payload.get("video")),
        "video_url": payload.get("video"), "audio_url": payload.get("audio"),
        "payload_object_id": version["payload_object_id"], "payload_index": version["payload_index"],
        "first_source_test_title": version["first_source_test_title"],
        "is_core_btr_pyq": version["is_core_btr_pyq"], "is_zv_recommended": version["is_zv_recommended"],
        "in_topic_test": version["in_topic_test"], "in_all_qbank": version["in_all_qbank"],
        "membership_count": version["membership_count"],
        "high_value_membership_count": version["high_value_membership_count"],
        "is_hit_list": version["is_hit_list"],
    }


def manifests(doc: dict) -> dict[str, dict]:
    tests = defaultdict(list); versions = defaultdict(list); occurrences = defaultdict(list); objects = defaultdict(list)
    subject_by_test = {}
    for row in doc["source_tests"]:
        subject = row["analytics_subject"]
        subject_by_test[row["id"]] = subject
        tests[subject].append({"id": row["id"], "stable_key": row["stable_key"], "subject": subject,
            "source_test_id": row["source_test_id"], "title": row["source_test_title"],
            "sequence": row["sequence"], "declared_question_count": row["declared_question_count"],
            "source_section": row["source_section"], "source_path": row["source_path"],
            "collection_type": row["collection_type"]})
    for row in doc["content_versions"]:
        versions[row["analytics_subject"]].append(version_row(row))
    for row in doc["occurrences"]:
        subject = row["analytics_subject"]
        occurrences[subject].append({"id": row["id"], "occurrence_key": row["occurrence_key"],
            "subject": subject, "source_test_id": row["source_test_uuid"], "question_id": row["question_id"],
            "source_question_id": row["source_question_id"],
            "question_position": row["question_order_within_test"], "content_sha256": row["content_sha256"]})
    for row in doc["payload_objects"]:
        objects[subject_by_test[row["source_test_id"]]].append(row)
    result = {}
    for subject in sorted(tests):
        result[subject] = {"batch_id": BATCH_ID, "platform": "Core BTR", "source_type": "CORE_BTR",
            "subject": subject, "source_filename": doc["source_filename"], "source_sha256": doc["source_sha256"],
            "source_bytes": doc["source_bytes"], "importer_version": IMPORTER_VERSION, "schema_version": 1,
            "source_test_count": len(tests[subject]), "content_version_count": len(versions[subject]),
            "occurrence_count": len(occurrences[subject]), "payload_object_count": len(objects[subject]),
            "payload_stored_bytes": sum(x["stored_bytes"] for x in objects[subject]),
            "source_tests": tests[subject], "versions": versions[subject],
            "occurrences": occurrences[subject], "objects": objects[subject]}
    return result


def preflight(doc: dict, url: str, key: str) -> dict:
    if not key:
        raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required")
    url = validate_url(url)
    projects, _ = api_get(url, key, "platforms", "select=id,name&name=eq.Core%20BTR&limit=2")
    subject_names = sorted({x["analytics_subject"] for x in doc["source_tests"]})
    encoded = urllib.parse.quote("(" + ",".join(f'\"{x}\"' for x in subject_names) + ")", safe="(),\"")
    subjects = api_all(url, key, "subjects", "select=id,name&name=in." + encoded)
    if {x["name"] for x in subjects} != set(subject_names):
        raise ValueError("production subject vocabulary does not cover Core BTR analytics mapping")
    existing = {"tests": 0, "questions": 0, "occurrences": 0, "payload_objects": 0, "runs": 0}
    if projects:
        platform_id = projects[0]["id"]
        test_rows = api_all(url,key,"qbank_source_tests","select=id&platform_id=eq."+platform_id)
        question_rows = api_all(url,key,"qbank_question_payloads","select=question_id&platform_id=eq."+platform_id)
        existing["tests"] = len(test_rows)
        existing["questions"] = len(question_rows)
        runs = api_all(url,key,"qbank_hybrid_import_runs","select=id&platform=eq.Core%20BTR")
        existing["runs"] = len(runs)
        object_rows = [row for run in runs for row in api_all(url,key,"qbank_payload_objects","select=id&import_run_id=eq."+run["id"])]
        existing["payload_objects"] = len(object_rows)
        expected_test_ids = {x["id"] for x in doc["source_tests"]}
        expected_question_ids = {x["question_id"] for x in doc["content_versions"]}
        if not {x["id"] for x in test_rows} <= expected_test_ids or not {x["question_id"] for x in question_rows} <= expected_question_ids:
            raise ValueError("production contains non-staged Core BTR rows")
        owned = api_all(url,key,"qbank_import_batch_records",
                        "select=entity_type,entity_key&batch_id=eq."+urllib.parse.quote(BATCH_ID))
        owned_keys = {(x["entity_type"],x["entity_key"]) for x in owned}
        expected = {"source_test": expected_test_ids, "question": expected_question_ids,
            "question_payload": expected_question_ids,
            "payload_object": {x["id"] for x in doc["payload_objects"]},
            "source_occurrence": {x["id"] for x in doc["occurrences"]}}
        if any(x["entity_type"] != "import_run" and x["entity_key"] not in expected.get(x["entity_type"],set()) for x in owned):
            raise ValueError("batch ownership contains a non-staged Core BTR entity")
        if any(("source_test",x["id"]) not in owned_keys for x in test_rows) or \
           any(("question_payload",x["question_id"]) not in owned_keys for x in question_rows) or \
           any(("payload_object",x["id"]) not in owned_keys for x in object_rows) or \
           any(("import_run",x["id"]) not in owned_keys for x in runs):
            raise ValueError("existing Core BTR rows are not owned by this batch")
        existing["occurrences"] = sum(x["entity_type"] == "source_occurrence" for x in owned)
    protected = {}
    for table in ("questions","qbank_source_tests","qbank_source_occurrences","question_attempts",
                  "user_question_state","bookmarks","test_sessions"):
        _, protected[table] = api_get(url,key,table,"select=*&limit=0")
    projected = {"import_runs": len(manifests(doc)), "source_tests": 284, "storage_objects": 67,
        "payload_objects": 67, "questions": 14066, "payload_indexes": 14066,
        "source_occurrences": 19137, "canonical_links": 0}
    return {"project_ref": PROJECT_REF, "authenticated": True, "writes": 0,
            "batch_id": BATCH_ID, "existing_core_btr": existing, "protected_counts": protected,
            "subjects": len(subject_names), "projected_deltas": projected,
            "payload_stored_bytes": doc["summary"]["payload_stored_bytes"], "production_apply_ready": True}


def create_backup(doc: dict, result: dict, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "affected-slice-manifest.json"
    manifest = {"batch_id": BATCH_ID, "artifact_sha256": ARTIFACT_SHA256, "project_ref": PROJECT_REF,
        "created_before_import": True, "preimport_counts": result["protected_counts"],
        "planned_test_ids": sorted(x["id"] for x in doc["source_tests"]),
        "planned_question_ids": sorted(x["question_id"] for x in doc["content_versions"]),
        "planned_occurrence_keys": sorted(x["occurrence_key"] for x in doc["occurrences"])}
    if target.exists() and json.loads(target.read_text()) != manifest:
        raise ValueError("backup directory contains a different Core BTR manifest")
    target.write_text(stable_json(manifest))
    return target


def payload_bytes(doc: dict, artifact: Path) -> dict[str, bytes]:
    root = artifact.parent / "core-btr-payloads-v1"
    result = {}
    for row in doc["payload_objects"]:
        path = root / row["object_path"]
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ValueError(f"payload checksum mismatch: {path}")
        result[row["object_path"]] = data
    return result


def apply(doc: dict, artifact: Path, url: str, key: str, batch: str, backup_dir: Path) -> dict:
    if batch != BATCH_ID:
        raise ValueError("exact Core BTR batch ID is required")
    result = preflight(doc,url,key)
    result["backup_manifest"] = str(create_backup(doc,result,backup_dir))
    blobs = payload_bytes(doc,artifact)
    dry_runs = [rpc(url,key,"qbank_commit_core_btr_import",{"p_manifest":manifest,"p_dry_run":True})
                for manifest in manifests(doc).values()]
    if len(dry_runs) != 19 or any(row.get("status") != "dry_run" for row in dry_runs):
        raise ValueError("Core BTR production RPC dry-run did not validate all subject batches")
    completed = []
    for subject, manifest in manifests(doc).items():
        run_id = rpc(url,key,"qbank_begin_core_btr_import",{"p_manifest":manifest})
        uploaded = []
        try:
            for row in manifest["objects"]:
                path = row["object_path"]; encoded = urllib.parse.quote(path,safe="/")
                try:
                    existing, _ = api_request(url,key,f"/storage/v1/object/authenticated/{BUCKET}/{encoded}")
                    if hashlib.sha256(existing).hexdigest() != row["sha256"]:
                        raise ValueError(f"existing object conflicts: {path}")
                except RuntimeError as error:
                    if "(400)" not in str(error) and "(404)" not in str(error): raise
                    api_request(url,key,f"/storage/v1/object/{BUCKET}/{encoded}","POST",blobs[path],
                                {"Content-Type":"application/gzip","x-upsert":"false","Cache-Control":"31536000"})
                    uploaded.append(path)
            commit = rpc(url,key,"qbank_commit_core_btr_import",{"p_manifest":manifest,"p_dry_run":False})
            completed.append({"subject":subject,"run":run_id,"commit":commit,"uploaded":len(uploaded)})
        except Exception:
            delete_storage_objects(url,key,uploaded)
            raise
    return {"batch_id":BATCH_ID,"backup_manifest":result["backup_manifest"],"subject_batches":completed}


def rollback(url: str, key: str, batch: str) -> dict:
    if batch != BATCH_ID: raise ValueError("exact Core BTR batch ID is required")
    result = rpc(validate_url(url),key,"qbank_rollback_core_btr_batch",{"p_batch_id":batch})
    delete_storage_objects(url,key,result.get("storage_object_paths") or [])
    return result


def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact",type=Path,default=Path("import-reports/core-btr-stage-v1.json.gz"))
    parser.add_argument("--dry-run-production",action="store_true")
    parser.add_argument("--apply-production",action="store_true")
    parser.add_argument("--batch")
    parser.add_argument("--rollback-batch")
    parser.add_argument("--backup-out",type=Path,default=Path("import-reports/backups/core-btr-v1-20260922"))
    parser.add_argument("--url",default=DEFAULT_URL)
    args=parser.parse_args()
    if sum(bool(x) for x in (args.dry_run_production,args.apply_production,args.rollback_batch))>1:
        parser.error("choose one mode")
    doc=load_artifact(args.artifact); key=os.environ.get("SUPABASE_SERVICE_ROLE_KEY","")
    if args.apply_production:
        output=apply(doc,args.artifact,args.url,key,args.batch,args.backup_out)
    elif args.rollback_batch:
        output=rollback(args.url,key,args.rollback_batch)
    else:
        output=preflight(doc,args.url,key)
        output["backup_manifest"]=str(create_backup(doc,output,args.backup_out))
    print(json.dumps(output,indent=2))


if __name__=="__main__": main()
