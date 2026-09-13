#!/usr/bin/env python3
"""Read-only QA gate for the fixed 1,000-question quality reclassification."""

import argparse
import json
from pathlib import Path


NEGATIVE_INTENT_FIXTURES = {
    "393f1d1e-85a7-517b-95d0-3cd7c21633da": "Monitoring and Safety",
    "62c8163b-b6f5-5346-b337-30179f6c74c5": "General Anaesthesia",
    "4a511458-7c86-57a9-93bf-3695480247f8": "Respiratory and Anaesthetic Emergencies",
    "6edd3e40-5d2e-594f-b30e-9bb897072fe9": "Ventilation",
    "fff15a21-c8e0-5593-bd52-b09c79c8d1c1": "General Anaesthesia",
    "687e576a-599d-5a8d-8e76-8e77a1dee543": "Airway Management",
    "6c7e42cd-3579-5f12-b20e-682b2b48df36": "Pharynx and larynx",
    "ccafd061-4bda-501d-bbfe-040513e87888": "Thoracic wall and diaphragm",
    "0f6be108-8ada-5ed9-bd96-3853c741bdb4": "Embryology",
    "368c811c-47c9-597e-8a25-f99098009788": "Upper Limb",
    "3e852dcb-a68e-58ee-8afb-86e69781f6a1": "Pelvis",
    "d41b635e-a7a2-549a-9c4f-024c92503fc2": "Shoulder and arm",
    "76125f58-3f84-5422-bacc-c56bd1a05dab": "Carbohydrate Metabolism",
    "f651cede-5310-552c-b140-33c9566a23aa": "Biomolecules and Enzymes",
    "55b0ab7d-6274-5f59-9e9c-7b692ef5d4e9": "Carbohydrate Metabolism",
    "5682ca77-32e2-5d77-868d-dc562a8829ca": "Glycolysis and gluconeogenesis",
    "49fb3169-4a9e-5d9c-8aae-dc193fbdee76": "Nutrition and Vitamins",
    "96cbbfb1-a122-5b0c-a43f-7483bba4c09a": "Communicable Disease Control",
    "16ee405a-27a0-53d5-bda9-7e814d648643": "Communicable Disease Control",
    "5e08f93a-a631-5e59-ac27-c5e4510a6cda": "Occupational and Social Health",
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", default="/tmp/qbank-canonical-batch-1000-before-v2.json")
    parser.add_argument("--after", default="/tmp/qbank-canonical-batch-1000.json")
    args = parser.parse_args()
    before = json.loads(Path(args.before).read_text())
    after = json.loads(Path(args.after).read_text())
    old_ids = {row["question_id"] for row in before["results"]}
    new_ids = {row["question_id"] for row in after["results"]}
    rows = {row["question_id"]: row for row in after["results"]}

    identity_ok = len(old_ids) == len(new_ids) == 1000 and old_ids == new_ids
    fixture_results = []
    for question_id, expected in NEGATIVE_INTENT_FIXTURES.items():
        row = rows.get(question_id)
        path = (row or {}).get("diagnostic", {}).get("primary_path") or ""
        fixture_results.append((question_id, expected, path, bool(row and row["intent_state"] == 1 and expected in path)))
    fixture_passes = sum(item[3] for item in fixture_results)

    result_rows = list(rows.values())
    categories = {
        "negative": sum(row["intent_state"] == 1 for row in result_rows),
        "explanation_supported": sum(row["diagnostic"]["explanation_supported"] for row in result_rows),
        "concept_specific": sum(bool(row["primary_concept_id"]) for row in result_rows),
        "content_override": sum(row["diagnostic"]["basis"] == "content_override" for row in result_rows),
        "low_confidence": sum(row["confidence"] < .65 for row in result_rows),
        "pyq": sum(row["diagnostic"]["is_pyq"] for row in result_rows),
        "subjects": len({row["diagnostic"]["subject"] for row in result_rows}),
    }
    summary = after["summary"]
    print(f"{'PASS' if identity_ok else 'FAIL'} — exact same 1,000 IDs")
    print(f"MEDICAL GATE {'PASS' if fixture_passes >= 18 else 'FAIL'} — negative-intent sample {fixture_passes}/20 ({fixture_passes * 5}%)")
    print("BEFORE → AFTER — " + ", ".join(
        f"{key} {before['summary'][key]}→{summary[key]}"
        for key in ("topic_resolved", "subtopic_resolved", "concept_resolved", "unresolved")
    ))
    print("SAMPLE COVERAGE — " + ", ".join(f"{key}={value}" for key, value in categories.items()))
    for question_id, expected, path, passed in fixture_results:
        if not passed:
            print(f"REVIEW — Q-{question_id.replace('-', '')[:8].upper()} expected {expected}; proposed {path or 'unresolved'}")
    return 0 if identity_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
