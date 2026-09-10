#!/usr/bin/env python3
"""Extract and classify only the bounded Canonical Taxonomy v1 draft sample.

The service-role key is required because hybrid question payloads are private.
Without --apply this command is read-only and writes its report to /tmp.
"""

from __future__ import annotations

import argparse
import gzip
import html
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SUPABASE_URL = "https://flulljensjugfcxmeczu.supabase.co"
VERSION_KEY = "canonical-medical-v1"
REPORT_PATH = Path("/tmp/qbank-taxonomy-draft-classifier.json")
VOCABULARY_PATH = Path(__file__).with_name("taxonomy-concept-vocabulary-v1.json")


def request(key: str, path: str, method: str = "GET", payload=None, extra_headers=None):
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{SUPABASE_URL}{path}", data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {path} failed ({error.code}): {detail}") from error


def storage_download(key: str, bucket: str, object_path: str) -> bytes:
    path = "/storage/v1/object/" + urllib.parse.quote(bucket, safe="") + "/" + urllib.parse.quote(object_path, safe="/")
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    with urllib.request.urlopen(urllib.request.Request(f"{SUPABASE_URL}{path}", headers=headers), timeout=90) as response:
        return response.read()


def plain(value) -> str:
    text = re.sub(r"<script\b[^>]*>[\s\S]*?</script>", " ", str(value or ""), flags=re.I)
    text = re.sub(r"<style\b[^>]*>[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<br\s*/?>|</(?:p|li|div|h[1-6]|tr)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"[ \t]+", " ", re.sub(r"\n+", "\n", text)).strip()


def normalize(value) -> str:
    value = "".join(character for character in plain(value) if unicodedata.category(character) != "Cf")
    value = value.lower().replace("anaesthetic", "anesthetic").replace("paediatric", "pediatric")
    value = re.sub(r"[^a-z0-9+]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def positive_explanation(explanation, correct_text: str) -> str:
    text = plain(explanation)
    if not text:
        return ""
    parts = [part.strip() for part in re.split(r"\n+|(?<=[.!?])\s+", text) if part.strip()]
    correct_terms = {word for word in normalize(correct_text).split() if len(word) > 3}
    positive = []
    for index, part in enumerate(parts):
        lowered = part.lower()
        words = set(normalize(part).split())
        strong = bool(correct_terms and words & correct_terms)
        cue = bool(re.search(r"\b(correct|answer|diagnosis|because|caused by|due to|characterized by|hallmark|treatment|objective)\b", lowered))
        distractor = bool(re.search(r"\b(other option|incorrect|not correct|options?\s+[a-z]\b|whereas)\b", lowered))
        if (strong or cue or index < 3) and not distractor:
            positive.append(part)
        if sum(map(len, positive)) > 3500:
            break
    return " ".join(positive)[:4000]


def chunks(values, size=80):
    for index in range(0, len(values), size):
        yield values[index:index + size]


def in_filter(ids):
    return urllib.parse.quote("in.(" + ",".join(ids) + ")", safe="(),.-")


def fetch_sample(key: str, version_id: str):
    sample = request(key, "/rest/v1/canonical_taxonomy_draft_sample?select=question_id,platform,source_test,existing_subject,is_pyq,sample_order,proposed_node_id,proposed_system,proposed_topic,proposed_subtopic,proposed_path,classifier_confidence,ambiguity,cross_subject_ambiguity,classification_level,classification_basis&order=sample_order&limit=500")
    if not 300 <= len(sample) <= 500:
        raise RuntimeError(f"Refusing to process an unbounded sample of {len(sample)} rows")
    ids = [row["question_id"] for row in sample]
    baseline_rows = request(key, f"/rest/v1/canonical_taxonomy_draft_evidence?select=question_id,evidence_metadata&taxonomy_version_id=eq.{version_id}&limit=500")
    baselines = {row["question_id"]: row["evidence_metadata"] for row in baseline_rows}
    for row in sample:
        row["baseline"] = baselines.get(row["question_id"])
    questions = {}
    payload_refs = {}
    for batch in chunks(ids):
        filt = in_filter(batch)
        rows = request(key, f"/rest/v1/questions?select=id,question_text,options,correct_answer,explanation_html&id={filt}")
        questions.update({row["id"]: row for row in rows})
        refs = request(key, f"/rest/v1/qbank_question_payloads?select=question_id,payload_index,correct_option_keys,qbank_payload_objects(bucket_id,object_path,compression)&question_id={filt}")
        payload_refs.update({row["question_id"]: row for row in refs})
    return sample, questions, payload_refs


def fetch_taxonomy(key: str):
    versions = request(key, f"/rest/v1/canonical_taxonomy_versions?select=id&version_key=eq.{VERSION_KEY}&status=eq.draft&limit=1")
    if len(versions) != 1:
        raise RuntimeError("Canonical Taxonomy v1 draft version is missing")
    version_id = versions[0]["id"]
    nodes = request(key, f"/rest/v1/canonical_taxonomy_nodes?select=id,parent_id,node_type,stable_code,name,metadata&taxonomy_version_id=eq.{version_id}&limit=1200")
    rules = request(key, f"/rest/v1/canonical_taxonomy_draft_rules?select=taxonomy_node_id,match_phrase,evidence_weight,evidence_basis&taxonomy_version_id=eq.{version_id}&enabled=eq.true&limit=2000")
    return version_id, nodes, rules


def slug(value: str) -> str:
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", normalize(value)))


def token_set(value: str):
    stop = {"and", "the", "for", "with", "from", "into", "that", "this", "part", "test", "question", "questions", "previous", "year", "years", "general"}
    return {word for word in normalize(value).split() if len(word) > 2 and word not in stop}


def alias_match(alias: str, value: str) -> float:
    alias_norm, value_norm = normalize(alias), normalize(value)
    if not alias_norm or not value_norm:
        return 0.0
    alias_tokens = token_set(alias_norm)
    if not alias_tokens:
        return 0.0
    # A single generic taxonomy word is not enough evidence for a medical
    # classification. These tokens occur across many unrelated branches and
    # previously allowed e.g. "synthesis" to beat a precise module title.
    generic_singletons = {
        "assessment", "clinical", "development", "disorder", "disorders",
        "disease", "diseases", "evaluation", "general", "management",
        "hearing", "hormonal", "imaging", "infection", "infections",
        "metabolism", "mood", "principles", "sinus", "sinuses", "syndrome",
        "synthesis", "therapy", "treatment", "tumor", "tumors", "viral",
    }
    if len(alias_tokens) == 1:
        token = next(iter(alias_tokens))
        if token in generic_singletons:
            return 0.0
        if alias_norm == value_norm and len(token) >= 2:
            return 1.0
        return .72 if token in token_set(value_norm) and len(token) >= 6 else 0.0
    if re.search(rf"(?:^| )({re.escape(alias_norm)})(?: |$)", value_norm):
        return 1.0 + min(len(alias_tokens), 4) * .18
    value_tokens = token_set(value_norm)
    overlap = len(alias_tokens & value_tokens)
    if overlap >= 2 and overlap / len(alias_tokens) >= .6:
        return .55 + .35 * overlap / len(alias_tokens)
    return 0.0


def resolve_node(nodes, subject, topic, subtopic=None):
    candidates = [node for node in nodes if node["metadata"].get("subject") == subject and node["node_type"] == ("subtopic" if subtopic else "topic")]
    expected = subtopic or topic
    exact = [node for node in candidates if normalize(node["name"]) == normalize(expected)
             and (not subtopic or normalize(node["metadata"].get("topic")) == normalize(topic))]
    if exact:
        return exact[0]
    containing = [node for node in candidates
                  if (not subtopic or normalize(node["metadata"].get("topic")) == normalize(topic))
                  and (normalize(expected) in normalize(node["name"]) or normalize(node["name"]) in normalize(expected))]
    if len(containing) == 1:
        return containing[0]
    if subtopic:
        return resolve_node(nodes, subject, topic)
    return None


def build_vocabulary(nodes, rules):
    aliases_by_node = defaultdict(list)
    for rule in rules:
        aliases_by_node[rule["taxonomy_node_id"]].append(rule["match_phrase"])
    entries = []
    for node in nodes:
        if node["node_type"] not in ("topic", "subtopic"):
            continue
        metadata = node["metadata"]
        entries.append({
            "subject": metadata.get("subject"), "topic": metadata.get("topic") or node["name"],
            "subtopic": metadata.get("subtopic"), "concept": node["name"] if node["node_type"] == "subtopic" else None,
            "aliases": list(dict.fromkeys([node["name"], *aliases_by_node[node["id"]]])),
            "node": node, "curated": False, "parent_concept": None,
        })
    curated = json.loads(VOCABULARY_PATH.read_text())["concepts"]
    missing_targets = []
    for concept in curated:
        node = resolve_node(nodes, concept["subject"], concept["topic"], concept.get("subtopic"))
        if not node:
            missing_targets.append(f"{concept['subject']} → {concept['topic']} → {concept.get('subtopic')}")
            continue
        entries.append({**concept, "node": node, "curated": True})
    return entries, sorted(set(missing_targets))


def best_matches(entries, row):
    source_broad = bool(re.search(r"previous year|grand test|mock|mixed question|rapid revision|comprehensive", normalize(row["source_test"])))
    candidates = []
    for entry in entries:
        if entry["subject"] != row["subject"]:
            continue
        aliases = list(dict.fromkeys([*entry["aliases"], entry["topic"], entry.get("subtopic") or ""]))
        source = 0 if source_broad else max((alias_match(alias, row["source_test"]) for alias in aliases), default=0) * 3.2
        stem = max((alias_match(alias, row["stem_text"]) for alias in aliases), default=0) * 3.8
        correct = max((alias_match(alias, row["correct_answer_text"]) for alias in aliases), default=0) * 7.0
        positive = max((alias_match(alias, row["explanation_positive_text"]) for alias in aliases), default=0) * 4.8
        content = stem + correct + positive
        # Prefer a curated, medically named concept over a broad hierarchy
        # label when their evidence is otherwise close. This is a ranking
        # tiebreaker, not synthetic evidence and does not raise confidence.
        curated_tiebreak = 1.2 if entry["curated"] and content else 0.0
        total = content + source + curated_tiebreak
        if total:
            candidates.append({**entry, "source_score": source, "stem_score": stem, "correct_score": correct, "positive_score": positive, "content_score": content, "score": total})
    candidates.sort(key=lambda item: (item["score"], item["content_score"], bool(item["curated"])), reverse=True)
    source_candidates = sorted(
        (item for item in candidates if item["source_score"]),
        key=lambda item: (item["source_score"], item["content_score"], bool(item["curated"])),
        reverse=True,
    )
    content_candidates = sorted((item for item in candidates if item["content_score"]), key=lambda item: item["content_score"], reverse=True)
    return candidates, (source_candidates[0] if source_candidates else None), (content_candidates[0] if content_candidates else None)


def topic_name(item):
    return item["node"]["metadata"].get("topic") or (item["node"]["name"] if item["node"]["node_type"] == "topic" else item["topic"])


def classify(entries, row):
    candidates, source, content = best_matches(entries, row)
    selected = None
    basis = "unclassifiable"
    if source and content:
        if topic_name(source) == topic_name(content):
            selected = content if content["content_score"] >= 3.5 else source
            basis = "source_topic_supported"
        elif source["content_score"] >= content["content_score"] * .75:
            # The source title and question both support the source-side Topic;
            # prefer that combined evidence over a marginally stronger broad
            # phrase elsewhere in the stem/explanation.
            selected, basis = source, "source_topic_supported"
        elif source["source_score"] >= 4.0 and source["content_score"] >= 4.0:
            # Both paths have substantial positive evidence. Keep the stronger
            # content proposal visible, but require human review rather than
            # claiming a confident source override.
            selected, basis = content, "ambiguous"
        elif content["content_score"] >= 7.0:
            selected, basis = content, "content_override"
        else:
            selected, basis = source, "ambiguous"
    elif content and content["content_score"] >= 3.5:
        selected, basis = content, "content_only"
    elif source and source["source_score"] >= 2.3:
        selected, basis = source, "source_topic_supported"

    if not selected:
        if row.get("before_node_id") and row.get("before_path"):
            return {"question_id": row["question_id"], "proposed_node_id": row["before_node_id"], "proposed_system": row.get("before_system"),
                    "proposed_topic": row.get("before_topic"), "proposed_subtopic": row.get("before_subtopic"), "proposed_path": row["before_path"],
                    "proposed_concept": None, "proposed_concept_path": None, "classifier_confidence": row["before_confidence"],
                    "concept_confidence": 0, "ambiguity": row["before_ambiguity"], "cross_subject_ambiguity": False,
                    "classification_basis": "content_only", "classification_level": row.get("before_level") or "topic",
                    "source_evidence_topic": topic_name(source) if source else None, "source_topic_supported": False,
                    "content_override": False, "reason": "Existing draft classification retained; v3 found no stronger positive evidence.",
                    "evidence_usage": {"subject_prior": True, "source_topic": bool(source), "stem": False, "correct_answer": False, "explanation_positive": False}}
        return {"question_id": row["question_id"], "proposed_node_id": None, "proposed_system": None, "proposed_topic": None,
                "proposed_subtopic": None, "proposed_path": None, "proposed_concept": None, "proposed_concept_path": None,
                "classifier_confidence": 0, "concept_confidence": 0, "ambiguity": False, "cross_subject_ambiguity": False,
                "classification_basis": "unclassifiable", "classification_level": "unclassifiable", "source_evidence_topic": topic_name(source) if source else None,
                "source_topic_supported": False, "content_override": False, "reason": "Insufficient positive evidence after using subject, source title, stem, correct answer and explanation.",
                "evidence_usage": {"subject_prior": True, "source_topic": bool(source), "stem": False, "correct_answer": False, "explanation_positive": False}}

    node = selected["node"]
    metadata = node["metadata"]
    content_score = selected["content_score"]
    second = next((item for item in candidates if topic_name(item) != topic_name(selected)), None)
    ambiguous = basis == "ambiguous" or bool(second and second["score"] >= selected["score"] * .9)
    subtopic = metadata.get("subtopic") if (selected["content_score"] >= 3.5 or node["node_type"] == "subtopic") else None
    concept = selected.get("concept") if selected.get("curated") and selected["content_score"] >= 3.5 else None
    path = metadata.get("path")
    if node["node_type"] == "subtopic" and not subtopic:
        topic_node = next((entry["node"] for entry in entries if entry["subject"] == row["subject"] and entry["node"]["node_type"] == "topic" and entry["node"]["name"] == metadata.get("topic")), node)
        node, metadata, path = topic_node, topic_node["metadata"], topic_node["metadata"].get("path")
    concept_path = f"{path} → {concept}" if concept else None
    if concept and selected.get("parent_concept"):
        concept_path = f"{path} → {selected['parent_concept']} → {concept}"
    confidence = min(.97, .48 + selected["score"] / 28)
    if ambiguous:
        confidence = min(confidence, .64)
    concept_confidence = min(.97, .55 + content_score / 25) if concept else 0
    if basis == "source_topic_supported" and concept:
        reason = "Subject constrained the search; source title supported the Topic; positive question evidence identified the canonical concept."
    elif basis == "source_topic_supported":
        reason = "Subject constrained the search and the source title supported the closest canonical Topic."
    elif basis == "content_override":
        reason = "Stem, correct answer or positive explanation outweighed a conflicting source-title Topic."
    elif basis == "ambiguous":
        reason = "Source-title and positive content evidence support different Topics; retained for review."
    elif concept:
        reason = "Correct answer and positive question/explanation evidence identified a known canonical concept."
    else:
        reason = "Positive stem, correct-answer or explanation evidence resolved the canonical path."
    return {
        "question_id": row["question_id"], "proposed_node_id": node["id"], "proposed_system": metadata.get("system"),
        "proposed_topic": metadata.get("topic") or node["name"], "proposed_subtopic": subtopic, "proposed_path": path,
        "proposed_concept": concept, "proposed_concept_path": concept_path, "classifier_confidence": round(confidence, 4),
        "concept_confidence": round(concept_confidence, 4), "ambiguity": ambiguous, "cross_subject_ambiguity": False,
        "classification_basis": basis, "classification_level": "concept" if concept else ("subtopic" if subtopic else "topic"),
        "source_evidence_topic": topic_name(source) if source else None, "source_topic_supported": basis == "source_topic_supported",
        "content_override": basis == "content_override", "reason": reason,
        "evidence_usage": {"subject_prior": True, "source_topic": bool(source and source["source_score"]),
                           "stem": bool(selected["stem_score"]), "correct_answer": bool(selected["correct_score"]),
                           "explanation_positive": bool(selected["positive_score"])},
    }


def hydrate_evidence(key: str, sample, questions, payload_refs):
    object_refs = {}
    for ref in payload_refs.values():
        obj = ref["qbank_payload_objects"]
        object_refs[(obj["bucket_id"], obj["object_path"])] = obj
    object_cache = {}

    def download(item):
        cache_key, obj = item
        raw = storage_download(key, *cache_key)
        if obj.get("compression") == "gzip":
            raw = gzip.decompress(raw)
        return cache_key, json.loads(raw)

    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(download, item) for item in object_refs.items()]
        for completed, future in enumerate(as_completed(futures), 1):
            cache_key, document = future.result()
            object_cache[cache_key] = document
            if completed % 50 == 0:
                print(f"Loaded {completed}/{len(futures)} bounded payload objects", flush=True)

    evidence = []
    for row in sample:
        question = questions[row["question_id"]]
        stem = question.get("question_text") or ""
        options = question.get("options") or []
        explanation = question.get("explanation_html") or ""
        correct_keys = [part.strip().upper() for part in str(question.get("correct_answer") or "").split(",") if part.strip()]
        ref = payload_refs.get(row["question_id"])
        if ref:
            obj = ref["qbank_payload_objects"]
            cache_key = (obj["bucket_id"], obj["object_path"])
            payload = object_cache[cache_key]["questions"][int(ref["payload_index"])]
            stem = payload.get("question_html") or stem
            options = payload.get("options") or []
            explanation = payload.get("explanation_html") or ""
            correct_keys = payload.get("correct_keys") or ref.get("correct_option_keys") or correct_keys
        option_map = {}
        for index, option in enumerate(options):
            if isinstance(option, dict):
                option_map[str(option.get("key") or chr(65 + index)).upper()] = plain(option.get("html") or option.get("text") or "")
            else:
                option_map[chr(65 + index)] = plain(option)
        correct_text = " | ".join(option_map.get(str(key).upper(), "") for key in correct_keys).strip(" |")
        evidence.append({
            "question_id": row["question_id"], "subject": row["existing_subject"], "platform": row["platform"],
            "source_test": row.get("source_test") or "", "stem_text": plain(stem), "correct_answer_text": correct_text,
            "explanation_positive_text": positive_explanation(explanation, correct_text),
            "explanation_text": plain(explanation)[:12000], "correct_keys": correct_keys,
            "before_path": (row.get("baseline") or {}).get("before_path", row.get("proposed_path")),
            "before_confidence": float((row.get("baseline") or {}).get("before_confidence", row.get("classifier_confidence")) or 0),
            "before_ambiguity": bool((row.get("baseline") or {}).get("before_ambiguity", row.get("ambiguity"))),
            "before_cross_subject": bool((row.get("baseline") or {}).get("before_cross_subject", row.get("cross_subject_ambiguity"))),
            "before_level": (row.get("baseline") or {}).get("before_level", row.get("classification_level")),
            "before_basis": (row.get("baseline") or {}).get("before_basis", row.get("classification_basis")),
            "before_node_id": row.get("proposed_node_id"), "before_system": row.get("proposed_system"),
            "before_topic": row.get("proposed_topic"), "before_subtopic": row.get("proposed_subtopic"),
        })
    return evidence, len(object_cache)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Persist bounded evidence/predictions after migration is installed")
    args = parser.parse_args()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not key:
        print("FAIL: SUPABASE_SERVICE_ROLE_KEY is not visible", file=sys.stderr)
        return 2
    version_id, nodes, rules = fetch_taxonomy(key)
    sample, questions, refs = fetch_sample(key, version_id)
    evidence, object_count = hydrate_evidence(key, sample, questions, refs)
    entries, missing_targets = build_vocabulary(nodes, rules)
    predictions = [classify(entries, row) for row in evidence]
    prediction_by_id = {row["question_id"]: row for row in predictions}
    previously_unclassified_resolved = [row for row in evidence if row["before_confidence"] == 0 and prediction_by_id[row["question_id"]]["classifier_confidence"] > 0]
    remaining_unclassified = [row for row in evidence if prediction_by_id[row["question_id"]]["classifier_confidence"] == 0]
    source_helped = [row for row in evidence if prediction_by_id[row["question_id"]]["source_topic_supported"]]
    explanation_helped = [row for row in evidence if prediction_by_id[row["question_id"]]["evidence_usage"]["explanation_positive"]]
    content_overrides = [row for row in evidence if prediction_by_id[row["question_id"]]["content_override"]]
    report = {
        "version": VERSION_KEY, "taxonomy_version_id": version_id, "sample_size": len(sample), "payload_objects_downloaded": object_count,
        "hybrid_questions": len(refs), "vocabulary_entries": len(entries), "curated_concepts": sum(bool(entry["curated"]) for entry in entries),
        "missing_vocabulary_targets": missing_targets, "evidence": evidence, "predictions": predictions,
        "before": {
            "high": sum(row["before_confidence"] >= .8 and not row["before_ambiguity"] and not row["before_cross_subject"] for row in evidence),
            "ambiguous": sum(row["before_ambiguity"] for row in evidence),
            "unclassifiable": sum(row["before_confidence"] == 0 for row in evidence),
            "cross_subject": sum(row["before_cross_subject"] for row in evidence),
            "topic_resolved": sum(bool(row["before_path"]) for row in evidence),
            "subtopic_resolved": sum(row.get("before_level") == "subtopic" for row in evidence),
        },
        "after": {
            "high": sum(row["classifier_confidence"] >= .8 and not row["ambiguity"] and not row["cross_subject_ambiguity"] for row in predictions),
            "ambiguous": sum(row["ambiguity"] for row in predictions),
            "unclassifiable": len(remaining_unclassified),
            "cross_subject": sum(row["cross_subject_ambiguity"] for row in predictions),
            "topic_resolved": sum(bool(row["proposed_topic"]) for row in predictions),
            "subtopic_resolved": sum(bool(row["proposed_subtopic"]) for row in predictions),
            "concept_resolved": sum(bool(row["proposed_concept"]) for row in predictions),
        },
        "case_counts": {
            "previously_unclassifiable_resolved": len(previously_unclassified_resolved),
            "source_topic_helped": len(source_helped),
            "explanation_positive_helped": len(explanation_helped),
            "remaining_unclassifiable": len(remaining_unclassified),
            "content_overrides": len(content_overrides),
        },
        "override_diagnostics": [
            {
                "question_id": row["question_id"],
                "candidates": [
                    {"topic": topic_name(item), "concept": item.get("concept"), "curated": item["curated"],
                     "score": round(item["score"], 3), "source": round(item["source_score"], 3),
                     "stem": round(item["stem_score"], 3), "correct": round(item["correct_score"], 3),
                     "explanation": round(item["positive_score"], 3)}
                    for item in best_matches(entries, row)[0][:5]
                ],
            }
            for row in evidence if prediction_by_id[row["question_id"]]["content_override"]
        ],
    }
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({key: value for key, value in report.items() if key not in ("evidence", "predictions")}, indent=2))
    print(f"Evidence report: {REPORT_PATH}")
    if args.apply:
        gates = report["case_counts"]
        if not (gates["previously_unclassifiable_resolved"] >= 20 and gates["source_topic_helped"] >= 10
                and gates["explanation_positive_helped"] >= 10 and 5 <= gates["remaining_unclassifiable"] <= 40
                and gates["content_overrides"] >= 5):
            raise RuntimeError(f"Dry-run acceptance gates failed: {gates}")
        concepts = json.loads(VOCABULARY_PATH.read_text())["concepts"]
        evidence_payload = [{key: row.get(key) for key in (
            "question_id", "subject", "platform", "source_test", "stem_text", "correct_answer_text",
            "explanation_positive_text", "correct_keys", "before_path", "before_confidence", "before_ambiguity",
            "before_cross_subject", "before_level", "before_basis"
        )} for row in evidence]
        applied = request(key, "/rest/v1/rpc/qbank_refresh_taxonomy_draft_v3", "POST", {
            "p_version_key": VERSION_KEY, "p_concepts": concepts,
            "p_evidence": evidence_payload, "p_predictions": predictions,
        })
        print("Applied bounded draft refresh:")
        print(json.dumps(applied, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
