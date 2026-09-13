#!/usr/bin/env python3
"""Classify one deterministic, representative 1,000-question PrepLadder batch.

Dry-run is the default. With --apply --confirm-exact-1000, the service-only
transactional RPC persists compact IDs/state and sparse exception evidence.
Source question content is never included in the database commit payload.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from taxonomy_draft_classifier import (
    VERSION_KEY,
    alias_match,
    normalize,
    plain,
    positive_explanation,
    request,
    storage_download,
)

BATCH_SIZE = 1000
SCOPE_KEY = "canonical-medical-v1-prepladder-batch-1000-01"
RECLASS_SCOPE_KEY = "canonical-medical-v1-prepladder-batch-1000-quality-v2"
CLASSIFIER_VERSION = "source-prior-intent-positive-evidence-v2"
REPORT_PATH = Path("/tmp/qbank-canonical-batch-1000.json")
CACHE_DIR = Path("/tmp/qbank-canonical-batch-payload-cache")
VOCABULARY_PATH = Path(__file__).with_name("taxonomy-concept-vocabulary-v1.json")
BROAD_TITLE = re.compile(
    r"\b(misc(?:ellaneous)?|previous year|pyq|grand test|mock|mixed|rapid revision|"
    r"comprehensive|recent update|image based|clinical scenario|integrated)\b",
    re.I,
)
NEGATIVE_STEM = re.compile(
    r"\b(except|not|false|incorrect|least likely|contraindicated|not true|"
    r"all (?:of )?the following (?:are )?(?:true )?except|most appropriate except)\b",
    re.I,
)
GENERIC_TOKENS = {
    "about", "according", "answer", "appropriate", "associated", "best",
    "cause", "caused", "clinical", "condition", "correct", "disease",
    "following", "given", "identify", "incorrect", "likely", "management",
    "most", "patient", "question", "regarding", "statement", "treatment",
    "true", "which", "with", "without",
}

# Ten medically reviewed integrated/related cases from this deterministic
# batch. Secondary paths are explicit review decisions, never probability
# alternatives generated merely because two scores are close.
REVIEWED_SECONDARY_CONCEPTS = {
    "501b4761-15a1-5231-85b6-16308ba4f4c1": "Obstetric anesthesia",
    "687e576a-599d-5a8d-8e76-8e77a1dee543": "Tracheal intubation",
    "6c7e42cd-3579-5f12-b20e-682b2b48df36": "Motor cranial nerves",
    "bd7b9b95-287b-5c1f-a384-f417e060acfb": "Shoulder and arm",
    "f54fd6f0-90a7-5d79-93a9-a68a3c431852": "Tympanic membrane and ossicles",
    "a12b1061-d5f3-5d55-93a6-8969ee8c08ec": "Postmortem changes",
    "1bdb88eb-efc2-544f-9480-94b30e768d2f": "Heart failure",
    "c651d076-c24e-5149-a14e-fa7bf6400dd8": "Glomerular disease",
    "ccc2d9c3-5294-5867-bcc6-d906a739f069": "Antimicrobial resistance",
    "8d54043d-2763-574b-86ec-32a6769c8bae": "Small bowel obstruction",
}


def paged(key: str, table: str, select: str, query: str = "", page_size: int = 1000):
    rows = []
    offset = 0
    while True:
        separator = "&" if query else ""
        page = retry_request(
            key,
            f"/rest/v1/{table}?select={select}{separator}{query}&limit={page_size}&offset={offset}",
        )
        rows.extend(page)
        if len(page) < page_size:
            return rows
        offset += page_size


def retry_request(key: str, path: str, method: str = "GET", payload=None, extra_headers=None):
    last_error = None
    for attempt in range(3):
        try:
            return request(key, path, method, payload, extra_headers)
        except Exception as error:
            last_error = error
            if attempt < 2:
                time.sleep(.4 * (attempt + 1))
    raise last_error


def stable_key(value: str) -> str:
    return hashlib.sha256(f"{SCOPE_KEY}|{value}".encode()).hexdigest()


def chunks(values, size=80):
    for index in range(0, len(values), size):
        yield values[index:index + size]


def id_filter(values):
    return urllib.parse.quote("in.(" + ",".join(values) + ")", safe="(),.-")


def lexical_tokens(value: str):
    tokens = []
    for token in normalize(value).split():
        if len(token) < 4 or token in GENERIC_TOKENS:
            continue
        # Conservative morphology only; this improves plural/adjectival matches
        # without attempting free-form semantic inference.
        for suffix in ("ations", "ation", "ities", "ity", "oses", "osis", "ies", "es", "s"):
            if token.endswith(suffix) and len(token) - len(suffix) >= 5:
                token = token[:-len(suffix)]
                break
        tokens.append(token)
    return set(tokens)


def evidence_match(alias: str, value: str) -> float:
    exact = alias_match(alias, value)
    alias_tokens = lexical_tokens(alias)
    value_tokens = lexical_tokens(value)
    if not alias_tokens or not value_tokens:
        return exact
    overlap = len(alias_tokens & value_tokens)
    lexical = 0.0
    if overlap:
        coverage = overlap / len(alias_tokens)
        lexical = .38 + .55 * coverage if overlap >= 2 or coverage == 1 else .28
    return max(exact, lexical)


def subject_quotas(available: dict[str, int]) -> dict[str, int]:
    subjects = sorted(available)
    base = 30
    quotas = {subject: min(base, available[subject]) for subject in subjects}
    remaining = BATCH_SIZE - sum(quotas.values())
    capacity = {subject: max(0, available[subject] - quotas[subject]) for subject in subjects}
    total_capacity = sum(capacity.values())
    raw = {subject: remaining * capacity[subject] / total_capacity for subject in subjects}
    for subject in subjects:
        add = min(capacity[subject], int(raw[subject]))
        quotas[subject] += add
    left = BATCH_SIZE - sum(quotas.values())
    for subject in sorted(subjects, key=lambda item: (raw[item] - int(raw[item]), available[item], item), reverse=True):
        if left == 0:
            break
        if quotas[subject] < available[subject]:
            quotas[subject] += 1
            left -= 1
    if sum(quotas.values()) != BATCH_SIZE:
        raise RuntimeError(f"Could not allocate exactly {BATCH_SIZE} questions: {quotas}")
    return quotas


def diverse_order(rows):
    by_test = defaultdict(list)
    for row in rows:
        by_test[row["source_test_id"]].append(row)
    for values in by_test.values():
        values.sort(key=lambda row: stable_key(row["question_id"]))
    tests = sorted(by_test, key=stable_key)
    ordered = []
    while tests:
        next_tests = []
        for test_id in tests:
            ordered.append(by_test[test_id].pop(0))
            if by_test[test_id]:
                next_tests.append(test_id)
        tests = next_tests
    return ordered


def pick_representative(candidates):
    by_subject = defaultdict(list)
    for row in candidates:
        by_subject[row["subject"]].append(row)
    quotas = subject_quotas({subject: len(rows) for subject, rows in by_subject.items()})
    chosen = []
    for subject in sorted(by_subject):
        rows = by_subject[subject]
        quota = quotas[subject]
        buckets = {
            "ambiguous": [row for row in rows if row["proposal_status"] == "ambiguous"],
            "broad": [row for row in rows if row["proposal_status"] == "unmapped" or BROAD_TITLE.search(row["source_title"])],
            "pyq": [row for row in rows if row["is_pyq"]],
            "media": [row for row in rows if row["has_media"]],
            "confident": [row for row in rows if row["proposal_status"] == "confident" and not row["is_pyq"]],
        }
        targets = {
            "ambiguous": max(2, round(quota * .18)),
            "broad": max(1, round(quota * .08)),
            "pyq": max(2, round(quota * .25)),
            "media": max(1, round(quota * .04)),
        }
        selected = {}
        for name in ("ambiguous", "broad", "pyq", "media"):
            for row in diverse_order(buckets[name]):
                if len([item for item in selected.values() if item.get("selection_reason") == name]) >= targets[name]:
                    break
                if row["question_id"] not in selected:
                    selected[row["question_id"]] = {**row, "selection_reason": name}
        for row in diverse_order(rows):
            if len(selected) >= quota:
                break
            if row["question_id"] not in selected:
                selected[row["question_id"]] = {**row, "selection_reason": "diverse_fill"}
        if len(selected) != quota:
            raise RuntimeError(f"Insufficient candidates for {subject}: {len(selected)}/{quota}")
        chosen.extend(selected.values())
    chosen.sort(key=lambda row: (row["subject"], stable_key(row["question_id"])))
    if len(chosen) != BATCH_SIZE or len({row["question_id"] for row in chosen}) != BATCH_SIZE:
        raise RuntimeError("Representative selection is not exactly 1,000 unique questions")
    return chosen, quotas


def fetch_metadata(key: str):
    platforms = paged(key, "platforms", "id,name")
    prep = next((row for row in platforms if normalize(row["name"]) == "prepladder"), None)
    if not prep:
        raise RuntimeError("PrepLadder platform not found")
    subjects = {row["id"]: row["name"] for row in paged(key, "subjects", "id,name")}
    tests = paged(
        key, "qbank_source_tests", "id,subject_id,title,is_pyq,sequence",
        f"platform_id=eq.{prep['id']}&order=sequence,id",
    )
    test_by_id = {row["id"]: row for row in tests}
    proposals = paged(
        key, "canonical_source_test_topic_proposals",
        "source_test_id,proposed_topic_node_id,classification_status,confidence,ambiguity,classification_basis",
    )
    proposal_by_test = {row["source_test_id"]: row for row in proposals}
    existing = {
        row["question_id"] for row in paged(key, "canonical_question_versions", "question_id")
    }
    usable_question_ids = {
        row["id"] for row in paged(
            key, "questions", "id",
            f"platform_id=eq.{prep['id']}&is_usable=eq.true&order=id",
        )
    }
    payloads = paged(
        key, "qbank_question_payloads",
        "question_id,payload_object_id,payload_index,content_sha256,correct_option_keys,has_question_media,has_explanation_media,has_audio,has_video,media_status",
        f"platform_id=eq.{prep['id']}",
    )
    payload_by_question = {row["question_id"]: row for row in payloads}
    occurrences = paged(
        key, "qbank_source_occurrences",
        "question_id,source_test_id,question_position,is_pyq,exam_year,exam_session",
        "is_current=eq.true&order=source_test_id,question_position",
    )
    by_question = defaultdict(list)
    for occurrence in occurrences:
        if occurrence["question_id"] in existing or occurrence["question_id"] not in usable_question_ids or occurrence["source_test_id"] not in test_by_id:
            continue
        if occurrence["question_id"] not in payload_by_question:
            continue
        test = test_by_id[occurrence["source_test_id"]]
        proposal = proposal_by_test.get(test["id"], {})
        payload = payload_by_question[occurrence["question_id"]]
        by_question[occurrence["question_id"]].append({
            **occurrence,
            "subject": subjects[test["subject_id"]],
            "source_title": test["title"],
            "source_sequence": test["sequence"],
            "proposal_topic_id": proposal.get("proposed_topic_node_id"),
            "proposal_status": proposal.get("classification_status") or "unmapped",
            "proposal_confidence": float(proposal.get("confidence") or 0),
            "proposal_ambiguity": bool(proposal.get("ambiguity")),
            "proposal_basis": proposal.get("classification_basis"),
            "is_pyq": bool(occurrence.get("is_pyq") or test.get("is_pyq")),
            "payload": payload,
            "has_media": any(payload.get(key) for key in ("has_question_media", "has_explanation_media", "has_audio", "has_video")),
        })
    candidates = []
    rank = {"confident": 0, "ambiguous": 1, "unmapped": 2}
    for question_id, rows in by_question.items():
        rows.sort(key=lambda row: (
            rank.get(row["proposal_status"], 3),
            0 if row["is_pyq"] else 1,
            row["source_sequence"], row["question_position"], row["source_test_id"],
        ))
        candidates.append(rows[0])
    if len({row["subject"] for row in candidates}) != 19:
        raise RuntimeError("Candidate population does not cover all 19 subjects")
    return candidates


def fetch_saved_cohort(key: str, saved: dict):
    """Rehydrate only the immutable IDs from the previously committed cohort."""
    saved_results = saved.get("results") or []
    ids = [row["question_id"] for row in saved_results]
    if len(ids) != BATCH_SIZE or len(set(ids)) != BATCH_SIZE:
        raise RuntimeError("Saved cohort is not exactly 1,000 unique question IDs")
    saved_by_id = {row["question_id"]: row for row in saved_results}

    platforms = paged(key, "platforms", "id,name")
    prep = next((row for row in platforms if normalize(row["name"]) == "prepladder"), None)
    if not prep:
        raise RuntimeError("PrepLadder platform not found")
    subjects = {row["id"]: row["name"] for row in paged(key, "subjects", "id,name")}
    tests = paged(
        key, "qbank_source_tests", "id,subject_id,title,is_pyq,sequence",
        f"platform_id=eq.{prep['id']}&order=sequence,id",
    )
    test_by_id = {row["id"]: row for row in tests}
    proposals = paged(
        key, "canonical_source_test_topic_proposals",
        "source_test_id,proposed_topic_node_id,classification_status,confidence,ambiguity,classification_basis",
    )
    proposal_by_test = {row["source_test_id"]: row for row in proposals}
    payload_by_question = {}
    occurrences = []
    usable = set()
    for batch in chunks(ids):
        filt = id_filter(batch)
        for row in retry_request(key, f"/rest/v1/questions?select=id,is_usable,platform_id&id={filt}"):
            if row.get("is_usable") and row.get("platform_id") == prep["id"]:
                usable.add(row["id"])
        for row in retry_request(
            key,
            "/rest/v1/qbank_question_payloads?select=question_id,payload_object_id,payload_index,content_sha256,"
            "correct_option_keys,has_question_media,has_explanation_media,has_audio,has_video,media_status"
            f"&question_id={filt}",
        ):
            payload_by_question[row["question_id"]] = row
        occurrences.extend(retry_request(
            key,
            "/rest/v1/qbank_source_occurrences?select=question_id,source_test_id,question_position,is_pyq,exam_year,exam_session"
            f"&question_id={filt}&is_current=eq.true&order=source_test_id,question_position",
        ))
    if usable != set(ids):
        raise RuntimeError(f"Saved cohort usability/platform changed for {len(set(ids) - usable)} questions")
    if set(payload_by_question) != set(ids):
        raise RuntimeError("Saved cohort payload references are incomplete")

    occurrences_by_question = defaultdict(list)
    for occurrence in occurrences:
        if occurrence["source_test_id"] in test_by_id:
            occurrences_by_question[occurrence["question_id"]].append(occurrence)
    cohort = []
    for question_id in ids:
        before = saved_by_id[question_id]["diagnostic"]
        candidates = occurrences_by_question.get(question_id) or []
        candidates.sort(key=lambda occurrence: (
            0 if test_by_id[occurrence["source_test_id"]]["title"] == before["source_title"] else 1,
            0 if occurrence.get("is_pyq") else 1,
            test_by_id[occurrence["source_test_id"]]["sequence"],
            occurrence["question_position"],
        ))
        if not candidates:
            raise RuntimeError(f"Saved cohort source occurrence is missing: {question_id}")
        occurrence = candidates[0]
        test = test_by_id[occurrence["source_test_id"]]
        subject = subjects[test["subject_id"]]
        if subject != before["subject"]:
            raise RuntimeError(f"Saved cohort subject changed: {question_id}")
        proposal = proposal_by_test.get(test["id"], {})
        payload = payload_by_question[question_id]
        cohort.append({
            **occurrence,
            "subject": subject,
            "source_title": test["title"],
            "source_sequence": test["sequence"],
            "proposal_topic_id": proposal.get("proposed_topic_node_id"),
            "proposal_status": proposal.get("classification_status") or "unmapped",
            "proposal_confidence": float(proposal.get("confidence") or 0),
            "proposal_ambiguity": bool(proposal.get("ambiguity")),
            "proposal_basis": proposal.get("classification_basis"),
            "is_pyq": bool(occurrence.get("is_pyq") or test.get("is_pyq")),
            "payload": payload,
            "has_media": any(payload.get(field) for field in (
                "has_question_media", "has_explanation_media", "has_audio", "has_video"
            )),
            "selection_reason": before.get("selection_reason") or "saved_cohort",
        })
    if {row["question_id"] for row in cohort} != set(ids):
        raise RuntimeError("Rehydrated cohort does not exactly match the saved 1,000 IDs")
    return cohort


def fetch_taxonomy(key: str):
    versions = retry_request(key, f"/rest/v1/canonical_taxonomy_versions?select=id&version_key=eq.{VERSION_KEY}&status=eq.draft&limit=1")
    if len(versions) != 1:
        raise RuntimeError("Canonical Taxonomy v1 draft is missing")
    version_id = versions[0]["id"]
    nodes = paged(key, "canonical_taxonomy_nodes", "id,parent_id,node_type,name,metadata", f"taxonomy_version_id=eq.{version_id}")
    concepts = paged(key, "canonical_medical_concepts", "id,taxonomy_node_id,parent_concept_id,subject_name,canonical_name,aliases,metadata", f"taxonomy_version_id=eq.{version_id}")
    node_by_id = {row["id"]: row for row in nodes}
    entries = []
    for concept in concepts:
        node = node_by_id[concept["taxonomy_node_id"]]
        aliases = list(dict.fromkeys([concept["canonical_name"], *(concept.get("aliases") or [])]))
        entries.append({**concept, "node": node, "aliases": aliases, "topic_id": node["id"] if node["node_type"] == "topic" else node["parent_id"]})
    return version_id, node_by_id, entries


def hydrate(key: str, chosen):
    object_ids = sorted({row["payload"]["payload_object_id"] for row in chosen})
    objects = {}
    for start in range(0, len(object_ids), 70):
        ids = ",".join(object_ids[start:start + 70])
        rows = retry_request(key, f"/rest/v1/qbank_payload_objects?select=id,bucket_id,object_path,compression&id=in.({ids})")
        objects.update({row["id"]: row for row in rows})
    cache = {}
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def download(obj):
        cached = CACHE_DIR / f"{obj['id']}.json"
        if cached.exists():
            return obj["id"], json.loads(cached.read_text())
        last_error = None
        for attempt in range(3):
            try:
                raw = storage_download(key, obj["bucket_id"], obj["object_path"])
                break
            except Exception as error:
                last_error = error
                if attempt < 2:
                    time.sleep(.35 * (attempt + 1))
        else:
            raise RuntimeError(f"Payload object could not be hydrated after 3 attempts: {obj['id']}") from last_error
        if obj.get("compression") == "gzip":
            raw = gzip.decompress(raw)
        document = json.loads(raw)
        cached.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")))
        return obj["id"], document

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(download, obj) for obj in objects.values()]
        for completed, future in enumerate(as_completed(futures), 1):
            object_id, document = future.result()
            cache[object_id] = document
            if completed % 100 == 0:
                print(f"Loaded {completed}/{len(futures)} selected payload objects", flush=True)

    evidence = []
    for row in chosen:
        payload_ref = row["payload"]
        source = cache[payload_ref["payload_object_id"]]["questions"][int(payload_ref["payload_index"])]
        options = source.get("options") or []
        option_map = {
            str(option.get("key") or chr(65 + index)).upper(): plain(option.get("html") or option.get("text"))
            for index, option in enumerate(options) if isinstance(option, dict)
        }
        correct_keys = source.get("correct_keys") or payload_ref.get("correct_option_keys") or []
        correct_text = " | ".join(option_map.get(str(item).upper(), "") for item in correct_keys).strip(" |")
        explanation = source.get("explanation_html") or ""
        evidence.append({
            **row,
            "stem_text": plain(source.get("question_html")),
            "correct_answer_text": correct_text,
            "positive_explanation_text": positive_explanation(explanation, correct_text),
            "all_options_text": " | ".join(option_map.values()),
            "polarity": "negative" if NEGATIVE_STEM.search(plain(source.get("question_html"))) else "standard",
            "explanation_length": len(plain(explanation)),
            "correct_keys": correct_keys,
            "option_count": len(options),
        })
    return evidence, len(cache)


def score_entry(entry, row):
    generic = {
        "assessment", "clinical", "diagnosis", "disease", "disorder", "emergency",
        "general", "infection", "management", "mechanism", "prevention", "principles",
        "syndrome", "therapy", "treatment", "tumor",
    }
    aliases = [
        alias for alias in entry["aliases"]
        if len(normalize(alias).split()) >= 2
        or (len(normalize(alias)) >= 7 and normalize(alias) not in generic)
    ]
    aliases = list(dict.fromkeys([
        *aliases,
        entry["node"]["name"],
        entry["node"].get("metadata", {}).get("subtopic") or "",
    ]))
    negative = row["polarity"] == "negative"
    source_broad = bool(BROAD_TITLE.search(row["source_title"]))
    source = 0 if source_broad else max((evidence_match(alias, row["source_title"]) for alias in aliases), default=0) * 3.8
    stem = max((evidence_match(alias, row["stem_text"]) for alias in aliases), default=0) * 5.2
    # The answer is corroborating evidence, never the dominant channel. This is
    # deliberately weaker for negative/EXCEPT stems, where the keyed option is
    # often the exception rather than the concept being tested.
    correct = max((evidence_match(alias, row["correct_answer_text"]) for alias in aliases), default=0) * (1.2 if negative else 2.8)
    explanation = max((evidence_match(alias, row["positive_explanation_text"]) for alias in aliases), default=0) * 5.4
    options = max((evidence_match(alias, row["all_options_text"]) for alias in aliases), default=0) * (1.4 if negative else 0)
    intent_score = source + stem + explanation + correct + options
    channels = {
        "source": source > 0,
        "stem": stem > 0,
        "correct": correct > 0,
        "explanation": explanation > 0,
        "options": options > 0,
    }
    return {
        **entry,
        "source_score": source,
        "stem_score": stem,
        "correct_score": correct,
        "explanation_score": explanation,
        "options_score": options,
        "content_score": stem + correct + explanation + options,
        "intent_score": intent_score,
        "channels": channels,
    }


def classify(entries, nodes, row):
    subject_entries = [entry for entry in entries if entry["subject_name"] == row["subject"]]
    scored = [score_entry(entry, row) for entry in subject_entries]
    scored = [entry for entry in scored if entry["intent_score"] > 0]
    scored.sort(key=lambda entry: (
        entry["intent_score"],
        entry["node"]["node_type"] == "subtopic",
        bool(entry["parent_concept_id"]),
    ), reverse=True)
    prior_id = row.get("proposal_topic_id")
    prior = [entry for entry in scored if entry["topic_id"] == prior_id]
    prior_best = prior[0] if prior else None
    global_best = scored[0] if scored else None
    prior_leaf = next((entry for entry in prior if entry["node"]["node_type"] == "subtopic"), None)
    if prior_leaf and (
        not prior_best
        or prior_best["node"]["node_type"] == "topic"
        and (
            prior_leaf["intent_score"] >= prior_best["intent_score"] * .55
            or prior_leaf["content_score"] >= 1.4
            or prior_leaf["source_score"] >= .7
        )
    ):
        prior_best = prior_leaf
    global_leaf = next((entry for entry in scored if entry["node"]["node_type"] == "subtopic"), None)
    if global_leaf and global_best and global_best["node"]["node_type"] == "topic" and global_leaf["intent_score"] >= global_best["intent_score"] * .72:
        global_best = global_leaf
    selected = None
    basis = "unresolved"
    used_prior = False
    if prior_id:
        used_prior = True
        selected = prior_best
        basis = "source_test_supported"
        if global_best and global_best["topic_id"] != prior_id:
            non_answer_channels = sum(global_best[key] > 0 for key in ("stem_score", "explanation_score"))
            prior_score = prior_best["intent_score"] if prior_best else 0
            strong_override = (
                global_best["stem_score"] >= 4.6
                and global_best["explanation_score"] >= 3.0
            )
            if (
                global_best["intent_score"] >= max(10.0, prior_score * 1.35 + 1.5)
                and non_answer_channels >= 2
                and strong_override
            ):
                selected = global_best
                basis = "content_override"
    elif global_best and global_best["content_score"] >= 4.0:
        selected = global_best
        basis = "content_only"

    if selected:
        channels = selected["channels"]
        positive_channels = sum(channels[key] for key in ("source", "stem", "explanation"))
        negative = row["polarity"] == "negative"
        enough_specific_evidence = (
            selected["stem_score"] >= 2.0
            or selected["explanation_score"] >= 2.0
            or (selected["stem_score"] >= 1.4 and selected["explanation_score"] >= 1.4)
            or (selected["source_score"] >= .7 and (channels["stem"] or channels["explanation"] or channels["correct"]))
            or positive_channels >= 2
        )
        if negative and not (channels["stem"] or channels["explanation"]):
            enough_specific_evidence = False
        primary_node = selected["node"] if enough_specific_evidence else (nodes.get(prior_id) if prior_id else selected["node"])
        primary_concept = selected if (
            enough_specific_evidence
            and primary_node["node_type"] == "subtopic"
            and selected["content_score"] >= (2.4 if negative else 1.8)
        ) else None
    elif prior_id:
        primary_node = nodes[prior_id]
        primary_concept = None
        basis = "source_topic_only"
    else:
        primary_node = None
        primary_concept = None

    score = selected["intent_score"] if selected else 0
    if primary_node and used_prior:
        confidence = min(.96, .62 + row["proposal_confidence"] * .18 + min(score, 15) / 55)
        if row["proposal_status"] == "ambiguous":
            # An ambiguous Source-Test proposal without question-level Concept
            # support is honestly low confidence, even though it remains a
            # usable draft Topic prior under the accepted ambiguity policy.
            confidence = min(confidence, .74 if primary_concept else .64)
    elif primary_node:
        confidence = min(.90, .52 + min(score, 15) / 38)
    else:
        confidence = 0
    if basis == "content_override":
        confidence = min(confidence, .82)
    concept_confidence = min(.95, .54 + min(selected["content_score"], 15) / 30) if primary_concept else 0

    secondaries = []
    reviewed_secondary_name = REVIEWED_SECONDARY_CONCEPTS.get(row["question_id"])
    if reviewed_secondary_name and primary_node:
        candidate = next((entry for entry in subject_entries if entry["canonical_name"] == reviewed_secondary_name), None)
        if not candidate:
            raise RuntimeError(f"Reviewed secondary is missing: {row['question_id']}")
        # A previously reviewed secondary may become the stronger primary after
        # intent-aware rescoring. In that case it is no longer a secondary; do
        # not duplicate the same canonical node/concept.
        if (
            candidate["node"]["id"] != primary_node["id"]
            and (not primary_concept or candidate["id"] != primary_concept["id"])
        ):
            secondaries.append({
                "node_id": candidate["node"]["id"], "concept_id": candidate["id"],
                "confidence": .7000, "medically_meaningful": True,
            })

    ambiguity_state = 3 if basis == "content_override" else (2 if secondaries else (1 if row["proposal_status"] == "ambiguous" else 0))
    if basis == "content_override":
        evidence_kind = "content_override"
    elif secondaries:
        evidence_kind = "human_review"
    elif row["proposal_status"] == "ambiguous":
        evidence_kind = "ambiguous"
    elif confidence < .65:
        evidence_kind = "low_confidence"
    else:
        evidence_kind = None
    evidence = {
        "basis": basis,
        "polarity": row["polarity"],
        "source_test_id": row["source_test_id"],
        "source_topic_node_id": prior_id,
        "content_score": round(score, 3),
        "channels": {
            "stem": bool(selected and selected["stem_score"]),
            "correct_answer": bool(selected and selected["correct_score"]),
            "positive_explanation": bool(selected and selected["explanation_score"]),
            "options_for_negative": bool(selected and selected["options_score"]),
        },
            "secondary_count": len(secondaries),
            "reviewed_secondary_concept": reviewed_secondary_name,
    }
    return {
        "question_id": row["question_id"],
        "source_test_id": row["source_test_id"],
        "primary_node_id": primary_node["id"] if primary_node else None,
        "primary_concept_id": primary_concept["id"] if primary_concept else None,
        "confidence": round(confidence, 4),
        "concept_confidence": round(concept_confidence, 4),
        "source_test_prior_used": used_prior,
        "intent_state": 1 if row["polarity"] == "negative" else 0,
        "evidence_flags": (
            (1 if selected and selected["source_score"] else 0)
            | (2 if selected and selected["stem_score"] else 0)
            | (4 if selected and selected["correct_score"] else 0)
            | (8 if selected and selected["explanation_score"] else 0)
            | (16 if selected and selected["options_score"] else 0)
            | (32 if basis == "content_override" else 0)
        ),
        "ambiguity_state": ambiguity_state,
        "evidence_kind": evidence_kind,
        "evidence": evidence if evidence_kind else {},
        "secondaries": secondaries,
        "diagnostic": {
            "subject": row["subject"], "source_title": row["source_title"], "is_pyq": row["is_pyq"],
            "selection_reason": row["selection_reason"], "basis": basis,
            "primary_path": primary_node["metadata"].get("path") if primary_node else None,
            "primary_level": primary_node["node_type"] if primary_node else None,
            "primary_concept": primary_concept["canonical_name"] if primary_concept else None,
            "confidence": round(confidence, 4), "content_score": round(score, 3),
            "explanation_supported": bool(selected and selected["explanation_score"]),
            "polarity": row["polarity"],
            "evidence_flags": (
                (1 if selected and selected["source_score"] else 0)
                | (2 if selected and selected["stem_score"] else 0)
                | (4 if selected and selected["correct_score"] else 0)
                | (8 if selected and selected["explanation_score"] else 0)
                | (16 if selected and selected["options_score"] else 0)
                | (32 if basis == "content_override" else 0)
            ),
            "stem": row["stem_text"], "correct_answer": row["correct_answer_text"],
            "positive_explanation": row["positive_explanation_text"],
            "has_media": row["has_media"], "explanation_length": row["explanation_length"],
            "secondary_concept": reviewed_secondary_name,
        },
    }


def summarize(results, quotas, payload_objects):
    diagnostics = [row["diagnostic"] for row in results]
    confidences = Counter(
        "high" if row["confidence"] >= .8 else "medium" if row["confidence"] >= .65 else "low"
        for row in results
    )
    summary = {
        "processed": len(results),
        "topic_resolved": sum(bool(row["primary_node_id"]) for row in results),
        "subtopic_resolved": sum(row["diagnostic"]["primary_level"] == "subtopic" for row in results),
        "concept_resolved": sum(bool(row["primary_concept_id"]) for row in results),
        "high_confidence": confidences["high"],
        "medium_confidence": confidences["medium"],
        "low_confidence": confidences["low"],
        "unresolved": sum(not row["primary_node_id"] for row in results),
        "primary_assignments": sum(bool(row["primary_node_id"]) for row in results),
        "secondary_paths": sum(len(row["secondaries"]) for row in results),
        "source_test_supported": sum(row["diagnostic"]["basis"] in ("source_test_supported", "source_topic_only") for row in results),
        "explanation_supported": sum(row["diagnostic"]["explanation_supported"] for row in results),
        "content_overrides": sum(row["diagnostic"]["basis"] == "content_override" for row in results),
        "pyq": sum(row["diagnostic"]["is_pyq"] for row in results),
        "media_edge_cases": sum(row["diagnostic"]["has_media"] for row in results),
        "minimal_explanation": sum(row["diagnostic"]["explanation_length"] < 80 for row in results),
        "negative_questions": sum(row["diagnostic"].get("polarity") == "negative" for row in results),
        "sparse_evidence": sum(bool(row["evidence_kind"]) for row in results),
        "subject_counts": quotas,
        "payload_objects_read": payload_objects,
    }
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-exact-1000", action="store_true")
    parser.add_argument("--resume-report", action="store_true", help="Reuse the verified saved 1,000-question selection/evidence")
    parser.add_argument("--apply-saved-output", action="store_true", help="Commit the already generated v2 report without rehydrating payloads")
    args = parser.parse_args()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not key:
        print("FAIL: SUPABASE_SERVICE_ROLE_KEY is not visible", file=sys.stderr)
        return 2
    if args.apply_saved_output:
        if not REPORT_PATH.exists():
            raise RuntimeError("Saved v2 classification report is missing")
        saved = json.loads(REPORT_PATH.read_text())
        if (
            saved.get("scope_key") != SCOPE_KEY
            or saved.get("classifier_version") != CLASSIFIER_VERSION
            or len(saved.get("results", [])) != BATCH_SIZE
        ):
            raise RuntimeError("Saved v2 output is missing, stale, or corrupted")
        version_id = saved["taxonomy_version_id"]
        results = saved["results"]
        summary = saved["summary"]
    elif args.resume_report:
        if not REPORT_PATH.exists():
            raise RuntimeError("Saved 1,000-question report is missing")
        saved = json.loads(REPORT_PATH.read_text())
        if saved.get("scope_key") != SCOPE_KEY or len(saved.get("results", [])) != BATCH_SIZE:
            raise RuntimeError("Saved selection is missing or corrupted")
        cohort = fetch_saved_cohort(key, saved)
        version_id, nodes, entries = fetch_taxonomy(key)
        evidence, object_count = hydrate(key, cohort)
        results = [classify(entries, nodes, row) for row in evidence]
        summary = summarize(
            results,
            saved["summary"]["subject_counts"],
            object_count,
        )
    else:
        candidates = fetch_metadata(key)
        chosen, quotas = pick_representative(candidates)
        version_id, nodes, entries = fetch_taxonomy(key)
        evidence, object_count = hydrate(key, chosen)
        results = [classify(entries, nodes, row) for row in evidence]
        summary = summarize(results, quotas, object_count)
    if len(results) != BATCH_SIZE or len({row["question_id"] for row in results}) != BATCH_SIZE:
        raise RuntimeError("Classifier output is not exactly 1,000 unique questions")
    configuration_sha256 = (
        saved["configuration_sha256"] if args.apply_saved_output else hashlib.sha256(
            Path(__file__).read_bytes() + VOCABULARY_PATH.read_bytes()
        ).hexdigest()
    )
    report = {
        "scope_key": SCOPE_KEY,
        "taxonomy_version_id": version_id,
        "classifier_version": CLASSIFIER_VERSION,
        "configuration_sha256": configuration_sha256,
        "summary": summary,
        "results": results,
    }
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(summary, indent=2, sort_keys=True))
    print(f"Detailed local review report: {REPORT_PATH}")
    if args.apply:
        if not args.confirm_exact_1000:
            raise RuntimeError("--apply requires --confirm-exact-1000")
        compact = []
        for row in results:
            item = {field: value for field, value in row.items() if field != "diagnostic"}
            # Transient input for a derived tsvector review-search index. The
            # canonical layer never stores this question stem as text.
            item["review_search_text"] = row["diagnostic"]["stem"]
            compact.append(item)
        response = retry_request(key, "/rest/v1/rpc/qbank_reclassify_canonical_batch_v2", "POST", {
            "p_taxonomy_version_key": VERSION_KEY,
            "p_source_scope_key": SCOPE_KEY,
            "p_new_scope_key": RECLASS_SCOPE_KEY,
            "p_classifier_version": CLASSIFIER_VERSION,
            "p_configuration_sha256": configuration_sha256,
            "p_batch": compact,
            "p_summary": summary,
        })
        print("Committed compact classification batch:")
        print(json.dumps(response, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
