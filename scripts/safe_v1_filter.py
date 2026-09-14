#!/usr/bin/env python3
"""Post-hoc SAFE_V1 filter for the immutable c333 adjudicator output."""
from __future__ import annotations
import argparse, hashlib, json, re, sys, time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0,str(Path(__file__).parents[1]))

from scripts.hybrid_consensus_classifier import MEDICAL_QA_INCORRECT, REGRESSION_IDS

VERSION='safe-v1-filter-2026-09-14'
SOURCE=Path('/tmp/qbank-target-adjudicator-full-v1.json')
REVIEW=Path('/tmp/qbank-target-adjudicator-review-v1.json')
OUTPUT=Path('/tmp/qbank-safe-v1-filter.json')
QA=Path('/tmp/qbank-safe-v1-qa-200.json')

SUSPICIOUS=re.compile(r'\b(?:this|associated|consistent|classic|seen|characteri[sz]ed|treatment|diagnosis|uncertain|inadequately|wait and watch|type [ivx]+|drug [a-d])\b',re.I)

def key(value): return re.sub(r'[^a-z0-9]+',' ',(value or '').lower()).strip()

def filter_rows(full,review):
 review_ids={x['question_id'] for x in review['suspicious_assignments']}
 ambiguous_ids={qid for pair in review['ambiguous_clusters'] for side in ('left','right') for qid in pair[side]['question_ids']}
 reviewed_cluster_ids={x.get('final_cluster_id') for x in full['results'] if x['question_id'] in review_ids}
 reviewed_cluster_ids.discard(None)
 safe=[]; deferred=[]
 for row in full['results']:
  if not row.get('final_label'): continue
  reasons=[]
  if row['question_id'] in review_ids: reasons.append('review_queue_member')
  if row['question_id'] in ambiguous_ids: reasons.append('ambiguous_or_conflicting_cluster')
  if row.get('final_cluster_id') in reviewed_cluster_ids: reasons.append('cluster_contains_reviewed_member')
  if row.get('final_confidence',0)<.98: reasons.append('low_confidence')
  if row.get('action')!='CONFIRM': reasons.append('replacement_not_safe_v1')
  if key(row.get('original_candidate'))!=key(row.get('parsed_correct_answer')): reasons.append('weak_evidence_agreement')
  if row['question_id'] in REGRESSION_IDS or row['question_id'] in MEDICAL_QA_INCORRECT: reasons.append('known_failure_or_regression')
  if row.get('negative') or SUSPICIOUS.search(row.get('final_label','')): reasons.append('existing_safety_flag')
  result={**row,'safe_v1_status':'DEFERRED' if reasons else 'SAFE_V1','defer_reasons':reasons}
  (deferred if reasons else safe).append(result)
 return safe,deferred

def sample_safe(safe,clusters,size=200):
 repeated={qid for c in clusters if c['member_count']>1 for qid in c['question_ids']}
 ordered=sorted(safe,key=lambda x:hashlib.sha256(('safe-qa|'+x['question_id']).encode()).hexdigest())
 chosen=[]
 for subject in sorted({x['subject'] for x in safe}):
  row=next(x for x in ordered if x['subject']==subject); chosen.append({**row,'qa_strata':['subject']})
 for stratum,rows,limit in (
   ('confirmed',[x for x in ordered if x['action']=='CONFIRM'],80),
   ('repeated_cluster',[x for x in ordered if x['question_id'] in repeated],50),
   ('broad_pyq',[x for x in ordered if x.get('is_pyq') or 'pyq' in x['source_test'].lower() or 'previous year' in x['source_test'].lower()],50)):
  for row in rows[:limit]:
   old=next((x for x in chosen if x['question_id']==row['question_id']),None)
   if old: old['qa_strata'].append(stratum)
   else: chosen.append({**row,'qa_strata':[stratum]})
 for row in ordered:
  if len(chosen)>=size: break
  if not any(x['question_id']==row['question_id'] for x in chosen): chosen.append({**row,'qa_strata':['random_fill']})
 return chosen[:size]

def compact(row):
 return {'content_id':row['question_id'],'concept_ref':row['final_cluster_id'],'classifier_version':VERSION,
         'confidence':row['final_confidence'],'provenance':'confirmed_exact_answer_agreement','review_status':'safe_v1'}

def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--source',type=Path,default=SOURCE); ap.add_argument('--review',type=Path,default=REVIEW); ap.add_argument('--output',type=Path,default=OUTPUT); ap.add_argument('--qa',type=Path,default=QA); a=ap.parse_args()
 started=time.perf_counter(); full=json.loads(a.source.read_text()); review=json.loads(a.review.read_text())
 safe,deferred=filter_rows(full,review)
 safe_ids={x['question_id'] for x in safe}; safe_clusters=[]
 for cluster in full['clusters']:
  members=[q for q in cluster['question_ids'] if q in safe_ids]
  if members: safe_clusters.append({**cluster,'question_ids':members,'member_count':len(members)})
 sample=sample_safe(safe,safe_clusters); a.qa.write_text(json.dumps({'version':VERSION,'items':sample},indent=2))
 all_reasons=Counter(r for x in deferred for r in x['defer_reasons']); primary=Counter(x['defer_reasons'][0] for x in deferred)
 compact_rows=[compact(x) for x in safe]; bytes_=sum(len(json.dumps(x,separators=(',',':')).encode()) for x in compact_rows)
 summary={'starting_assignments':len(safe)+len(deferred),'safe_v1':len(safe),'deferred':len(deferred),
          'safe_v1_corpus_percent':round(100*len(safe)/22808,2),'safe_clusters':len(safe_clusters),
          'defer_primary_reasons':primary,'defer_all_reasons':all_reasons,'qa_sample_size':len(sample),
          'compact_bytes':bytes_,'compact_bytes_per_assignment':round(bytes_/len(safe),1) if safe else 0,
          'seconds':round(time.perf_counter()-started,4)}
 a.output.write_text(json.dumps({'version':VERSION,'read_only':True,'summary':summary,'safe_clusters':safe_clusters,'safe_v1':safe,'deferred':deferred,'compact_preview':compact_rows[:10]},indent=2))
 print(json.dumps(summary,indent=2)); print('No database rows were changed.')

if __name__=='__main__': main()
