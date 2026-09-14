#!/usr/bin/env python3
"""Medical QA for the deterministic post-adjudication 150-item sample."""
import hashlib, json
from pathlib import Path

FULL=Path('/tmp/qbank-target-adjudicator-full-v1.json')
SAMPLE=Path('/tmp/qbank-target-adjudicator-final-qa-150.json')
OUTPUT=Path('/tmp/qbank-target-adjudicator-final-qa-result-v1.json')
REVIEW=Path('/tmp/qbank-target-adjudicator-review-v1.json')

INCORRECT={
 'f84ed4f3-f59c-50d9-af83-3e72e32ad3c0':'generic statistics option, not a self-contained concept',
 'ff0fe203-d396-5d0b-b36e-88ddbcda7251':'unresolved graph placeholder (drug B)',
 '9ed66805-013f-56aa-a2bd-dc0dd9145c53':'malformed/incomplete label',
 '7f948c63-22e2-5fcb-a335-8b96a41f9dc0':'HPV entity omitted from genotype label',
 '9615b623-2ab4-5b27-8704-5d8db6a9efaa':'proposition without the Listeria entity',
 '69021189-06b4-5974-b0f1-e9e1d0e270c0':'generic management phrase without the condition',
 '7a37de4e-3b84-562e-9223-3bde947b565a':'proposition rather than normalized Veress-needle concept',
 '0879f13e-91d8-5f1b-ba41-24d86a0af070':'generic treatment proposition',
 'a7c3d503-cb43-523e-8f89-b1c8907466d5':'type II lacks the condition being classified',
}

def main():
 full=json.loads(FULL.read_text()); sample=json.loads(SAMPLE.read_text())['items']
 correct=len(sample)-sum(x['question_id'] in INCORRECT for x in sample)
 repeated=[c for c in full['clusters'] if c['member_count']>1]
 merge_sample=sorted(repeated,key=lambda c:hashlib.sha256(('final-merge|'+c['cluster_id']).encode()).hexdigest())[:30]
 unsafe_merge={'wait and watch'}
 merge_correct=sum(c['normalized_label'] not in unsafe_merge for c in merge_sample)
 existing={x['question_id']:x for x in full['review_queue']}
 by_id={x['question_id']:x for x in full['results']}
 for qid,reason in INCORRECT.items():
  item={**by_id[qid], 'review_reasons':['final_medical_qa_failure'], 'medical_qa_reason':reason}
  existing[qid]=item
 review={'version':full['version'],'ambiguous_clusters':full['ambiguous_clusters'],
         'suspicious_assignments':list(existing.values()),
         'total':len(full['ambiguous_clusters'])+len(existing)}
 REVIEW.write_text(json.dumps(review,indent=2))
 report={'sample_size':len(sample),'correct':correct,'incorrect':len(sample)-correct,
         'precision_percent':round(100*correct/len(sample),2),
         'cluster_sample_size':len(merge_sample),'cluster_correct':merge_correct,
         'cluster_merge_precision_percent':round(100*merge_correct/len(merge_sample),2),
         'review_queue':review['total'],'incorrect_assignments':INCORRECT,
         'merge_adjudications':[{'cluster_id':c['cluster_id'],'label':c['normalized_label'],
          'safe':c['normalized_label'] not in unsafe_merge} for c in merge_sample]}
 OUTPUT.write_text(json.dumps(report,indent=2)); print(json.dumps({k:v for k,v in report.items() if k not in {'incorrect_assignments','merge_adjudications'}},indent=2))

if __name__=='__main__': main()
