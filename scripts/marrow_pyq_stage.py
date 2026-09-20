#!/usr/bin/env python3
"""Deterministic, read-only Marrow PYQ staging. No database-write path exists here."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Optional

from marrow_pyq_audit import exam_metadata, match_key, normalized, subject_name
from prepladder_import import canonical_payload, canonical_subject, clean_text, correct_keys, deterministic_uuid, extract_folder_tree, iter_source_tests, slug, stable_json

VERSION = "marrow-pyq-stage-v1"
PLATFORM = "Marrow"
SOURCE_TYPE = "PYQ"
OP_NEW = "NEW_IDENTITY_NEW_VERSION"
OP_MATCH = "EXISTING_IDENTITY_NEW_MARROW_VERSION"
OP_REPEAT = "EXISTING_MARROW_VERSION_NEW_OCCURRENCE"
OP_PRESENT = "EXACT_ALREADY_PRESENT"
OP_REVIEW = "REVIEW_IDENTITY_CANDIDATE"
OP_INVALID = "INVALID / QUARANTINE"


def sha(value: object) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def prep_index(cache: Path) -> dict:
    core = defaultdict(set)
    stem = defaultdict(set)
    count = 0
    for path in sorted(cache.glob("*.json")):
        document = json.loads(path.read_text())
        subject = canonical_subject(str(document["subject"]))
        for payload in document.get("questions") or []:
            content_hash = sha(payload)
            qid = deterministic_uuid("question", f"PrepLadder|{subject}|{content_hash}")
            core[(subject, match_key(payload))].add(qid)
            stem[(subject, normalized(payload["question_html"]))].add(qid)
            count += 1
    return {"core": core, "stem": stem, "count": count}


def validate_question(question: object) -> list[str]:
    if not isinstance(question, dict):
        return ["not_an_object"]
    errors = []
    if not str(question.get("id") or "").strip():
        errors.append("missing_source_question_id")
    if not clean_text(question.get("raw_text") or question.get("text")):
        errors.append("missing_stem")
    options = question.get("options")
    if not isinstance(options, list) or not 2 <= len(options) <= 8 or any(not isinstance(x, dict) for x in options):
        errors.append("malformed_options")
        return errors
    labels = [str(x.get("label") or "").upper() for x in options]
    if len(labels) != len(set(labels)) or any(not clean_text(x.get("text")) for x in options):
        errors.append("invalid_options")
    answers = correct_keys(question)
    if not answers or any(x not in labels for x in answers):
        errors.append("missing_or_invalid_answer")
    if not clean_text(question.get("explanation")):
        errors.append("missing_explanation")
    return errors


def stage(source: Path, cache: Path, canonical_snapshot: dict, db_state: dict) -> dict:
    if db_state.get("project_id") != canonical_snapshot.get("project_id"):
        raise ValueError("snapshot project mismatch")
    if not db_state.get("read_only") or not canonical_snapshot.get("read_only"):
        raise ValueError("snapshots must be read-only")
    prep = prep_index(cache)
    if prep["count"] != db_state["payloads"]:
        raise ValueError("local PrepLadder payload cache differs from live payload count")
    canonical = {row["question_id"]: row["canonical_question_id"] for row in canonical_snapshot["canonical_versions"]}
    if len(canonical) != db_state.get("canonical_versions"):
        raise ValueError("live canonical-link count differs from snapshot")
    existing_occurrence_keys = set(db_state.get("marrow_occurrence_keys") or [])
    existing_version_keys = {tuple(x) for x in db_state.get("marrow_content_keys") or []}
    if len(existing_occurrence_keys) != db_state.get("marrow_occurrences"):
        raise ValueError("existing Marrow occurrence snapshot incomplete")
    if len(existing_version_keys) != db_state.get("marrow_payloads"):
        raise ValueError("existing Marrow payload snapshot incomplete")

    tree = extract_folder_tree(source)
    declared = {str(t.get("id")): t for folder in tree.get("folders") or [] for t in folder.get("tests") or []}
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    source_tests, versions, occurrences = [], {}, []
    source_ids, source_id_hashes = defaultdict(list), defaultdict(set)
    first_version = set()
    for sequence, test in enumerate(iter_source_tests(source), 1):
        test_id = str(test.get("id") or "").strip()
        title = str(test.get("title") or "")
        subject = subject_name(str((test.get("path") or [""])[0]))
        meta = exam_metadata(title)
        questions = test.get("questions") or []
        if test_id not in declared or int(declared[test_id].get("num_questions") or 0) != len(questions):
            raise ValueError(f"tree/test mismatch: {test_id}")
        test_key = sha([PLATFORM, subject, test_id])
        test_uuid = deterministic_uuid("source-test", test_key)
        source_tests.append({"id": test_uuid, "stable_key": test_key, "platform": PLATFORM,
                             "source_type": SOURCE_TYPE, "subject": subject, "sequence": sequence,
                             "source_test_id": test_id, "source_test_title": title,
                             "raw_source_title": title, "source_path": test.get("path") or [],
                             "exam_family": meta["exam"], "year": meta["year"], "session": meta["session"],
                             "declared_question_count": len(questions)})
        for position, question in enumerate(questions, 1):
            errors = validate_question(question)
            qid = str(question.get("id") or "") if isinstance(question, dict) else ""
            if errors:
                occurrences.append({"operation": OP_INVALID, "source_test_id": test_id,
                                    "source_test_uuid": test_uuid, "question_order_within_test": position,
                                    "source_question_id": qid, "reasons": errors})
                continue
            payload = canonical_payload(question)
            full_hash = sha(payload)
            core_hash = match_key(payload)
            stem_key = normalized(payload["question_html"])
            version_key = (subject, full_hash)
            version_id = deterministic_uuid("question", f"Marrow|{subject}|{full_hash}")
            occurrence_key = sha([test_key, position, qid, full_hash])
            source_ids[qid].append((test_id, position))
            # Formatting-only source differences are not a conflicting answer.
            # Keep their raw payload versions distinct while checking the
            # medically relevant normalized full content for ID conflicts.
            source_id_hashes[qid].add(match_key(payload, True))
            matches = sorted(prep["core"].get((subject, core_hash), set()))
            stem_matches = sorted(prep["stem"].get((subject, stem_key), set()))
            reason = None
            if len(matches) > 1:
                operation, reason = OP_REVIEW, "multiple_exact_core_prep_versions"
            elif len(matches) == 1:
                operation = OP_MATCH
            elif stem_matches:
                operation, reason = OP_REVIEW, "stem_only_match"
            else:
                operation = OP_NEW
            if version_key not in versions:
                existing_question_id = matches[0] if len(matches) == 1 else None
                existing_canonical_id = canonical.get(existing_question_id) if existing_question_id else None
                proposed_identity_id = existing_canonical_id or deterministic_uuid(
                    "canonical-question", existing_question_id if existing_question_id else f"Marrow|{subject}|{core_hash}")
                versions[version_key] = {"question_id": version_id, "platform": PLATFORM,
                    "subject": subject, "source_type": SOURCE_TYPE, "content_sha256": full_hash,
                    "already_present": (subject, full_hash) in existing_version_keys,
                    "first_source_test_uuid": test_uuid, "first_source_test_id": test_id,
                    "core_sha256": core_hash, "normalized_stem": stem_key,
                    "raw_stem": str(question.get("raw_text") or question.get("text") or ""),
                    "payload": payload, "source_question_id_first_seen": qid,
                    # Review candidates receive their own Marrow identity for
                    # safe ingestion; no PrepLadder identity is merged yet.
                    "proposed_canonical_question_id": proposed_identity_id,
                    "matched_prepladder_question_id": existing_question_id,
                    "canonical_identity_already_exists": bool(existing_canonical_id),
                    "review_reason": reason}
            if occurrence_key in existing_occurrence_keys:
                operation, reason = OP_PRESENT, None
            elif operation == OP_REVIEW:
                # Every occurrence of an unresolved version stays gated,
                # including a byte-identical repeat in another exam/test.
                first_version.add(version_key)
            elif version_key in first_version:
                operation, reason = OP_REPEAT, None
            else:
                first_version.add(version_key)
            occurrences.append({"operation": operation, "reason": reason,
                "id": deterministic_uuid("occurrence", occurrence_key), "occurrence_key": occurrence_key,
                "platform": PLATFORM, "source_type": SOURCE_TYPE, "subject": subject,
                "exam_family": meta["exam"], "year": meta["year"], "session": meta["session"],
                "source_test_id": test_id, "source_test_uuid": test_uuid,
                "source_test_title": title, "raw_source_title": title,
                "question_order_within_test": position, "source_question_id": qid,
                "question_id": version_id, "content_sha256": full_hash,
                "core_sha256": core_hash, "matched_prepladder_question_ids": matches,
                "stem_candidate_count": len(stem_matches) if reason == "stem_only_match" else 0})
    for qid, hashes in source_id_hashes.items():
        if len(hashes) > 1:
            raise ValueError(f"repeated Marrow source ID has conflicting content: {qid}")
    counts = Counter(o["operation"] for o in occurrences)
    reasons = Counter(o.get("reason") for o in occurrences if o["operation"] == OP_REVIEW)
    new_identity_ids = {v["proposed_canonical_question_id"] for v in versions.values()
                        if not v["canonical_identity_already_exists"]}
    marrow_only_identity_ids = {v["proposed_canonical_question_id"] for v in versions.values()
                                if not v["matched_prepladder_question_id"]}
    return {"version": VERSION, "read_only": True, "production_writes": 0,
        "source_sha256": source_hash, "source_filename": source.name,
        "db_project_id": db_state["project_id"], "db_snapshot": {k:v for k,v in db_state.items() if k != "marrow_occurrence_keys"},
        "cache_payload_count": prep["count"],
        "summary": {"staged_occurrences": len(occurrences), "source_tests": len(source_tests),
                    "marrow_content_versions": len(versions),
                    "new_marrow_content_versions": sum(not v["already_present"] for v in versions.values()),
                    "operation_counts": dict(sorted(counts.items())),
                    "review_reasons": dict(sorted(reasons.items())),
                    "repeated_source_id_groups": sum(len(v)>1 for v in source_ids.values()),
                    "repeated_source_id_extra_occurrences": sum(len(v)-1 for v in source_ids.values()),
                    "new_canonical_identity_proposals": len(new_identity_ids),
                    "new_marrow_only_identity_proposals": len(marrow_only_identity_ids),
                    "matched_prep_question_versions": sum(bool(v["matched_prepladder_question_id"]) for v in versions.values()),
                    "matched_existing_canonical_versions": sum(bool(v["canonical_identity_already_exists"]) for v in versions.values()),
                    "matched_prep_versions_needing_new_canonical_identity": sum(bool(v["matched_prepladder_question_id"]) and not v["canonical_identity_already_exists"] for v in versions.values())},
        "source_tests": source_tests, "content_versions": list(versions.values()), "occurrences": occurrences}


def write_artifact(document: dict, output: Path) -> str:
    raw = stable_json(document).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.suffix == ".gz":
        output.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    else:
        output.write_bytes(raw)
    return hashlib.sha256(output.read_bytes()).hexdigest()


def materialize_payload_objects(document: dict, directory: Path) -> None:
    """Write local per-test gzip objects; never upload them."""
    grouped = defaultdict(list)
    tests = {test["id"]: test for test in document["source_tests"]}
    for version in document["content_versions"]:
        grouped[version["first_source_test_uuid"]].append(version)
    objects = []
    for test in document["source_tests"]:
        versions = grouped[test["id"]]
        raw = stable_json({"schema_version": 1, "platform": PLATFORM,
                           "subject": test["subject"], "source_test": {
                               "id": test["source_test_id"], "title": test["source_test_title"]},
                           "questions": [v["payload"] for v in versions]}).encode()
        compressed = gzip.compress(raw, compresslevel=9, mtime=0)
        object_hash = hashlib.sha256(compressed).hexdigest()
        object_path = f"marrow-pyq/{slug(test['subject'])}/{slug(test['source_test_id'])}/{object_hash}.json.gz"
        local_path = directory / object_path
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(compressed)
        object_id = deterministic_uuid("payload-object", object_path)
        objects.append({"id": object_id, "object_path": object_path,
                        "sha256": object_hash, "uncompressed_sha256": hashlib.sha256(raw).hexdigest(),
                        "raw_bytes": len(raw), "stored_bytes": len(compressed),
                        "question_count": len(versions), "compression": "gzip",
                        "source_test_id": test["id"]})
        for index, version in enumerate(versions):
            version["payload_object_id"] = object_id
            version["payload_index"] = index
    document["payload_objects"] = objects
    document["summary"]["payload_objects"] = len(objects)
    document["summary"]["payload_object_bytes"] = sum(x["stored_bytes"] for x in objects)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="?")
    parser.add_argument("--prepladder-cache", type=Path)
    parser.add_argument("--canonical-snapshot", type=Path)
    parser.add_argument("--db-state", type=Path)
    parser.add_argument("--rehydrate-artifact", type=Path,
                        help="recreate local payload objects from a saved staged artifact, without re-parsing")
    parser.add_argument("--output", type=Path, default=Path("/tmp/qbank-marrow-pyq-stage-v1.json.gz"))
    parser.add_argument("--object-dir", type=Path, default=Path("/tmp/qbank-marrow-payload-objects-v1"))
    args = parser.parse_args()
    if args.rehydrate_artifact:
        data = args.rehydrate_artifact.read_bytes()
        result = json.loads(gzip.decompress(data) if args.rehydrate_artifact.suffix == ".gz" else data)
        if result.get("version") != VERSION or not result.get("read_only"):
            raise ValueError("invalid staged artifact")
        expected = result["payload_objects"]
        materialize_payload_objects(result, args.object_dir)
        if result["payload_objects"] != expected:
            raise ValueError("rehydrated object manifest mismatch")
        print(json.dumps({"rehydrated_objects": len(expected), "object_dir": str(args.object_dir),
                          "artifact_sha256": hashlib.sha256(data).hexdigest()}, indent=2))
        return
    if not all((args.source, args.prepladder_cache, args.canonical_snapshot, args.db_state)):
        parser.error("source, --prepladder-cache, --canonical-snapshot and --db-state are required for staging")
    result = stage(args.source, args.prepladder_cache,
                   json.loads(args.canonical_snapshot.read_text()), json.loads(args.db_state.read_text()))
    materialize_payload_objects(result, args.object_dir)
    checksum = write_artifact(result, args.output)
    print(json.dumps({"summary": result["summary"], "artifact": str(args.output),
                      "artifact_sha256": checksum, "bytes": args.output.stat().st_size,
                      "object_dir": str(args.object_dir)}, indent=2))


if __name__ == "__main__":
    main()
