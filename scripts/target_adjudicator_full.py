#!/usr/bin/env python3
"""Apply target adjudication to the saved 2,967 candidates; never queries QBank."""
from __future__ import annotations
import argparse, hashlib, json, sys, time
from collections import Counter
from pathlib import Path

sys.path.insert(0,str(Path(__file__).parents[1]))

from scripts.target_adjudicator import VERSION, adjudicate, cluster

SOURCE = Path("/tmp/qbank-two-stage-full-corpus-v1.json")
OUTPUT = Path("/tmp/qbank-target-adjudicator-full-v1.json")
QA = Path("/tmp/qbank-target-adjudicator-final-qa-150.json")


def sample_final(rows, clusters, size=150):
    repeated = {qid for c in clusters if c["member_count"] > 1 for qid in c["question_ids"]}
    ordered = sorted(rows, key=lambda x: hashlib.sha256(f"final-qa|{x['question_id']}".encode()).hexdigest())
    selected = []
    for subject in sorted({x["subject"] for x in rows}):
        candidate = next(x for x in ordered if x["subject"] == subject)
        selected.append({**candidate, "qa_strata": ["subject"]})
    for name, candidates, limit in (
        ("replace", [x for x in ordered if x["action"] == "REPLACE"], 50),
        ("repeated_cluster", [x for x in ordered if x["question_id"] in repeated], 35),
        ("broad_pyq", [x for x in ordered if x.get("is_pyq") or "pyq" in x["source_test"].lower()], 30),
    ):
        count = 0
        for item in candidates:
            existing = next((x for x in selected if x["question_id"] == item["question_id"]), None)
            if existing:
                existing["qa_strata"].append(name)
            else:
                selected.append({**item, "qa_strata": [name]})
            count += 1
            if count >= limit: break
    for item in ordered:
        if len(selected) >= size: break
        if not any(x["question_id"] == item["question_id"] for x in selected):
            selected.append({**item, "qa_strata": ["random_fill"]})
    return selected[:size]


def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--source",type=Path,default=SOURCE)
    parser.add_argument("--output",type=Path,default=OUTPUT); parser.add_argument("--qa",type=Path,default=QA)
    args=parser.parse_args(); source=json.loads(args.source.read_text())
    candidates=[x for x in source["results"] if x.get("generated_label")]
    started=time.perf_counter(); results=[adjudicate(x) for x in candidates]
    clusters,ambiguous=cluster(results); elapsed=time.perf_counter()-started
    actions=Counter(x["action"] for x in results); final=[x for x in results if x["final_label"]]
    sample=sample_final(final,clusters); args.qa.write_text(json.dumps({"items":sample},indent=2))
    review=[x for x in results if x["final_label"] and (x["final_confidence"] < .97 or x["action"]=="REPLACE")]
    summary={"candidates_checked":len(results),"confirmed":actions["CONFIRM"],"replaced":actions["REPLACE"],
             "blanked":actions["BLANK"],"final_nonblank":len(final),
             "prep_coverage_percent":round(100*len(final)/22808,2),"unique_concepts":len(clusters),
             "ambiguous_clusters":len(ambiguous),"review_queue":len(review)+len(ambiguous),
             "seconds":round(elapsed,4),"questions_per_second":round(len(results)/elapsed,1)}
    args.output.write_text(json.dumps({"version":VERSION,"read_only":True,"summary":summary,
        "clusters":clusters,"ambiguous_clusters":ambiguous,"review_queue":review,"results":results},indent=2))
    print(json.dumps(summary,indent=2)); print("No database rows were changed.")


if __name__=="__main__": main()
