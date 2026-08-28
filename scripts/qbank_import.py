#!/usr/bin/env python3
"""Safe, dependency-free HTML -> QBank Hub import pipeline.

Dry-run is the default safety boundary. Database writes are possible only with
--import, an explicit acknowledgement, a service-role key supplied at runtime,
and the service-role-only qbank_import_batch RPC from the additive migration.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import random
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


VERSION = "1.0.0"
DEFAULT_URL = "https://flulljensjugfcxmeczu.supabase.co"
CLASSIFICATIONS = ("NEW", "EXACT EXISTING MATCH", "POSSIBLE DUPLICATE", "INVALID", "CONFLICT")
OPTION_KEY = re.compile(r"^\s*([A-H])\s*[\).:\-]\s*", re.I)
ANSWER_KEY = re.compile(r"(?:answer|correct(?:\s+answer)?)\s*[:\-]?\s*([A-H])\b", re.I)
SPACE = re.compile(r"\s+")
TAG = re.compile(r"<[^>]+>")


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clean(value: Any) -> str:
    return SPACE.sub(" ", str(value or "")).strip()


def normalized_text(value: Any) -> str:
    text = html.unescape(TAG.sub(" ", str(value or "")))
    text = unicodedata.normalize("NFKC", text).casefold()
    return clean(text)


def normalized_name(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", normalized_text(value))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


@dataclass
class Node:
    tag: str
    attrs: Dict[str, str]
    parent: Optional["Node"] = None
    children: List[Any] = field(default_factory=list)

    def text(self) -> str:
        chunks: List[str] = []
        for child in self.children:
            chunks.append(child.text() if isinstance(child, Node) else str(child))
        return clean(" ".join(chunks))

    def inner_html(self) -> str:
        return "".join(render_node(child) if isinstance(child, Node) else html.escape(str(child)) for child in self.children).strip()

    def descendants(self) -> Iterable["Node"]:
        for child in self.children:
            if isinstance(child, Node):
                yield child
                yield from child.descendants()

    def find_all(self, selectors: Sequence[str], include_self: bool = False) -> List["Node"]:
        nodes = ([self] if include_self else []) + list(self.descendants())
        return [node for node in nodes if any(matches_selector(node, selector) for selector in selectors)]

    def first(self, selectors: Sequence[str]) -> Optional["Node"]:
        rows = self.find_all(selectors)
        return rows[0] if rows else None


def render_node(node: Node) -> str:
    attrs = "".join(f' {key}="{html.escape(value, quote=True)}"' for key, value in node.attrs.items())
    if node.tag in {"img", "br", "hr", "input", "meta", "link", "source"}:
        return f"<{node.tag}{attrs}>"
    return f"<{node.tag}{attrs}>{node.inner_html()}</{node.tag}>"


class TreeParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("document", {})
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        node = Node(tag.lower(), {key.lower(): value or "" for key, value in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag.lower() not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.stack[-1].tag == tag.lower():
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag.lower():
                self.stack = self.stack[:index]
                return

    def handle_data(self, data: str) -> None:
        self.stack[-1].children.append(data)


def matches_selector(node: Node, selector: str) -> bool:
    selector = selector.strip()
    if not selector:
        return False
    attr_name = attr_value = None
    attr_match = re.search(r"\[([\w:-]+)(?:=['\"]?([^\]'\"]+)['\"]?)?\]", selector)
    if attr_match:
        attr_name, attr_value = attr_match.group(1).lower(), attr_match.group(2)
        selector = selector[: attr_match.start()] + selector[attr_match.end() :]
    id_match = re.search(r"#([\w-]+)", selector)
    class_names = re.findall(r"\.([\w-]+)", selector)
    tag_match = re.match(r"^[a-zA-Z][\w-]*", selector)
    if tag_match and node.tag != tag_match.group(0).lower():
        return False
    if id_match and node.attrs.get("id") != id_match.group(1):
        return False
    node_classes = set(node.attrs.get("class", "").split())
    if any(name not in node_classes for name in class_names):
        return False
    if attr_name is not None:
        if attr_name not in node.attrs:
            return False
        if attr_value is not None and node.attrs.get(attr_name) != attr_value:
            return False
    return bool(tag_match or id_match or class_names or attr_name)


DEFAULT_PROFILE: Dict[str, Any] = {
    "name": "generic-html",
    "question_selectors": ["[data-question-id]", ".question-card", ".question-item", ".mcq", "article.question", ".question"],
    "stem_selectors": [".question-text", ".question-stem", ".stem", "[data-role=question]", ".prompt", "h3", "h4"],
    "option_selectors": ["[data-option]", ".answer-option", ".option", ".choice", "li"],
    "explanation_selectors": [".explanation", ".answer-explanation", "[data-role=explanation]", ".solution"],
    "answer_selectors": [".correct-answer", "[data-role=answer]", ".answer-key"],
    "taxonomy_selectors": {"system": [".system"], "topic": [".topic"], "subtopic": [".subtopic"]},
}


def load_profile(path: Optional[str]) -> Dict[str, Any]:
    profile = json.loads(stable_json(DEFAULT_PROFILE))
    if path:
        supplied = json.loads(Path(path).read_text(encoding="utf-8"))
        for key, value in supplied.items():
            if key == "taxonomy_selectors":
                profile[key].update(value)
            else:
                profile[key] = value
    return profile


def attr(node: Node, *names: str) -> str:
    for name in names:
        value = clean(node.attrs.get(name))
        if value:
            return value
    return ""


def child_value(node: Node, selectors: Sequence[str]) -> str:
    match = node.first(selectors)
    return match.text() if match else ""


def extract_options(block: Node, profile: Dict[str, Any]) -> List[Dict[str, Any]]:
    candidates = block.find_all(profile["option_selectors"])
    options: List[Dict[str, Any]] = []
    seen_nodes = set()
    for candidate in candidates:
        if id(candidate) in seen_nodes or candidate.first(profile["explanation_selectors"]):
            continue
        raw = clean(candidate.text())
        key = attr(candidate, "data-option", "data-key", "data-option-key")
        key_match = OPTION_KEY.match(raw)
        if not key and key_match:
            key = key_match.group(1)
        key = key.upper() if key else ""
        if not key or not re.fullmatch(r"[A-H]", key):
            continue
        text_value = raw[key_match.end() :] if key_match else raw
        if not clean(text_value):
            continue
        classes = set(candidate.attrs.get("class", "").split())
        marked_correct = attr(candidate, "data-correct", "aria-checked").lower() in {"1", "true", "yes"} or "correct" in classes
        options.append({"key": key, "text": clean(text_value), "html": candidate.inner_html(), "marked_correct": marked_correct})
        seen_nodes.add(id(candidate))
    return sorted(options, key=lambda row: row["key"])


def extract_correct(block: Node, options: Sequence[Dict[str, Any]], profile: Dict[str, Any]) -> str:
    direct = attr(block, "data-correct-answer", "data-answer", "data-correct")
    if direct and re.search(r"[A-H]", direct, re.I):
        return re.search(r"[A-H]", direct, re.I).group(0).upper()  # type: ignore[union-attr]
    marked = [option["key"] for option in options if option.get("marked_correct")]
    if len(marked) == 1:
        return marked[0]
    answer_node = block.first(profile["answer_selectors"])
    match = ANSWER_KEY.search(answer_node.text() if answer_node else "")
    return match.group(1).upper() if match else ""


def parse_html(source: Path, metadata: Dict[str, str], profile: Dict[str, Any]) -> List[Dict[str, Any]]:
    parser = TreeParser()
    parser.feed(source.read_text(encoding="utf-8", errors="replace"))
    candidate_sets = [parser.root.find_all([selector]) for selector in profile["question_selectors"]]
    blocks: List[Node] = max(candidate_sets, key=len, default=[])
    questions: List[Dict[str, Any]] = []
    for position, block in enumerate(blocks, 1):
        stem_node = block.first(profile["stem_selectors"])
        stem = stem_node.inner_html() if stem_node else ""
        if not normalized_text(stem):
            stem = attr(block, "data-question", "data-stem")
        explanation_node = block.first(profile["explanation_selectors"])
        options = extract_options(block, profile)
        correct = extract_correct(block, options, profile)
        taxonomy: Dict[str, str] = {}
        for level in ("platform", "subject", "system", "topic", "subtopic"):
            value = attr(block, f"data-{level}", f"data-{level}-name")
            if not value and level in profile.get("taxonomy_selectors", {}):
                value = child_value(block, profile["taxonomy_selectors"][level])
            taxonomy[level] = clean(value or metadata.get(level, ""))
        source_id = attr(block, "data-question-id", "data-source-id", "data-id")
        if not source_id:
            candidate_id = attr(block, "id")
            source_id = candidate_id if re.search(r"question|mcq|q[-_]?\d", candidate_id, re.I) else ""
        images = [attr(node, "src", "data-src") for node in block.find_all(["img"]) if attr(node, "src", "data-src")]
        questions.append({
            "position": position,
            "source_id": source_id,
            "source_reference": attr(block, "data-source-url", "data-url") or metadata.get("source_reference", ""),
            "source_collection": attr(block, "data-collection", "data-test", "data-source") or metadata.get("source_collection", ""),
            "source_test_label": attr(block, "data-test-label", "data-test") or metadata.get("source_test_label", ""),
            "stem_html": stem,
            "options": [{"key": row["key"], "text": row["text"], "html": row["html"]} for row in options],
            "correct_answer": correct,
            "explanation_html": explanation_node.inner_html() if explanation_node else "",
            "images": list(dict.fromkeys(images)),
            "taxonomy": taxonomy,
            "is_pyq": attr(block, "data-pyq").lower() in {"1", "true", "yes"},
            "exam_year": attr(block, "data-exam-year", "data-year"),
            "exam_session": attr(block, "data-exam-session", "data-session", "data-shift"),
        })
    return questions


def content_fingerprint(question: Dict[str, Any]) -> str:
    canonical = {
        "platform": normalized_name(question["taxonomy"].get("platform")),
        "subject": normalized_name(question["taxonomy"].get("subject")),
        "system": normalized_name(question["taxonomy"].get("system")),
        "topic": normalized_name(question["taxonomy"].get("topic")),
        "subtopic": normalized_name(question["taxonomy"].get("subtopic")),
        "collection": normalized_text(question.get("source_collection")),
        "stem": normalized_text(question.get("stem_html")),
        "options": [(row["key"].upper(), normalized_text(row.get("text") or row.get("html"))) for row in question.get("options", [])],
        "answer": clean(question.get("correct_answer")).upper(),
    }
    return sha256_text(stable_json(canonical))


def source_identity(question: Dict[str, Any]) -> Tuple[str, str]:
    scope = "|".join([
        normalized_name(question["taxonomy"].get("platform")), normalized_name(question["taxonomy"].get("subject")),
        normalized_text(question.get("source_collection")),
    ])
    if clean(question.get("source_id")):
        identity = f"source-id|{scope}|{normalized_text(question['source_id'])}"
    elif clean(question.get("source_reference")):
        identity = f"source-reference|{scope}|{clean(question['source_reference'])}"
    else:
        identity = f"content-fallback|{content_fingerprint(question)}"
    return identity, sha256_text(identity)


def structural_errors(question: Dict[str, Any], snapshot: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    taxonomy = question["taxonomy"]
    if not normalized_text(question.get("stem_html")):
        errors.append("empty question stem")
    options = question.get("options", [])
    if not 2 <= len(options) <= 8:
        errors.append(f"expected 2-8 options, found {len(options)}")
    keys = [row.get("key", "").upper() for row in options]
    if len(keys) != len(set(keys)):
        errors.append("duplicate option keys")
    if any(not normalized_text(row.get("text") or row.get("html")) for row in options):
        errors.append("empty option text")
    answer = clean(question.get("correct_answer")).upper()
    if not answer or answer not in keys:
        errors.append("correct answer does not resolve to exactly one option")
    if not taxonomy.get("platform"):
        errors.append("platform is missing")
    if not taxonomy.get("subject"):
        errors.append("subject is missing")
    if taxonomy.get("subtopic") and not taxonomy.get("topic"):
        errors.append("subtopic is present without a topic")
    platforms = {normalized_name(row.get("name")): row for row in snapshot.get("platforms", [])}
    subjects = {normalized_name(row.get("name")): row for row in snapshot.get("subjects", [])}
    if taxonomy.get("platform") and normalized_name(taxonomy["platform"]) not in platforms:
        errors.append(f"platform does not resolve: {taxonomy['platform']}")
    if taxonomy.get("subject") and normalized_name(taxonomy["subject"]) not in subjects:
        errors.append(f"subject does not resolve: {taxonomy['subject']}")
    return errors


def prepare_existing(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    platform_names = {row["id"]: row.get("name", "") for row in snapshot.get("platforms", [])}
    subject_names = {row["id"]: row.get("name", "") for row in snapshot.get("subjects", [])}
    system_names = {row["id"]: row.get("name", "") for row in snapshot.get("systems", [])}
    topic_names = {row["id"]: row.get("name", "") for row in snapshot.get("topics", [])}
    subtopic_names = {row["id"]: row.get("name", "") for row in snapshot.get("subtopics", [])}
    topics_by_question: Dict[str, List[str]] = defaultdict(list)
    subtopics_by_question: Dict[str, List[str]] = defaultdict(list)
    for row in snapshot.get("question_topics", []):
        if row.get("topic_id") in topic_names:
            topics_by_question[row["question_id"]].append(topic_names[row["topic_id"]])
    for row in snapshot.get("question_subtopics", []):
        if row.get("subtopic_id") in subtopic_names:
            subtopics_by_question[row["question_id"]].append(subtopic_names[row["subtopic_id"]])
    options_by_question: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in snapshot.get("question_options", []):
        options_by_question[row["question_id"]].append({"key": row.get("option_key", ""), "text": row.get("option_text", "")})
    by_source: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    by_reference: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    by_source_fp: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    by_content_fp: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    by_stem: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in snapshot.get("questions", []):
        existing = dict(row)
        existing_question = {
            "taxonomy": {
                "platform": platform_names.get(row.get("platform_id"), ""),
                "subject": subject_names.get(row.get("subject_id"), ""),
                "system": system_names.get(row.get("system_id"), ""),
                "topic": sorted(topics_by_question.get(row["id"], []))[0] if topics_by_question.get(row["id"]) else "",
                "subtopic": sorted(subtopics_by_question.get(row["id"], []))[0] if subtopics_by_question.get(row["id"]) else "",
            },
            "source_collection": row.get("source_collection", ""), "stem_html": row.get("question_text", ""),
            "options": options_by_question.get(row["id"], []), "correct_answer": row.get("correct_answer", ""),
        }
        existing["computed_content_fingerprint"] = row.get("content_fingerprint") or content_fingerprint(existing_question)
        scope = (row.get("platform_id"), row.get("subject_id"), normalized_text(row.get("source_question_id")))
        if scope[2]:
            by_source["|".join(map(str, scope))].append(existing)
        if row.get("source_reference"):
            by_reference[clean(row["source_reference"])].append(existing)
        if row.get("source_fingerprint"):
            by_source_fp[row["source_fingerprint"]].append(existing)
        by_content_fp[existing["computed_content_fingerprint"]].append(existing)
        by_stem[normalized_text(row.get("question_text"))].append(existing)
    return {"by_source": by_source, "by_reference": by_reference, "by_source_fp": by_source_fp, "by_content_fp": by_content_fp, "by_stem": by_stem}


def classify_questions(questions: List[Dict[str, Any]], snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    indexes = prepare_existing(snapshot)
    platforms = {normalized_name(row["name"]): row["id"] for row in snapshot.get("platforms", [])}
    subjects = {normalized_name(row["name"]): row["id"] for row in snapshot.get("subjects", [])}
    source_seen: Dict[str, Dict[str, Any]] = {}
    results: List[Dict[str, Any]] = []
    for question in questions:
        item = dict(question)
        identity, source_fp = source_identity(item)
        content_fp = content_fingerprint(item)
        item.update({"source_identity": identity, "source_fingerprint": source_fp, "content_fingerprint": content_fp})
        errors = structural_errors(item, snapshot)
        classification, reason, existing_id = "NEW", "new stable identity", None
        if errors:
            classification, reason = "INVALID", "; ".join(errors)
        else:
            platform_id = platforms[normalized_name(item["taxonomy"]["platform"])]
            subject_id = subjects[normalized_name(item["taxonomy"]["subject"])]
            source_key = "|".join([platform_id, subject_id, normalized_text(item.get("source_id"))])
            identity_matches = []
            if item.get("source_id"):
                identity_matches.extend(indexes["by_source"].get(source_key, []))
            if item.get("source_reference"):
                identity_matches.extend(indexes["by_reference"].get(clean(item["source_reference"]), []))
            identity_matches.extend(indexes["by_source_fp"].get(source_fp, []))
            identity_matches = list({row["id"]: row for row in identity_matches}.values())
            if identity in source_seen:
                previous = source_seen[identity]
                if previous["content_fingerprint"] == content_fp:
                    classification, reason = "EXACT EXISTING MATCH", "duplicate identity inside source file"
                else:
                    classification, reason = "CONFLICT", "same source identity has different content inside source file"
            elif identity_matches:
                same = [row for row in identity_matches if row["computed_content_fingerprint"] == content_fp]
                if len(same) == 1 and len(identity_matches) == 1:
                    classification, reason, existing_id = "EXACT EXISTING MATCH", "stable source identity and content match", same[0]["id"]
                else:
                    classification, reason = "CONFLICT", "stable source identity resolves to different or multiple existing records"
            elif indexes["by_content_fp"].get(content_fp):
                matches = indexes["by_content_fp"][content_fp]
                if identity.startswith("content-fallback|") and len(matches) == 1:
                    classification, reason, existing_id = "EXACT EXISTING MATCH", "deterministic fallback fingerprint match", matches[0]["id"]
                else:
                    classification, reason = "POSSIBLE DUPLICATE", "content matches an existing record under a different identity"
            elif indexes["by_stem"].get(normalized_text(item.get("stem_html"))):
                classification, reason = "POSSIBLE DUPLICATE", "normalized stem matches existing content; manual review required"
        source_seen.setdefault(identity, item)
        item.update({"classification": classification, "reason": reason, "existing_question_id": existing_id})
        results.append(item)
    return results


def seeded_filter_validation(snapshot: Dict[str, Any], seed: int, samples: int = 192) -> Dict[str, Any]:
    """Compare independent predicate and set-algebra populations reproducibly."""
    rows = snapshot.get("questions", [])
    if not rows:
        return {"status": "PASS", "seed": seed, "samples": 0, "failures": []}
    by_id = {str(row["id"]): row for row in rows}
    topics: Dict[str, set] = defaultdict(set)
    subtopics: Dict[str, set] = defaultdict(set)
    for relation in snapshot.get("question_topics", []):
        topics[str(relation["question_id"])].add(str(relation["topic_id"]))
    for relation in snapshot.get("question_subtopics", []):
        subtopics[str(relation["question_id"])].add(str(relation["subtopic_id"]))
    states: Dict[str, Dict[str, Any]] = {}
    for state in snapshot.get("user_question_state", []):
        states[str(state["question_id"])] = state
    attempted = {str(row["question_id"]) for row in snapshot.get("question_attempts", [])}
    dimensions = {
        "platforms": sorted({str(row.get("platform_id")) for row in rows if row.get("platform_id")}),
        "subjects": sorted({str(row.get("subject_id")) for row in rows if row.get("subject_id")}),
        "systems": sorted({str(row.get("system_id")) for row in rows if row.get("system_id")}),
        "topics": sorted({value for values in topics.values() for value in values}),
        "subtopics": sorted({value for values in subtopics.values() for value in values}),
    }
    status_names = ["all", "new", "incorrect", "correct", "bookmarked", "marked", "recall_due", "my_content"]
    rng = random.Random(seed)
    failures = []

    def status_match(question_id: str, row: Dict[str, Any], statuses: List[str]) -> bool:
        if not statuses or "all" in statuses:
            return True
        state = states.get(question_id, {})
        checks = {
            "new": question_id not in attempted,
            "incorrect": state.get("last_is_correct") is False or bool(state.get("wrong")),
            "correct": state.get("last_is_correct") is True,
            "bookmarked": bool(state.get("bookmarked")),
            "marked": bool(state.get("marked_for_review")),
            "recall_due": bool(state.get("recall_due_at")) and str(state.get("recall_due_at")) <= utc_now(),
            "my_content": row.get("content_origin") == "user",
        }
        return any(checks.get(status, False) for status in statuses)

    for sample_index in range(samples):
        selection: Dict[str, List[str]] = {}
        for level, values in dimensions.items():
            take = 0 if not values or rng.random() < 0.35 else min(len(values), 1 + (1 if rng.random() < 0.25 else 0))
            selection[level] = sorted(rng.sample(values, take)) if take else []
        selection["statuses"] = sorted(rng.sample(status_names, 1 + (1 if rng.random() < 0.15 else 0)))

        predicate_ids = []
        for question_id, row in by_id.items():
            if selection["platforms"] and str(row.get("platform_id")) not in selection["platforms"]:
                continue
            if selection["subjects"] and str(row.get("subject_id")) not in selection["subjects"]:
                continue
            if selection["systems"] and str(row.get("system_id")) not in selection["systems"]:
                continue
            if selection["topics"] and not topics[question_id].intersection(selection["topics"]):
                continue
            if selection["subtopics"] and not subtopics[question_id].intersection(selection["subtopics"]):
                continue
            if status_match(question_id, row, selection["statuses"]):
                predicate_ids.append(question_id)

        sets = [set(by_id)]
        for field, level in (("platform_id", "platforms"), ("subject_id", "subjects"), ("system_id", "systems")):
            if selection[level]:
                sets.append({question_id for question_id, row in by_id.items() if str(row.get(field)) in selection[level]})
        if selection["topics"]:
            sets.append({question_id for question_id in by_id if topics[question_id].intersection(selection["topics"])})
        if selection["subtopics"]:
            sets.append({question_id for question_id in by_id if subtopics[question_id].intersection(selection["subtopics"])})
        sets.append({question_id for question_id, row in by_id.items() if status_match(question_id, row, selection["statuses"])})
        algebra_ids = sorted(set.intersection(*sets))
        predicate_ids = sorted(predicate_ids)
        if predicate_ids != algebra_ids or len(predicate_ids) != len(set(predicate_ids)):
            failures.append({
                "sample": sample_index, "selection": selection,
                "expected_count": len(algebra_ids), "actual_count": len(predicate_ids),
                "expected_ids": algebra_ids[:25], "actual_ids": predicate_ids[:25],
            })
            break
    return {"status": "FAIL" if failures else "PASS", "seed": seed, "samples": samples, "failures": failures}


def api_request(url: str, key: str, path: str, method: str = "GET", payload: Any = None, extra_headers: Optional[Dict[str, str]] = None) -> Tuple[Any, Dict[str, str]]:
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"}
    headers.update(extra_headers or {})
    data = None
    if payload is not None:
        data = stable_json(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url.rstrip("/") + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read().decode("utf-8")
            return (json.loads(body) if body else None), dict(response.headers)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase API {error.code}: {body[:1000]}") from error


def fetch_rows(url: str, key: str, table: str, select: str, page_size: int = 1000) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    encoded = urllib.parse.quote(select, safe="(),*")
    for offset in range(0, 1_000_000_000, page_size):
        page, _ = api_request(url, key, f"/rest/v1/{table}?select={encoded}&offset={offset}&limit={page_size}")
        rows.extend(page or [])
        if not page or len(page) < page_size:
            return rows
    return rows


def count_table(url: str, key: str, table: str, query: str = "") -> int:
    separator = "&" if query else "?"
    _, headers = api_request(url, key, f"/rest/v1/{table}{query}{separator}select=id&limit=1", extra_headers={"Prefer": "count=exact", "Range": "0-0"})
    match = re.search(r"/(\d+)$", headers.get("Content-Range", ""))
    return int(match.group(1)) if match else 0


def fetch_snapshot(url: str, key: str) -> Dict[str, Any]:
    snapshot: Dict[str, Any] = {}
    for table, select in {
        "platforms": "id,name,code", "subjects": "id,name", "platform_subjects": "id,platform_id,subject_id",
        "systems": "id,platform_subject_id,name", "topics": "id,platform_subject_id,system_id,name",
        "subtopics": "id,topic_id,name", "question_topics": "question_id,topic_id", "question_subtopics": "question_id,subtopic_id",
        "question_options": "id,question_id,option_key,option_text,is_correct,sort_order",
        "user_question_state": "user_id,question_id,wrong,bookmarked,last_is_correct,marked_for_review,recall_due_at",
        "question_attempts": "id,user_id,question_id",
    }.items():
        snapshot[table] = fetch_rows(url, key, table, select)
    modern = "id,platform_id,subject_id,system_id,source_question_id,source_reference,source_collection,question_text,correct_answer,content_origin,source_fingerprint,content_fingerprint"
    try:
        snapshot["questions"] = fetch_rows(url, key, "questions", modern)
    except RuntimeError as error:
        if "source_fingerprint" not in str(error) and "content_fingerprint" not in str(error):
            raise
        snapshot["questions"] = fetch_rows(url, key, "questions", "id,platform_id,subject_id,system_id,source_question_id,source_reference,source_collection,question_text,correct_answer,content_origin")
    snapshot["baseline"] = {
        "questions": len(snapshot["questions"]), "options": len(snapshot["question_options"]),
        "attempts": len(snapshot["question_attempts"]), "bookmarks": count_table(url, key, "user_question_state", "?bookmarked=eq.true"),
        "marked_for_review": count_table(url, key, "user_question_state", "?marked_for_review=eq.true"),
        "correct_state": count_table(url, key, "user_question_state", "?last_is_correct=eq.true"),
        "incorrect_state": count_table(url, key, "user_question_state", "?or=(last_is_correct.eq.false,wrong.eq.true)"),
        "sessions": count_table(url, key, "test_sessions"), "session_questions": count_table(url, key, "test_session_questions"),
    }
    return snapshot


def aggregate_report(source: Path, source_hash: str, classified: List[Dict[str, Any]], snapshot: Dict[str, Any], mode: str, seed: int) -> Dict[str, Any]:
    counts = Counter(item["classification"] for item in classified)
    new_rows = [item for item in classified if item["classification"] == "NEW"]
    topic_counts = Counter(clean(item["taxonomy"].get("topic")) or "(unclassified)" for item in classified)
    subtopic_counts = Counter(clean(item["taxonomy"].get("subtopic")) or "(unclassified)" for item in classified)
    platform_counts = Counter(clean(item["taxonomy"].get("platform")) or "(missing)" for item in classified)
    subject_counts = Counter(clean(item["taxonomy"].get("subject")) or "(missing)" for item in classified)
    before_q = int(snapshot.get("baseline", {}).get("questions", len(snapshot.get("questions", []))))
    before_o = int(snapshot.get("baseline", {}).get("options", len(snapshot.get("question_options", []))))
    return {
        "report_version": VERSION, "generated_at": utc_now(), "mode": mode, "source_filename": source.name,
        "source_sha256": source_hash, "source_size_bytes": source.stat().st_size, "seed": seed,
        "platforms": dict(sorted(platform_counts.items())), "subjects": dict(sorted(subject_counts.items())),
        "parsed": len(classified), "classifications": {name: counts.get(name, 0) for name in CLASSIFICATIONS},
        "topics_discovered": sorted(value for value in topic_counts if value != "(unclassified)"),
        "subtopics_discovered": sorted(value for value in subtopic_counts if value != "(unclassified)"),
        "questions_by_topic": dict(sorted(topic_counts.items())), "questions_by_subtopic": dict(sorted(subtopic_counts.items())),
        "question_count_before": before_q, "question_count_after_projected": before_q + len(new_rows),
        "option_count_before": before_o, "option_count_after_projected": before_o + sum(len(row["options"]) for row in new_rows),
        "study_state_baseline": snapshot.get("baseline", {}), "database_modified": False,
        "rows": [{
            "position": row["position"], "source_id": row.get("source_id"), "source_identity": row["source_identity"],
            "source_fingerprint": row["source_fingerprint"], "content_fingerprint": row["content_fingerprint"],
            "classification": row["classification"], "reason": row["reason"], "existing_question_id": row.get("existing_question_id"),
            "taxonomy": row["taxonomy"], "option_count": len(row["options"]), "correct_answer": row["correct_answer"],
            "stem_preview": clean(normalized_text(row["stem_html"]))[:180],
        } for row in classified],
    }


def git_revision(root: Path) -> str:
    run = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, text=True, capture_output=True, check=False)
    return run.stdout.strip() if run.returncode == 0 else "unknown"


def write_report(report: Dict[str, Any], directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", report["source_filename"])
    target = directory / f"{stamp}-{safe_name}-{report['mode']}.json"
    target.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return target


def import_payload(classified: List[Dict[str, Any]], report: Dict[str, Any], revision: str) -> Dict[str, Any]:
    rows = []
    for item in classified:
        if item["classification"] != "NEW":
            continue
        rows.append({
            "source_identity": item["source_identity"], "source_fingerprint": item["source_fingerprint"], "content_fingerprint": item["content_fingerprint"],
            "source_question_id": item.get("source_id") or None, "source_reference": item.get("source_reference") or None,
            "source_collection": item.get("source_collection") or None, "source_test_label": item.get("source_test_label") or None,
            "platform": item["taxonomy"]["platform"], "subject": item["taxonomy"]["subject"], "system": item["taxonomy"].get("system") or None,
            "topic": item["taxonomy"].get("topic") or None, "subtopic": item["taxonomy"].get("subtopic") or None,
            "question_text": item["stem_html"], "options": item["options"], "correct_answer": item["correct_answer"],
            "explanation_html": item.get("explanation_html") or None, "question_images": item.get("images", []),
            "is_pyq": bool(item.get("is_pyq")), "exam_year": int(item["exam_year"]) if str(item.get("exam_year", "")).isdigit() else None,
            "exam_shift": item.get("exam_session") or None,
        })
    return {"manifest": {
        "source_filename": report["source_filename"], "source_sha256": report["source_sha256"], "platform": next(iter(report["platforms"]), None),
        "subject": next(iter(report["subjects"]), None), "parsed_count": report["parsed"], "duplicate_count": report["classifications"]["EXACT EXISTING MATCH"],
        "possible_duplicate_count": report["classifications"]["POSSIBLE DUPLICATE"], "invalid_count": report["classifications"]["INVALID"],
        "conflict_count": report["classifications"]["CONFLICT"], "question_count_before": report["question_count_before"],
        "option_count_before": report["option_count_before"], "importer_version": VERSION, "git_commit": revision,
        "validation_result": "PASS",
    }, "questions": rows}


def print_report(report: Dict[str, Any], report_path: Path) -> None:
    classifications = report["classifications"]
    print(f"FILE: {report['source_filename']}")
    print(f"PLATFORM: {', '.join(report['platforms'])}")
    print(f"SUBJECT: {', '.join(report['subjects'])}")
    print(f"Parsed: {report['parsed']}")
    for label in CLASSIFICATIONS:
        print(f"{label.title()}: {classifications[label]}")
    print(f"Topics discovered: {len(report['topics_discovered'])}")
    print(f"Subtopics discovered: {len(report['subtopics_discovered'])}")
    print("Questions by Topic: " + stable_json(report["questions_by_topic"]))
    print("Questions by Subtopic: " + stable_json(report["questions_by_subtopic"]))
    print(f"Expected question count: {report['question_count_before']} -> {report['question_count_after_projected']}")
    print(f"Expected option count: {report['option_count_before']} -> {report['option_count_after_projected']}")
    print(f"DATABASE MODIFIED: {'YES' if report['database_modified'] else 'NO'}")
    print(f"REPORT: {report_path}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Permanent safe QBank HTML importer")
    parser.add_argument("file", type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--import", dest="do_import", action="store_true")
    parser.add_argument("--confirm-import", action="store_true", help="Required with --import")
    parser.add_argument("--platform", default="")
    parser.add_argument("--subject", default="")
    parser.add_argument("--system", default="")
    parser.add_argument("--topic", default="")
    parser.add_argument("--subtopic", default="")
    parser.add_argument("--source-collection", default="")
    parser.add_argument("--source-reference", default="")
    parser.add_argument("--profile")
    parser.add_argument("--snapshot", type=Path, help="Read-only JSON database snapshot for testing/auditing")
    parser.add_argument("--report-dir", type=Path, default=Path("import-reports"))
    parser.add_argument("--seed", type=int, default=20260828)
    args = parser.parse_args(argv)
    if not args.file.is_file():
        parser.error(f"source file does not exist: {args.file}")
    if args.do_import and not args.confirm_import:
        parser.error("--import requires --confirm-import")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    url = os.environ.get("SUPABASE_URL", DEFAULT_URL)
    if args.snapshot:
        snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    elif key:
        snapshot = fetch_snapshot(url, key)
    else:
        parser.error("live duplicate protection requires SUPABASE_SERVICE_ROLE_KEY or --snapshot")
    metadata = {name: clean(getattr(args, name)) for name in ("platform", "subject", "system", "topic", "subtopic", "source_collection", "source_reference")}
    profile = load_profile(args.profile)
    source_bytes = args.file.read_bytes()
    parsed = parse_html(args.file, metadata, profile)
    classified = classify_questions(parsed, snapshot)
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    report = aggregate_report(args.file, source_hash, classified, snapshot, "import" if args.do_import else "dry-run", args.seed)
    root = Path(__file__).resolve().parents[1]
    report["git_commit"] = git_revision(root)
    report["seeded_filter_validation"] = seeded_filter_validation(snapshot, args.seed)
    blockers = sum(report["classifications"][name] for name in ("POSSIBLE DUPLICATE", "INVALID", "CONFLICT"))
    if report["seeded_filter_validation"]["status"] != "PASS":
        blockers += 1
    if args.do_import:
        if blockers:
            print(f"IMPORT REFUSED: {blockers} unresolved possible duplicate/invalid/conflict rows", file=sys.stderr)
        elif not key:
            print("IMPORT REFUSED: SUPABASE_SERVICE_ROLE_KEY is required", file=sys.stderr)
            blockers = 1
        else:
            database_url = os.environ.get("DATABASE_URL", "")
            node = shutil.which("node")
            if not database_url or not node:
                print("IMPORT REFUSED: DATABASE_URL and Node.js are required for automatic post-import validation", file=sys.stderr)
                blockers = 1
                report_path = write_report(report, args.report_dir)
                print_report(report, report_path)
                return 1
            importer_tests = subprocess.run([sys.executable, "-m", "unittest", "scripts.tests.test_qbank_import"], cwd=root, text=True, capture_output=True, check=False)
            if importer_tests.returncode:
                print("IMPORT REFUSED: importer regression tests failed", file=sys.stderr)
                print(importer_tests.stderr or importer_tests.stdout, file=sys.stderr)
                report_path = write_report(report, args.report_dir)
                print_report(report, report_path)
                return 1
            before_state = dict(snapshot.get("baseline", {}))
            response, _ = api_request(url, key, "/rest/v1/rpc/qbank_import_batch", "POST", import_payload(classified, report, report["git_commit"]))
            report["database_modified"] = True
            report["import_result"] = response
            after = fetch_snapshot(url, key)
            report["post_import_baseline"] = after.get("baseline", {})
            protected = ("attempts", "bookmarks", "marked_for_review", "correct_state", "incorrect_state", "sessions", "session_questions")
            changed = [name for name in protected if before_state.get(name) != after.get("baseline", {}).get(name)]
            if changed:
                raise RuntimeError("post-import learner-state invariant failed: " + ", ".join(changed))
            validation = subprocess.run([node, "scripts/qbank-validate.mjs", "--database"], cwd=root, env={**os.environ, "DATABASE_URL": database_url}, text=True, capture_output=True, check=False)
            report["post_import_validation"] = {"status": "PASS" if validation.returncode == 0 else "FAIL", "output": (validation.stdout + validation.stderr)[-12000:]}
            if validation.returncode:
                blockers = 1
                print("POST-IMPORT VALIDATION FAILED", file=sys.stderr)
    report_path = write_report(report, args.report_dir)
    print_report(report, report_path)
    return 1 if blockers else 0


if __name__ == "__main__":
    raise SystemExit(main())
