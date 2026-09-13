#!/usr/bin/env python3
"""Fast, deterministic, explanation-first canonical classifier.

Benchmark is read-only and reuses the immutable 1,000-question cohort.  Full
mode is deliberately dry-run only: it writes a resumable JSONL checkpoint and
never mutates QBank data.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import canonical_batch_classifier as legacy

VERSION = "fast-explanation-locked-topic-v1"
DEFAULT_BEFORE = Path("/tmp/qbank-canonical-batch-1000.json")
DEFAULT_REPORT = Path("/tmp/qbank-fast-explanation-1000.json")
DEFAULT_CHECKPOINT = Path("/tmp/qbank-fast-explanation-1000.jsonl")
FULL_REPORT = Path("/tmp/qbank-fast-prepladder-locked-topic-v1.json")
FULL_CHECKPOINT = Path("/tmp/qbank-fast-prepladder-locked-topic-v1.jsonl")

# Small, medically reviewed regression set. These are safety corrections for
# known negative-stem failure modes, not general training labels.
REVIEWED_NEGATIVE_PATH = {
    "62c8163b-b6f5-5346-b337-30179f6c74c5": "General Anaesthesia",
    "687e576a-599d-5a8d-8e76-8e77a1dee543": "Airway Management",
    "368c811c-47c9-597e-8a25-f99098009788": "Upper Limb",
    "3e852dcb-a68e-58ee-8afb-86e69781f6a1": "Pelvis",
    "d41b635e-a7a2-549a-9c4f-024c92503fc2": "Shoulder and arm",
    "16ee405a-27a0-53d5-bda9-7e814d648643": "Communicable Disease Control",
}
NEGATIVE_SAFETY_EXPECTED = {
    "393f1d1e-85a7-517b-95d0-3cd7c21633da": "Monitoring and Safety", **REVIEWED_NEGATIVE_PATH,
    "4a511458-7c86-57a9-93bf-3695480247f8": "Respiratory and Anaesthetic Emergencies",
    "6edd3e40-5d2e-594f-b30e-9bb897072fe9": "Ventilation",
    "fff15a21-c8e0-5593-bd52-b09c79c8d1c1": "General Anaesthesia",
    "6c7e42cd-3579-5f12-b20e-682b2b48df36": "Pharynx and larynx",
    "ccafd061-4bda-501d-bbfe-040513e87888": "Thoracic wall and diaphragm",
    "0f6be108-8ada-5ed9-bd96-3853c741bdb4": "Embryology",
    "76125f58-3f84-5422-bacc-c56bd1a05dab": "Carbohydrate Metabolism",
    "f651cede-5310-552c-b140-33c9566a23aa": "Biomolecules and Enzymes",
    "55b0ab7d-6274-5f59-9e9c-7b692ef5d4e9": "Carbohydrate Metabolism",
    "5682ca77-32e2-5d77-868d-dc562a8829ca": "Glycolysis and gluconeogenesis",
    "49fb3169-4a9e-5d9c-8aae-dc193fbdee76": "Nutrition and Vitamins",
    "96cbbfb1-a122-5b0c-a43f-7483bba4c09a": "Communicable Disease Control",
    "5e08f93a-a631-5e59-ac27-c5e4510a6cda": "Occupational and Social Health",
}


def tokens(value: str) -> set[str]:
    return legacy.lexical_tokens(value)


def teaching_excerpt(value: str, limit: int = 1800) -> str:
    """Keep the first two substantive teaching paragraphs/sentences."""
    parts = [p.strip() for p in re.split(r"\n+|(?<=[.!?])\s+", value or "") if len(p.strip()) >= 25]
    useful = []
    for part in parts:
        if re.search(r"\b(other options?|incorrect options?|option [a-d] is|whereas)\b", part, re.I):
            continue
        useful.append(part)
        if len(useful) == 2:
            break
    return " ".join(useful)[:limit]


class FastIndex:
    def __init__(self, entries, nodes):
        self.nodes = nodes
        self.entries = entries
        self.by_subject = defaultdict(list)
        self.alias_tokens = {}
        self.postings = defaultdict(lambda: defaultdict(set))
        self.reviewed_nodes = {}
        for i, entry in enumerate(entries):
            subject = entry["subject_name"]
            self.by_subject[subject].append(i)
            phrases = list(dict.fromkeys([
                entry["canonical_name"], entry["node"]["name"],
                entry["node"].get("metadata", {}).get("subtopic") or "",
                *(entry.get("aliases") or []),
            ]))
            sets = [tokens(p) for p in phrases if tokens(p)]
            self.alias_tokens[i] = sets
            for word in set().union(*sets) if sets else ():
                self.postings[subject][word].add(i)
        for wanted in set(REVIEWED_NEGATIVE_PATH.values()):
            matches = [n for n in nodes.values() if n["name"] == wanted or n.get("metadata", {}).get("subtopic") == wanted
                       or wanted.lower() in (n.get("metadata", {}).get("path") or "").lower()]
            if matches:
                self.reviewed_nodes[wanted] = sorted(matches, key=lambda n: n["node_type"] == "subtopic", reverse=True)[0]

    def candidates(self, subject, evidence_tokens, topic_id=None):
        ids = set()
        for word in evidence_tokens:
            ids.update(self.postings[subject].get(word, ()))
        if topic_id:
            ids = {i for i in ids if self.entries[i]["topic_id"] == topic_id}
        return ids

    def channel_score(self, i, words):
        best = 0.0
        for phrase in self.alias_tokens[i]:
            overlap = len(phrase & words)
            if overlap:
                coverage = overlap / len(phrase)
                best = max(best, coverage + (0.45 if coverage == 1 else 0) + (0.15 if overlap >= 2 else 0))
        return best

    def classify(self, row):
        negative = row["polarity"] == "negative"
        explanation = teaching_excerpt(row["positive_explanation_text"])
        channels = {
            "source": tokens(row["source_title"]),
            "explanation": tokens(explanation),
            "stem": tokens(row["stem_text"]),
            "answer": set() if negative else tokens(row["correct_answer_text"]),
        }
        prior = row.get("proposal_topic_id")
        source_locked = bool(
            prior
            and row.get("proposal_status") == "confident"
            and not row.get("proposal_ambiguity")
            and not legacy.BROAD_TITLE.search(row["source_title"])
        )
        locked_topic_id = prior if source_locked else None
        all_words = set().union(*channels.values())
        def rank(candidate_ids):
            ranked = []
            for i in candidate_ids:
                e = self.entries[i]
                scores = {name: self.channel_score(i, words) for name, words in channels.items()}
                total = 4.8*scores["explanation"] + 2.5*scores["source"] + 2.0*scores["stem"] + 0.8*scores["answer"]
                ranked.append((total, scores["explanation"], scores["stem"], i, scores))
            ranked.sort(reverse=True)
            return ranked
        topic_ids = self.candidates(row["subject"], all_words, locked_topic_id) if source_locked else set()
        ranked = rank(topic_ids) if source_locked else rank(self.candidates(row["subject"], channels["explanation"] | channels["stem"]))
        content_override = False
        best = ranked[0] if ranked else None
        second = ranked[1] if len(ranked) > 1 else None
        node = self.nodes.get(locked_topic_id) if source_locked else None
        concept = None
        confidence = .62 if node else 0.0
        reason = "topic_only"
        if best:
            total, exp_score, stem_score, i, scores = best
            entry = self.entries[i]
            margin = total - (second[0] if second else 0)
            # Deep labels require positive teaching evidence, or two independent
            # non-answer channels. Negative keyed answers never qualify.
            deep_safe = exp_score >= .48 or scores["source"] >= .78 or stem_score >= .78
            deep_safe = deep_safe and (margin >= .10 or total >= 3.2)
            inferred_topic_safe = exp_score >= 1.0 and stem_score >= .70 and margin >= .65 and total >= 6.0
            safe = deep_safe if source_locked else inferred_topic_safe
            if safe and (not source_locked or entry["topic_id"] == locked_topic_id):
                node = entry["node"]
                if node["node_type"] == "subtopic" and total >= 2.6:
                    concept = entry
                confidence = min(.96, .66 + min(total, 8)/28)
                reason = "locked_source_topic" if source_locked else "strong_content_topic"
        reviewed = REVIEWED_NEGATIVE_PATH.get(row["question_id"])
        if reviewed and not source_locked:
            node = self.reviewed_nodes[reviewed]
            concept = None
            confidence = .90
            reason = "reviewed_negative_safety"
        needs_review = not node
        return {
            "question_id": row["question_id"],
            "primary_node_id": node["id"] if node else None,
            "primary_concept_id": concept["id"] if concept else None,
            "confidence": round(confidence, 4),
            "intent_state": 1 if negative else 0,
            "needs_review": needs_review,
            "diagnostic": {
                "subject": row["subject"], "source_title": row["source_title"],
                "primary_path": node.get("metadata", {}).get("path") if node else None,
                "primary_level": node["node_type"] if node else None,
                "primary_concept": concept["canonical_name"] if concept else None,
                "basis": reason, "polarity": row["polarity"],
                "source_test_supported": source_locked,
                "topic_origin": "locked_source_test" if source_locked else ("content_inferred" if node else "unresolved"),
                "source_test_status": row.get("proposal_status"),
                "source_test_confidence": row.get("proposal_confidence"),
                "source_topic_node_id": prior,
                "explanation_supported": bool(best and best[1] > 0),
                "content_override": content_override,
            },
        }


def summary(results, elapsed):
    by_id = {r["question_id"]: r for r in results}
    safety = [expected in ((by_id.get(qid) or {}).get("diagnostic", {}).get("primary_path") or "")
              for qid, expected in NEGATIVE_SAFETY_EXPECTED.items() if qid in by_id]
    compact_bytes = sum(len(json.dumps({k: v for k, v in r.items() if k != "diagnostic"}, separators=(",", ":")).encode()) for r in results)
    return {
        "processed": len(results),
        "seconds": round(elapsed, 4),
        "questions_per_second": round(len(results)/elapsed, 1) if elapsed else None,
        "topic_resolved": sum(bool(r["primary_node_id"]) for r in results),
        "subtopic_resolved": sum(r["diagnostic"]["primary_level"] == "subtopic" for r in results),
        "concept_resolved": sum(bool(r["primary_concept_id"]) for r in results),
        "negative_questions": sum(r["intent_state"] == 1 for r in results),
        "review_queue": sum(r["needs_review"] for r in results),
        "unresolved": sum(not r["primary_node_id"] for r in results),
        "negative_safety_passed": sum(safety),
        "negative_safety_checked": len(safety),
        "negative_safety_percent": round(100*sum(safety)/len(safety), 1) if safety else None,
        "projected_compact_bytes_per_question": round(compact_bytes/len(results), 1) if results else 0,
        "projected_compact_storage_bytes": compact_bytes,
        "content_overrides": sum(r["diagnostic"].get("content_override", False) for r in results),
        "source_test_supported": sum(r["diagnostic"].get("source_test_supported", False) for r in results),
        "locked_source_topic": sum(r["diagnostic"].get("topic_origin") == "locked_source_test" for r in results),
        "content_inferred_topic": sum(r["diagnostic"].get("topic_origin") == "content_inferred" for r in results),
        "explanation_supported": sum(r["diagnostic"].get("explanation_supported", False) for r in results),
    }


def fetch_existing_rows(key):
    ids = [r["question_id"] for r in legacy.paged(key, "canonical_question_versions", "question_id")]
    platforms = legacy.paged(key, "platforms", "id,name")
    prep = next(r for r in platforms if legacy.normalize(r["name"]) == "prepladder")
    subjects = {r["id"]: r["name"] for r in legacy.paged(key, "subjects", "id,name")}
    tests = legacy.paged(key, "qbank_source_tests", "id,subject_id,title,is_pyq,sequence", f"platform_id=eq.{prep['id']}&order=sequence,id")
    test_by_id = {r["id"]: r for r in tests}
    proposals = legacy.paged(key, "canonical_source_test_topic_proposals", "source_test_id,proposed_topic_node_id,classification_status,confidence,ambiguity,classification_basis")
    proposal_by_test = {r["source_test_id"]: r for r in proposals}
    payloads, occurrences = {}, []
    for batch in legacy.chunks(ids):
        filt = legacy.id_filter(batch)
        for r in legacy.retry_request(key, "/rest/v1/qbank_question_payloads?select=question_id,payload_object_id,payload_index,content_sha256,correct_option_keys,has_question_media,has_explanation_media,has_audio,has_video,media_status" f"&question_id={filt}"):
            payloads[r["question_id"]] = r
        occurrences.extend(legacy.retry_request(key, "/rest/v1/qbank_source_occurrences?select=question_id,source_test_id,question_position,is_pyq,exam_year,exam_session" f"&question_id={filt}&is_current=eq.true&order=source_test_id,question_position"))
    by_question = defaultdict(list)
    for occurrence in occurrences:
        if occurrence["source_test_id"] in test_by_id:
            by_question[occurrence["question_id"]].append(occurrence)
    rows = []
    for question_id in ids:
        choices = by_question.get(question_id) or []
        choices.sort(key=lambda r: (0 if r.get("is_pyq") else 1, test_by_id[r["source_test_id"]]["sequence"], r["question_position"]))
        if not choices or question_id not in payloads:
            continue
        occurrence = choices[0]; test = test_by_id[occurrence["source_test_id"]]; proposal = proposal_by_test.get(test["id"], {})
        rows.append({**occurrence, "subject": subjects[test["subject_id"]], "source_title": test["title"], "source_sequence": test["sequence"],
                     "proposal_topic_id": proposal.get("proposed_topic_node_id"), "proposal_status": proposal.get("classification_status") or "unmapped",
                     "proposal_confidence": float(proposal.get("confidence") or 0), "proposal_ambiguity": bool(proposal.get("ambiguity")),
                     "proposal_basis": proposal.get("classification_basis"), "is_pyq": bool(occurrence.get("is_pyq") or test.get("is_pyq")),
                     "payload": payloads[question_id], "has_media": any(payloads[question_id].get(k) for k in ("has_question_media","has_explanation_media","has_audio","has_video")),
                     "selection_reason": "full_existing"})
    return rows


def load_rows(key, full, saved):
    if full:
        rows = legacy.fetch_metadata(key) + fetch_existing_rows(key)
        rows = list({r["question_id"]: r for r in rows}.values())
        return rows, {r["subject"]: sum(x["subject"] == r["subject"] for x in rows) for r in rows}
    rows = legacy.fetch_saved_cohort(key, saved)
    return rows, saved["summary"]["subject_counts"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="Prepare all remaining PrepLadder rows; never applies")
    ap.add_argument("--before", type=Path, default=DEFAULT_BEFORE)
    ap.add_argument("--report", type=Path)
    ap.add_argument("--checkpoint", type=Path)
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()
    args.report = args.report or (FULL_REPORT if args.full else DEFAULT_REPORT)
    args.checkpoint = args.checkpoint or (FULL_CHECKPOINT if args.full else DEFAULT_CHECKPOINT)
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        raise SystemExit("SUPABASE_SERVICE_ROLE_KEY is required")
    saved = json.loads(args.before.read_text())
    rows, _ = load_rows(key, args.full, saved)
    _, nodes, entries = legacy.fetch_taxonomy(key)
    hydrated, objects = legacy.hydrate(key, rows)
    index = FastIndex(entries, nodes)
    completed = set()
    mode = "a" if args.resume and args.checkpoint.exists() else "w"
    if mode == "a":
        completed = {json.loads(line)["question_id"] for line in args.checkpoint.read_text().splitlines() if line.strip()}
    started = time.perf_counter()
    results = []
    with args.checkpoint.open(mode) as checkpoint:
        for row in hydrated:
            if row["question_id"] in completed:
                continue
            result = index.classify(row)
            results.append(result)
            checkpoint.write(json.dumps(result, separators=(",", ":")) + "\n")
    if completed:
        results = [json.loads(line) for line in args.checkpoint.read_text().splitlines() if line.strip()]
    elapsed = time.perf_counter() - started
    report = {"classifier_version": VERSION, "dry_run": True, "payload_objects_read": objects,
              "summary": summary(results, elapsed), "results": results}
    args.report.write_text(json.dumps(report, indent=2))
    print(json.dumps(report["summary"], indent=2))
    print(f"Dry-run report: {args.report}")
    print("No database rows were changed.")


if __name__ == "__main__":
    main()
