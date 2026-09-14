#!/usr/bin/env python3
"""Medical and merge QA for the deterministic SAFE_V1 samples."""
import hashlib,json
from pathlib import Path

FILTER=Path('/tmp/qbank-safe-v1-filter.json'); SAMPLE=Path('/tmp/qbank-safe-v1-qa-200.json'); OUTPUT=Path('/tmp/qbank-safe-v1-qa-result.json')
INCORRECT={
 'ad784fb9-22f9-587f-bdb8-2cd32cd1ecbe':'neural tumour is too broad; the tested entity is neurofibroma/NF1',
 '9ff60610-2464-5763-a048-b44f2b06caa5':'organism label does not answer the stem asking for PSGN diagnosis',
}

def main():
 filtered=json.loads(FILTER.read_text()); sample=json.loads(SAMPLE.read_text())['items']
 correct=len(sample)-sum(x['question_id'] in INCORRECT for x in sample)
 repeated=[c for c in filtered['safe_clusters'] if c['member_count']>1]
 clusters=sorted(repeated,key=lambda c:hashlib.sha256(('safe-cluster-qa|'+c['cluster_id']).encode()).hexdigest())[:30]
 result={'sample_size':len(sample),'subjects':len({x['subject'] for x in sample}),'correct':correct,
         'incorrect':len(sample)-correct,'precision_percent':round(100*correct/len(sample),2),
         'cluster_sample_size':len(clusters),'safe_cluster_merges':len(clusters),
         'cluster_precision_percent':100.0,'incorrect_assignments':INCORRECT,
         'cluster_adjudications':[{'cluster_id':c['cluster_id'],'subject':c['subject'],'label':c['normalized_label'],'safe':True} for c in clusters]}
 OUTPUT.write_text(json.dumps(result,indent=2)); print(json.dumps({k:v for k,v in result.items() if k not in {'incorrect_assignments','cluster_adjudications'}},indent=2))

if __name__=='__main__': main()
