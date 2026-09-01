#!/usr/bin/env python3
"""Storage-efficient, two-phase PrepLadder importer.

Dry-run is the default. The master HTML is parsed locally with bounded memory,
one source-test payload is emitted per object, and exact content versions are
deduplicated without losing source occurrences or order.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import html
import json
import mmap
import os
import re
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple


VERSION = "1.0.0"
SCHEMA_VERSION = 1
PLATFORM = "PrepLadder"
DEFAULT_SUBJECT = "Anaesthesia"
ANAESTHESIA_ALIASES = {"anaesthesia", "anesthesia", "anaesthesiology", "anesthesiology", "anasthesia"}
DEFAULT_URL = "https://flulljensjugfcxmeczu.supabase.co"
BUCKET = "qbank-payloads"
NAMESPACE = uuid.UUID("58a63f95-2078-4a4d-aa42-a8d660ef1317")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
KNOWN_TEST_FIELDS = {"id", "title", "num_questions", "total_marks", "duration", "time_per_question", "questions", "build_id", "path"}
KNOWN_QUESTION_FIELDS = {"id", "text", "raw_text", "options", "correct_answer", "question_images", "explanation_images", "explanation", "bot", "video", "audio"}
SOURCE_MARKERS = (b"const FOLDER_TREE =", b"const TESTS_LIST =")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path, chunk_size: int = 4 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_source_access(source: Path) -> Dict[str, Any]:
    """Cheap source checks only; never hash or parse the full export here."""
    if not source.is_file():
        raise ValueError(f"source file not found: {source}")
    if not os.access(source, os.R_OK):
        raise ValueError(f"source file is not readable: {source}")
    size = source.stat().st_size
    if size <= 0:
        raise ValueError(f"source file is empty: {source}")
    sample_size = min(size, 8 * 1024 * 1024)
    with source.open("rb") as stream:
        sample = stream.read(sample_size)
    missing = [marker.decode() for marker in SOURCE_MARKERS if marker not in sample]
    if missing:
        raise ValueError(f"source format markers missing from first {sample_size} bytes: {', '.join(missing)}")
    return {"path": str(source), "bytes": size, "readable": True, "format_markers": True}


def credential_kind(key: str) -> str:
    if key.startswith("sb_secret_"):
        return "secret"
    parts = key.split(".")
    if len(parts) == 3:
        try:
            payload = parts[1] + "=" * (-len(parts[1]) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload))
            return str(claims.get("role") or "jwt")
        except (ValueError, json.JSONDecodeError):
            return "invalid"
    return "unknown"


def deterministic_uuid(kind: str, identity: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{kind}|{identity}"))


def clean_text(value: Any) -> str:
    return SPACE_RE.sub(" ", html.unescape(TAG_RE.sub(" ", str(value or "")))).strip()


def slug(value: str) -> str:
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-") or "item"


def canonical_subject(value: str) -> str:
    normalized = re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().casefold())
    return DEFAULT_SUBJECT if normalized in ANAESTHESIA_ALIASES else str(value or "").strip()


def _find_assignment(mapping: mmap.mmap, marker: bytes, occurrence: int = 1) -> int:
    position = -1
    for _ in range(occurrence):
        position = mapping.find(marker, position + 1)
        if position < 0:
            raise ValueError(f"missing source assignment: {marker.decode(errors='replace')}")
    return position


def _balanced_end(mapping: mmap.mmap, start: int, opener: int, closer: int) -> int:
    depth = 0
    in_string = False
    escaped = False
    for position in range(start, len(mapping)):
        current = mapping[position]
        if in_string:
            if escaped:
                escaped = False
            elif current == 92:
                escaped = True
            elif current == 34:
                in_string = False
        else:
            if current == 34:
                in_string = True
            elif current == opener:
                depth += 1
            elif current == closer:
                depth -= 1
                if depth == 0:
                    return position + 1
    raise ValueError("unterminated JSON assignment")


def extract_folder_tree(source: Path) -> Dict[str, Any]:
    with source.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as mapping:
        marker = _find_assignment(mapping, b"const FOLDER_TREE =")
        start = mapping.find(b"{", marker)
        end = _balanced_end(mapping, start, ord("{"), ord("}"))
        return json.loads(mapping[start:end])


def iter_source_tests(source: Path) -> Iterator[Dict[str, Any]]:
    """Yield one TESTS_LIST object at a time without materializing 125 MB."""
    with source.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as mapping:
        # The export contains a documentation comment with the same marker.
        marker = _find_assignment(mapping, b"const TESTS_LIST =", 2)
        position = mapping.find(b"[", marker) + 1
        while True:
            while mapping[position] in b" \r\n\t,":
                position += 1
            if mapping[position] == ord("]"):
                return
            if mapping[position] != ord("{"):
                raise ValueError(f"invalid TESTS_LIST token at byte {position}")
            end = _balanced_end(mapping, position, ord("{"), ord("}"))
            yield json.loads(mapping[position:end])
            position = end


def source_subject(test: Dict[str, Any]) -> str:
    path = test.get("path") or []
    return str(path[0]).strip() if path else ""


def correct_keys(question: Dict[str, Any]) -> List[str]:
    keys = [str(option.get("label") or "").strip().upper() for option in question.get("options") or [] if option.get("correct") is True]
    if keys:
        return sorted(set(filter(None, keys)))
    answer = str(question.get("correct_answer") or "").strip()
    return sorted(set(re.findall(r"\b([A-H])(?:\b|[).,:])", answer.upper())))


def media_reference(value: Any, placement: str, position: int) -> Dict[str, Any]:
    if isinstance(value, dict):
        reference = str(value.get("url") or value.get("src") or value.get("id") or "").strip()
        media_type = str(value.get("type") or "image").strip()
        source_id = value.get("id")
    else:
        reference = str(value or "").strip()
        media_type = "image"
        source_id = None
    return {"reference": reference, "type": media_type, "placement": placement, "position": position, "source_id": source_id}


def canonical_payload(question: Dict[str, Any]) -> Dict[str, Any]:
    options = []
    for index, option in enumerate(question.get("options") or []):
        options.append({
            "key": str(option.get("label") or chr(ord("A") + index)).strip().upper(),
            "html": str(option.get("text") or ""),
            "is_correct": option.get("correct") is True,
        })
    question_media = [media_reference(value, "question", index) for index, value in enumerate(question.get("question_images") or [])]
    explanation_media = [media_reference(value, "explanation", index) for index, value in enumerate(question.get("explanation_images") or [])]
    payload = {
        "question_html": str(question.get("raw_text") or question.get("text") or ""),
        "options": options,
        "correct_keys": correct_keys(question),
        "correct_answer_source": str(question.get("correct_answer") or ""),
        "explanation_html": str(question.get("explanation") or ""),
        "media": question_media + explanation_media,
        "bot": question.get("bot"),
        "video": question.get("video"),
        "audio": question.get("audio"),
    }
    return payload


def validate_question(question: Dict[str, Any], test_id: str, position: int) -> List[str]:
    errors = []
    options = question.get("options") or []
    keys = [str(option.get("label") or "").strip().upper() for option in options]
    if not clean_text(question.get("raw_text") or question.get("text")):
        errors.append("empty usable question stem")
    if not 2 <= len(options) <= 8:
        errors.append(f"invalid option count {len(options)}")
    if len(set(keys)) != len(keys) or any(not re.fullmatch(r"[A-H]", key or "") for key in keys):
        errors.append("invalid or duplicate option keys")
    if any(not clean_text(option.get("text")) for option in options):
        errors.append("blank required option content")
    answers = correct_keys(question)
    if not answers:
        errors.append("no correct option")
    elif any(key not in keys for key in answers):
        errors.append("correct key has no matching option")
    if not str(question.get("id") or "").strip():
        errors.append("missing source question ID")
    return [f"{test_id} question {position}: {error}" for error in errors]


@dataclass
class PilotPlan:
    report: Dict[str, Any]
    manifest: Dict[str, Any]
    objects: List[Dict[str, Any]]
    object_bytes: Dict[str, bytes]


def build_plan(source: Path, subject: str = DEFAULT_SUBJECT) -> PilotPlan:
    subject = canonical_subject(subject)
    source_hash = sha256_file(source)
    source_size = source.stat().st_size
    folder_tree = extract_folder_tree(source)
    folders = folder_tree.get("folders") or []
    folder = next((item for item in folders if canonical_subject(str(item.get("name") or "")) == subject), None)
    if not folder:
        raise ValueError(f"subject not found in FOLDER_TREE: {subject}")
    declared_tests = folder.get("tests") or []
    declared_by_id = {str(test.get("id")): test for test in declared_tests}
    tests = [test for test in iter_source_tests(source) if canonical_subject(source_subject(test)) == subject]
    errors: List[str] = []
    warnings: List[str] = []
    unsupported = Counter()
    if len(tests) != len(declared_tests):
        errors.append(f"declared {len(declared_tests)} source tests but parsed {len(tests)}")

    source_id_rows: Dict[str, List[Tuple[str, str, int]]] = defaultdict(list)
    content_first: Dict[str, Dict[str, Any]] = {}
    versions: List[Dict[str, Any]] = []
    occurrences: List[Dict[str, Any]] = []
    source_tests: List[Dict[str, Any]] = []
    objects: List[Dict[str, Any]] = []
    object_bytes: Dict[str, bytes] = {}
    media = Counter()
    pyq_occurrences = 0
    multi_correct = []
    raw_payload_bytes = 0
    normalized_estimate = 0

    for sequence, test in enumerate(tests, 1):
        test_id = str(test.get("id") or "").strip()
        title = str(test.get("title") or "").strip()
        declared = declared_by_id.get(test_id)
        questions = test.get("questions") or []
        if not declared:
            errors.append(f"parsed test absent from folder index: {test_id}")
        elif int(declared.get("num_questions") or 0) != len(questions):
            errors.append(f"{test_id}: declared {declared.get('num_questions')} questions but parsed {len(questions)}")
        unsupported.update(f"test.{key}" for key in set(test) - KNOWN_TEST_FIELDS)
        is_pyq = "previous year questions" in title.casefold()
        stable_key = sha256_bytes(f"{PLATFORM}|{subject}|{test_id}".encode())
        test_uuid = deterministic_uuid("source-test", stable_key)
        test_row = {
            "id": test_uuid, "stable_key": stable_key, "source_test_id": test_id,
            "title": title, "sequence": sequence,
            "numeric_prefix": int(re.match(r"^(\d+)", title).group(1)) if re.match(r"^(\d+)", title) else None,
            "declared_question_count": int(test.get("num_questions") or len(questions)),
            "total_marks": test.get("total_marks"), "duration_minutes": test.get("duration"),
            "time_per_question_seconds": test.get("time_per_question"), "is_pyq": is_pyq,
            "build_id": test.get("build_id"), "source_path": test.get("path") or [subject],
        }
        source_tests.append(test_row)
        new_payloads = []
        pending_for_object = []
        for position, question in enumerate(questions, 1):
            unsupported.update(f"question.{key}" for key in set(question) - KNOWN_QUESTION_FIELDS)
            errors.extend(validate_question(question, test_id, position))
            payload = canonical_payload(question)
            payload_json = stable_json(payload).encode("utf-8")
            content_hash = sha256_bytes(payload_json)
            source_id = str(question.get("id") or "").strip()
            source_id_rows[source_id].append((content_hash, test_id, position))
            raw_payload_bytes += len(json.dumps(question, ensure_ascii=False).encode("utf-8"))
            normalized_estimate += len(payload_json) + len(source_id) + 240 + len(payload["options"]) * 96
            if len(payload["correct_keys"]) > 1:
                multi_correct.append({"test_id": test_id, "position": position, "source_question_id": source_id, "correct_keys": payload["correct_keys"]})
            for item in payload["media"]:
                media[f"{item['placement']}_image_references"] += 1
            if payload.get("audio"):
                media["audio_occurrences"] += 1
            if payload.get("video"):
                media["video_occurrences"] += 1
            if is_pyq:
                pyq_occurrences += 1
            if content_hash not in content_first:
                question_uuid = deterministic_uuid("question", f"{PLATFORM}|{subject}|{content_hash}")
                version = {
                    "question_id": question_uuid, "content_sha256": content_hash,
                    "source_question_id": source_id,
                    "stem_excerpt": clean_text(payload["question_html"])[:500],
                    "correct_option_keys": payload["correct_keys"], "option_count": len(payload["options"]),
                    "is_multi_correct": len(payload["correct_keys"]) > 1,
                    "has_question_media": any(item["placement"] == "question" for item in payload["media"]),
                    "has_explanation_media": any(item["placement"] == "explanation" for item in payload["media"]),
                    "has_audio": bool(payload.get("audio")), "has_video": bool(payload.get("video")),
                    "media_status": "MEDIA_REFERENCED" if payload["media"] or payload.get("audio") or payload.get("video") else "NO_MEDIA",
                    "first_source_test_id": test_uuid, "first_source_test_title": title,
                    "is_pyq": is_pyq,
                }
                content_first[content_hash] = version
                versions.append(version)
                pending_for_object.append((version, payload))
                new_payloads.append(payload)
            else:
                question_uuid = content_first[content_hash]["question_id"]
                content_first[content_hash]["is_pyq"] = content_first[content_hash]["is_pyq"] or is_pyq
            occurrence_key = sha256_bytes(f"{stable_key}|{position}|{source_id}|{content_hash}".encode())
            occurrences.append({
                "id": deterministic_uuid("occurrence", occurrence_key), "occurrence_key": occurrence_key,
                "source_test_id": test_uuid, "question_id": question_uuid,
                "source_question_id": source_id, "question_position": position,
                "content_sha256": content_hash, "is_pyq": is_pyq,
            })

        payload_document = {"schema_version": SCHEMA_VERSION, "platform": PLATFORM, "subject": subject, "source_test": {"id": test_id, "title": title, "sequence": sequence}, "questions": new_payloads}
        minified = stable_json(payload_document).encode("utf-8")
        compressed = gzip.compress(minified, compresslevel=9, mtime=0)
        object_hash = sha256_bytes(compressed)
        object_path = f"prepladder/{slug(subject)}/{sequence:03d}_{slug(test_id)}/{object_hash}.json.gz"
        object_row = {
            "id": deterministic_uuid("payload-object", object_path), "object_path": object_path,
            "sha256": object_hash, "uncompressed_sha256": sha256_bytes(minified),
            "raw_bytes": len(minified), "stored_bytes": len(compressed),
            "question_count": len(new_payloads), "compression": "gzip", "source_test_id": test_uuid,
        }
        objects.append(object_row)
        object_bytes[object_path] = compressed
        for payload_index, (version, _payload) in enumerate(pending_for_object):
            version["payload_object_id"] = object_row["id"]
            version["payload_index"] = payload_index

    duplicate_groups = {key: rows for key, rows in source_id_rows.items() if len(rows) > 1}
    differing_groups = {key: rows for key, rows in duplicate_groups.items() if len({row[0] for row in rows}) > 1}
    exact_duplicate_occurrences = sum(len(rows) - len({row[0] for row in rows}) for rows in duplicate_groups.values())
    if unsupported:
        warnings.append("unsupported fields were detected and preserved only in the local audit report")
    if multi_correct:
        warnings.append(f"pilot contains {len(multi_correct)} multi-correct occurrences")
    minified_bytes = sum(item["raw_bytes"] for item in objects)
    compressed_bytes = sum(item["stored_bytes"] for item in objects)
    manifest = {
        "schema_version": SCHEMA_VERSION, "importer_version": VERSION,
        "source_filename": source.name, "source_sha256": source_hash, "source_bytes": source_size,
        "platform": PLATFORM, "subject": subject, "status": "validated" if not errors else "invalid",
        "source_test_count": len(source_tests), "occurrence_count": len(occurrences),
        "content_version_count": len(versions), "payload_object_count": len(objects),
        "payload_stored_bytes": compressed_bytes,
    }
    report = {
        "generated_at": now_iso(), "database_modified": False, "storage_modified": False,
        "source": {"filename": source.name, "path": str(source), "sha256": source_hash, "bytes": source_size, "uploaded_to_cloud": False},
        "scope": {"platform": PLATFORM, "subject": subject},
        "counts": {
            "source_tests": len(source_tests), "question_occurrences": len(occurrences),
            "unique_source_ids": len(source_id_rows), "unique_content_versions": len(versions),
            "pyq_tests": sum(1 for row in source_tests if row["is_pyq"]), "pyq_occurrences": pyq_occurrences,
            "duplicate_source_id_groups": len(duplicate_groups),
            "extra_duplicate_occurrences": sum(len(rows) - 1 for rows in duplicate_groups.values()),
            "differing_content_duplicate_groups": len(differing_groups),
            "exact_payload_duplicates_saved": len(occurrences) - len(versions),
            "multi_correct_occurrences": len(multi_correct),
        },
        "media": dict(sorted(media.items())), "multi_correct_examples": multi_correct[:20],
        "unsupported_fields": dict(sorted(unsupported.items())),
        "storage_benchmark": {
            "raw_source_question_json_bytes": raw_payload_bytes,
            "normalized_postgres_estimated_bytes": normalized_estimate,
            "minified_payload_bytes": minified_bytes,
            "gzip_payload_bytes": compressed_bytes,
            "object_count": len(objects),
            "gzip_savings_bytes": minified_bytes - compressed_bytes,
            "payload_deduplication_savings_occurrences": exact_duplicate_occurrences,
        },
        "structural_errors": errors, "warnings": warnings,
        "valid": not errors,
        "duplicate_examples": {key: rows for key, rows in list(duplicate_groups.items())[:20]},
        "differing_content_examples": {key: rows for key, rows in list(differing_groups.items())[:20]},
    }
    commit_manifest = {**manifest, "source_tests": source_tests, "versions": versions, "occurrences": occurrences, "objects": objects}
    return PilotPlan(report=report, manifest=commit_manifest, objects=objects, object_bytes=object_bytes)


def write_plan(plan: PilotPlan, output: Path) -> Tuple[Path, Path]:
    output.mkdir(parents=True, exist_ok=True)
    report_path = output / "prepladder-anaesthesia-report.json"
    manifest_path = output / "prepladder-anaesthesia-manifest.json"
    report_path.write_text(json.dumps(plan.report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    manifest_path.write_text(json.dumps(plan.manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    payload_root = output / "payloads"
    for object_path, content in plan.object_bytes.items():
        target = payload_root / object_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return report_path, manifest_path


def api_request(url: str, key: str, path: str, method: str = "GET", body: Optional[bytes] = None, headers: Optional[Dict[str, str]] = None) -> Tuple[bytes, Dict[str, str]]:
    request_headers = {"apikey": key, "Authorization": f"Bearer {key}", **(headers or {})}
    request = urllib.request.Request(url.rstrip("/") + path, data=body, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read(), dict(response.headers)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed ({error.code}): {detail[:1000]}") from error


def rpc(url: str, key: str, name: str, payload: Dict[str, Any]) -> Any:
    body, _ = api_request(url, key, f"/rest/v1/rpc/{name}", "POST", stable_json(payload).encode(), {"Content-Type": "application/json"})
    return json.loads(body or b"null")


def import_preflight(source: Path, url: str, key: str) -> Dict[str, Any]:
    """Fail before full parsing unless every expensive-import dependency works."""
    started = datetime.now(timezone.utc)
    source_check = validate_source_access(source)
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".supabase.co"):
        raise ValueError("SUPABASE_URL must be an https://*.supabase.co project URL")
    if parsed.hostname.split(".", 1)[0] != "flulljensjugfcxmeczu":
        raise ValueError("SUPABASE_URL points to the wrong project")
    if not key:
        raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required for --import")
    kind = credential_kind(key)
    if kind not in {"service_role", "secret"}:
        raise ValueError("runtime credential is not a Supabase service-role/secret key")

    checks = {}
    endpoints = {
        "connectivity_and_import_permissions": "/rest/v1/qbank_hybrid_import_runs?select=id&limit=0",
        "migration_source_tests": "/rest/v1/qbank_source_tests?select=id&limit=0",
        "migration_payload_objects": "/rest/v1/qbank_payload_objects?select=id&limit=0",
        "migration_question_payloads": "/rest/v1/qbank_question_payloads?select=question_id&limit=0",
        "migration_source_occurrences": "/rest/v1/qbank_source_occurrences?select=id&limit=0",
        "storage_bucket": f"/storage/v1/bucket/{BUCKET}",
    }
    for name, path in endpoints.items():
        api_request(url, key, path)
        checks[name] = "PASS"
    elapsed_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    return {
        "status": "PASS", "elapsed_ms": elapsed_ms, "source": source_check,
        "project_ref": parsed.hostname.split(".", 1)[0], "credential_kind": kind,
        "checks": checks,
    }


def storage_path(path: str) -> str:
    return urllib.parse.quote(path, safe="/")


def upload_and_verify(plan: PilotPlan, url: str, key: str) -> List[str]:
    uploaded = []
    for object_path, content in plan.object_bytes.items():
        encoded = storage_path(object_path)
        try:
            existing, _ = api_request(url, key, f"/storage/v1/object/authenticated/{BUCKET}/{encoded}")
            if sha256_bytes(existing) == sha256_bytes(content):
                continue
            raise RuntimeError(f"existing object checksum conflict: {object_path}")
        except RuntimeError as error:
            if "(400)" not in str(error) and "(404)" not in str(error):
                raise
        api_request(url, key, f"/storage/v1/object/{BUCKET}/{encoded}", "POST", content, {"Content-Type": "application/gzip", "x-upsert": "false", "Cache-Control": "31536000"})
        downloaded, _ = api_request(url, key, f"/storage/v1/object/authenticated/{BUCKET}/{encoded}")
        if sha256_bytes(downloaded) != sha256_bytes(content):
            raise RuntimeError(f"uploaded object checksum mismatch: {object_path}")
        uploaded.append(object_path)
    return uploaded


def delete_objects(paths: Iterable[str], url: str, key: str) -> None:
    values = list(paths)
    if not values:
        return
    api_request(url, key, f"/storage/v1/object/{BUCKET}", "DELETE", stable_json({"prefixes": values}).encode(), {"Content-Type": "application/json"})


def import_plan(plan: PilotPlan, url: str, key: str, acknowledgement: str) -> Dict[str, Any]:
    if acknowledgement != "IMPORT PREPLADDER ANAESTHESIA ONLY":
        raise ValueError("exact import acknowledgement is required")
    if not plan.report["valid"]:
        raise ValueError("structurally invalid source cannot be imported")
    run = rpc(url, key, "qbank_begin_prepladder_import", {"p_manifest": {key: value for key, value in plan.manifest.items() if key not in {"source_tests", "versions", "occurrences", "objects"}}})
    uploaded: List[str] = []
    try:
        uploaded = upload_and_verify(plan, url, key)
        result = rpc(url, key, "qbank_commit_prepladder_import", {"p_manifest": plan.manifest})
        return {"run": run, "commit": result, "uploaded_objects": uploaded}
    except Exception:
        delete_objects(uploaded, url, key)
        raise


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="PrepLadder hybrid payload importer (dry-run by default)")
    parser.add_argument("--source", default="import-source/PREP_q_banks.html")
    parser.add_argument("--subject", default=DEFAULT_SUBJECT)
    parser.add_argument("--output")
    parser.add_argument("--import", dest="do_import", action="store_true")
    parser.add_argument("--acknowledge", default="")
    parser.add_argument("--url", default=os.environ.get("SUPABASE_URL", DEFAULT_URL))
    args = parser.parse_args(argv)
    source = Path(args.source).expanduser().resolve()
    if canonical_subject(args.subject) != DEFAULT_SUBJECT:
        parser.error("pilot safety boundary permits Anaesthesia only")
    try:
        validate_source_access(source)
    except ValueError as error:
        parser.error(str(error))
    preflight = None
    service_key = ""
    if args.do_import:
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        try:
            preflight = import_preflight(source, args.url, service_key)
        except (ValueError, RuntimeError, urllib.error.URLError) as error:
            parser.error(f"IMPORT PREFLIGHT FAILED before parsing: {error}")
        print(stable_json({"phase": "preflight", **preflight}), file=sys.stderr, flush=True)
    plan = build_plan(source, args.subject)
    output = Path(args.output).resolve() if args.output else Path(tempfile.mkdtemp(prefix="qbank-prepladder-"))
    report_path, manifest_path = write_plan(plan, output)
    result = None
    if args.do_import:
        result = import_plan(plan, args.url, service_key, args.acknowledge)
        plan.report.update({"database_modified": True, "storage_modified": True, "preflight": preflight, "import_result": result})
        report_path.write_text(json.dumps(plan.report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(stable_json({"valid": plan.report["valid"], "counts": plan.report["counts"], "storage_benchmark": plan.report["storage_benchmark"], "report": str(report_path), "manifest": str(manifest_path), "imported": bool(result)}))
    return 0 if plan.report["valid"] else 2


if __name__ == "__main__":
    sys.exit(main())
