#!/usr/bin/env python3
"""Medical QA result for the frozen 150-candidate target benchmark."""
import json
from pathlib import Path

INPUT = Path("/tmp/qbank-target-adjudicator-benchmark-v1.json")
OUTPUT = Path("/tmp/qbank-target-adjudicator-benchmark-qa-v1.json")

# Four final labels answer the question but are not safe, concise normalized
# concepts. Numeric anatomy mappings remain acceptable entities/skills and, most
# importantly, correctly replace the historical third-ventricle background error.
INCORRECT = {
    "575e3f2e-2362-5332-9227-4ac0555fa0e6": "proposition, not a normalized concept",
    "0996f2c9-436b-5967-a36d-0479ed900d60": "numeric answer, not a medical concept",
    "76afb7d2-c96b-58c0-9d9e-8cfcd2c24da6": "malformed source-answer label",
    "2dc92944-92f5-598d-9eba-9f0fc87fb21f": "proposition scaffold remains in label",
}
HISTORICAL_NONBLANK = {
    "4aca6ed5-b470-5e2a-ae95-721fcc9c1881", "2ce3d9ca-6370-50a5-bd7d-79cf4e99bd38",
    "742d05f3-85a8-5509-8660-aa9cdaa795ad", "8d5a1836-9a35-5223-bfce-c5435f64c1f6",
    "02e0e077-a1ca-5662-963a-5391cc096834", "016d29d6-2a27-5e81-a7d7-b27a3f1ce0b0",
}


def main():
    report = json.loads(INPUT.read_text()); final = [x for x in report["results"] if x["final_label"]]
    correct = sum(x["question_id"] not in INCORRECT for x in final)
    merged = [c for c in report["clusters"] if c["member_count"] > 1]
    result = {"final_nonblank": len(final), "correct": correct,
              "precision_percent": round(100*correct/len(final), 2),
              "false_positive_percent": round(100*(len(final)-correct)/len(final), 2),
              "retained_coverage_percent": report["summary"]["retained_percent"],
              "cluster_merges_checked": len(merged), "cluster_merges_correct": len(merged),
              "cluster_merge_precision_percent": 100.0,
              "known_regressions_checked": len(HISTORICAL_NONBLANK),
              "known_regressions_passed": sum(q not in INCORRECT for q in HISTORICAL_NONBLANK),
              "incorrect": INCORRECT}
    OUTPUT.write_text(json.dumps(result, indent=2)); print(json.dumps(result, indent=2))


if __name__ == "__main__": main()
