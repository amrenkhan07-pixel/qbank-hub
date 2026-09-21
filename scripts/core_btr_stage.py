#!/usr/bin/env python3
"""Deterministic Core BTR HTML staging. This module has no production-write path."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

try:
    from .prepladder_import import (canonical_payload, clean_text, deterministic_uuid,
        extract_folder_tree, iter_source_tests, slug, stable_json)
except ImportError:
    from prepladder_import import (canonical_payload, clean_text, deterministic_uuid,
        extract_folder_tree, iter_source_tests, slug, stable_json)

VERSION = "core-btr-stage-v1"
PLATFORM = "Core BTR"
SOURCE_TYPE = "CORE_BTR"

SUBJECT_MAP = {
    "Anatomy": "Anatomy",
    "Anesthesia": "Anaesthesia",
    "Biochemistry": "Biochemistry",
    "Dermatology": "Dermatology",
    "ENT": "ENT",
    "Endocrine": "Medicine",
    "Forensic_Medicine_Toxicology": "Forensic Medicine",
    "GI_Hepatobiliary_System": "Medicine",
    "General_Pathology": "Pathology",
    "General_Pharmacology": "Pharmacology",
    "General_Physiology": "Physiology",
    "Hematology": "Medicine",
    "Immunology": "Pathology",
    "Microbiology": "Microbiology",
    "Neurology": "Medicine",
    "Cardiovascular_System": "Medicine",
    "Obstetrics_Gynaecology": "Obstetrics & Gynecology",
    "Ophthalmology": "Ophthalmology",
    "Orthopedics": "Orthopedics",
    "Pediatrics": "Pediatrics",
    "Preventive_Social_Medicine": "Community Medicine",
    "Psychiatry": "Psychiatry",
    "Radiology": "Radiology",
    "Renal_Electrolytes": "Medicine",
    "Respiratory_System": "Medicine",
    "Rheumatology": "Medicine",
    "Surgery": "Surgery",
}


def sha(value: object) -> str:
    return hashlib.sha256(stable_json(value).encode()).hexdigest()


def display_section(value: str) -> str:
    overrides = {
        "Cardiovascular_System": "Cardiovascular System",
        "Forensic_Medicine_Toxicology": "Forensic Medicine Toxicology",
        "GI_Hepatobiliary_System": "GI / Hepatobiliary System",
        "General_Pathology": "General Pathology",
        "General_Pharmacology": "General Pharmacology",
        "General_Physiology": "General Physiology",
        "Obstetrics_Gynaecology": "Obstetrics & Gynaecology",
        "Preventive_Social_Medicine": "Preventive & Social Medicine",
        "Renal_Electrolytes": "Renal / Electrolytes",
        "Respiratory_System": "Respiratory System",
    }
    return overrides.get(value, value.replace("_", " "))


def corrected_section(path: list) -> tuple[str, list[str]]:
    raw = [str(x).strip() for x in path if str(x).strip()]
    if raw[:2] == ["Neurology", "Cardiovascular_System"]:
        return "Cardiovascular_System", ["Cardiovascular System"] + [display_section(x) for x in raw[2:]]
    if not raw:
        raise ValueError("Core BTR test has no source path")
    return raw[0], [display_section(x) for x in raw]


def collection_type(title: str) -> str:
    key = "".join(ch for ch in title.casefold() if ch.isalnum())
    if "allqbankqsexcludingpyq" in key:
        return "ALL_QBANK_EXCLUDING_PYQ"
    if key in {"pyq", "pyqs"}:
        return "CORE_BTR_PYQ"
    if "zvrecommended" in key:
        return "ZV_RECOMMENDED"
    return "TOPIC_TEST"


def validation_errors(question: object) -> list[str]:
    if not isinstance(question, dict):
        return ["not_an_object"]
    errors = []
    if not clean_text(question.get("raw_text") or question.get("text")):
        errors.append("missing_stem")
    options = question.get("options")
    if not isinstance(options, list) or not 2 <= len(options) <= 8 or any(not isinstance(x, dict) for x in options):
        return errors + ["malformed_options"]
    labels = [str(x.get("label") or "").strip().upper() for x in options]
    if len(labels) != len(set(labels)) or any(not x or not clean_text(o.get("text")) for x, o in zip(labels, options)):
        errors.append("invalid_options")
    correct = [str(x.get("label") or "").strip().upper() for x in options if x.get("correct") is True]
    if not correct or any(x not in labels for x in correct):
        errors.append("missing_or_invalid_answer")
    if not clean_text(question.get("explanation")):
        errors.append("missing_explanation")
    return errors


def tree_tests(folder: dict) -> list[dict]:
    rows = list(folder.get("tests") or [])
    for child in folder.get("folders") or []:
        rows.extend(tree_tests(child))
    return rows


def stage(source: Path) -> dict:
    tree = extract_folder_tree(source)
    declared = {str(t["id"]): t for folder in tree.get("folders") or [] for t in tree_tests(folder)}
    source_tests, occurrences, quarantine = [], [], []
    versions: dict[str, dict] = {}
    memberships: dict[str, list[dict]] = defaultdict(list)
    source_question_hashes: dict[str, set[str]] = defaultdict(set)
    audit = Counter()

    for sequence, test in enumerate(iter_source_tests(source), 1):
        test_id = str(test.get("id") or "").strip()
        title = str(test.get("title") or "").strip()
        questions = test.get("questions") or []
        if test_id not in declared or int(declared[test_id].get("num_questions") or 0) != len(questions):
            raise ValueError(f"tree/test mismatch: {test_id}")
        section_key, corrected_path = corrected_section(test.get("path") or [])
        analytics_subject = SUBJECT_MAP.get(section_key)
        if not analytics_subject:
            raise ValueError(f"unmapped Core BTR section: {section_key}")
        ctype = collection_type(title)
        test_key = sha([PLATFORM, corrected_path, test_id])
        test_uuid = deterministic_uuid("source-test", test_key)
        source_tests.append({
            "id": test_uuid, "stable_key": test_key, "platform": PLATFORM,
            "source_type": SOURCE_TYPE, "analytics_subject": analytics_subject,
            "source_section": display_section(section_key), "source_path": corrected_path,
            "sequence": sequence, "source_test_id": test_id, "source_test_title": title,
            "collection_type": ctype, "declared_question_count": len(questions),
        })
        audit[f"collection:{ctype}"] += len(questions)
        for position, question in enumerate(questions, 1):
            errors = validation_errors(question)
            source_qid = str(question.get("id") or "").strip() if isinstance(question, dict) else ""
            if errors:
                quarantine.append({"source_test_id": test_id, "position": position,
                                   "source_question_id": source_qid, "reasons": errors})
                continue
            payload = canonical_payload(question)
            content_hash = sha(payload)
            source_question_hashes[source_qid].add(content_hash)
            question_id = deterministic_uuid("question", f"Core BTR|{content_hash}")
            if content_hash not in versions:
                versions[content_hash] = {
                    "question_id": question_id, "platform": PLATFORM, "source_type": SOURCE_TYPE,
                    "analytics_subject": analytics_subject, "content_sha256": content_hash,
                    "source_question_id_first_seen": source_qid, "payload": payload,
                    "first_source_test_uuid": test_uuid, "first_source_test_title": title,
                }
            elif versions[content_hash]["analytics_subject"] != analytics_subject:
                raise ValueError(f"identical Core BTR content crosses analytics subjects: {source_qid}")
            occurrence_key = sha([test_key, position, source_qid, content_hash])
            occurrence = {
                "id": deterministic_uuid("occurrence", occurrence_key), "occurrence_key": occurrence_key,
                "platform": PLATFORM, "source_type": SOURCE_TYPE,
                "analytics_subject": analytics_subject, "source_section": display_section(section_key),
                "source_path": corrected_path, "source_test_id": test_id,
                "source_test_uuid": test_uuid, "source_test_title": title,
                "collection_type": ctype, "question_order_within_test": position,
                "source_question_id": source_qid, "question_id": question_id,
                "content_sha256": content_hash,
            }
            occurrences.append(occurrence)
            memberships[content_hash].append(occurrence)
            audit["question_images"] += len(question.get("question_images") or [])
            audit["explanation_images"] += len(question.get("explanation_images") or [])
            audit["video"] += bool(question.get("video"))
            audit["audio"] += bool(question.get("audio"))

    for content_hash, version in versions.items():
        rows = memberships[content_hash]
        types = {row["collection_type"] for row in rows}
        flags = {
            "is_core_btr_pyq": "CORE_BTR_PYQ" in types,
            "is_zv_recommended": "ZV_RECOMMENDED" in types,
            "in_topic_test": "TOPIC_TEST" in types,
            "in_all_qbank": "ALL_QBANK_EXCLUDING_PYQ" in types,
            "membership_count": len(rows),
            "high_value_membership_count": sum(x in types for x in ("CORE_BTR_PYQ", "ZV_RECOMMENDED")),
        }
        flags["is_hit_list"] = flags["is_core_btr_pyq"] and flags["is_zv_recommended"]
        version.update(flags)

    if len(source_tests) != len(declared):
        raise ValueError("not every declared Core BTR test was parsed")
    if len(occurrences) + len(quarantine) != sum(x["declared_question_count"] for x in source_tests):
        raise ValueError("Core BTR occurrence accounting mismatch")
    distribution = Counter(v["membership_count"] for v in versions.values())
    return {
        "version": VERSION, "read_only": True, "production_writes": 0,
        "platform": PLATFORM, "source_type": SOURCE_TYPE, "source_filename": source.name,
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "source_bytes": source.stat().st_size,
        "summary": {
            "source_tests": len(source_tests), "source_occurrences": len(occurrences),
            "declared_occurrences": len(occurrences) + len(quarantine),
            "unique_content": len(versions),
            "duplicate_content_extra_occurrences": len(occurrences) - len(versions),
            "repeated_content_records": sum(v > 1 for v in (x["membership_count"] for x in versions.values())),
            "effective_top_level_sections": len({x["source_section"] for x in source_tests}),
            "quarantine": len(quarantine),
            "collection_occurrences": dict(sorted((k.split(":", 1)[1], v) for k, v in audit.items() if k.startswith("collection:"))),
            "collection_tests": dict(sorted(Counter(x["collection_type"] for x in source_tests).items())),
            "membership_distribution": {str(k): v for k, v in sorted(distribution.items())},
            "hit_list_questions": sum(x["is_hit_list"] for x in versions.values()),
            "question_images": audit["question_images"], "explanation_images": audit["explanation_images"],
            "video_metadata": audit["video"], "audio_metadata": audit["audio"],
            "complete_options": sum(bool(v["payload"]["options"]) for v in versions.values()),
            "complete_answers": sum(bool(v["payload"]["correct_keys"]) for v in versions.values()),
            "complete_explanations": sum(bool(clean_text(v["payload"]["explanation_html"])) for v in versions.values()),
            "repeated_source_id_groups": sum(len(hashes) > 1 for hashes in source_question_hashes.values()),
        },
        "source_tests": source_tests, "content_versions": list(versions.values()),
        "occurrences": occurrences, "quarantine": quarantine,
    }


def materialize_payload_objects(document: dict, directory: Path, chunk_size: int = 250) -> None:
    grouped = defaultdict(list)
    for version in document["content_versions"]:
        grouped[version["analytics_subject"]].append(version)
    objects = []
    for subject in sorted(grouped):
        rows = sorted(grouped[subject], key=lambda x: x["question_id"])
        for chunk_index in range(0, len(rows), chunk_size):
            chunk = rows[chunk_index:chunk_index + chunk_size]
            raw = stable_json({"schema_version": 1, "platform": PLATFORM, "analytics_subject": subject,
                               "questions": [row["payload"] for row in chunk]}).encode()
            compressed = gzip.compress(raw, compresslevel=9, mtime=0)
            digest = hashlib.sha256(compressed).hexdigest()
            object_path = f"core-btr/{slug(subject)}/{chunk_index // chunk_size + 1:03d}/{digest}.json.gz"
            local_path = directory / object_path
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(compressed)
            object_id = deterministic_uuid("payload-object", object_path)
            objects.append({"id": object_id, "object_path": object_path, "sha256": digest,
                            "uncompressed_sha256": hashlib.sha256(raw).hexdigest(),
                            "raw_bytes": len(raw), "stored_bytes": len(compressed),
                            "question_count": len(chunk), "compression": "gzip",
                            "source_test_id": chunk[0]["first_source_test_uuid"]})
            for index, version in enumerate(chunk):
                version["payload_object_id"] = object_id
                version["payload_index"] = index
    document["payload_objects"] = objects
    document["summary"]["payload_objects"] = len(objects)
    document["summary"]["payload_raw_bytes"] = sum(x["raw_bytes"] for x in objects)
    document["summary"]["payload_stored_bytes"] = sum(x["stored_bytes"] for x in objects)


def write_artifact(document: dict, output: Path) -> str:
    raw = stable_json(document).encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    return hashlib.sha256(output.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=Path("import-reports/core-btr-stage-v1.json.gz"))
    parser.add_argument("--object-dir", type=Path, default=Path("import-reports/core-btr-payloads-v1"))
    args = parser.parse_args()
    document = stage(args.source)
    materialize_payload_objects(document, args.object_dir)
    digest = write_artifact(document, args.output)
    print(json.dumps({"artifact": str(args.output), "sha256": digest, "summary": document["summary"]}, indent=2))


if __name__ == "__main__":
    main()
