#!/usr/bin/env python3
"""Read-only, aggregate explanation-first PrepLadder Source-Test Topic mapper."""

from __future__ import annotations

import argparse, json, math, os, re, sys, time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import canonical_batch_classifier as legacy
from fast_explanation_classifier import FastIndex, teaching_excerpt, tokens

REPORT = Path('/tmp/qbank-prepladder-source-test-map-v1.json')
VERSION = 'aggregate-source-test-topic-v1'


def spread(rows, maximum=9):
    rows = sorted(rows, key=lambda r: (r.get('question_position') or 0, r['question_id']))
    if len(rows) <= maximum: return rows
    indexes = sorted({round(i * (len(rows)-1)/(maximum-1)) for i in range(maximum)})
    return [rows[i] for i in indexes]


def fetch(key):
    prep = next(r for r in legacy.paged(key,'platforms','id,name') if legacy.normalize(r['name'])=='prepladder')
    subjects = {r['id']:r['name'] for r in legacy.paged(key,'subjects','id,name')}
    tests = legacy.paged(key,'qbank_source_tests','id,subject_id,title,is_pyq,sequence',f"platform_id=eq.{prep['id']}&order=sequence,id")
    test_ids={r['id'] for r in tests}
    occurrences=legacy.paged(key,'qbank_source_occurrences','question_id,source_test_id,question_position,is_pyq,exam_year,exam_session','is_current=eq.true&order=source_test_id,question_position')
    by_test=defaultdict(list)
    for r in occurrences:
        if r['source_test_id'] in test_ids: by_test[r['source_test_id']].append(r)
    selected=[r for test in tests for r in spread(by_test[test['id']])]
    ids=[r['question_id'] for r in selected]; payloads={}
    for batch in legacy.chunks(ids):
        filt=legacy.id_filter(batch)
        rows=legacy.retry_request(key,'/rest/v1/qbank_question_payloads?select=question_id,payload_object_id,payload_index,content_sha256,correct_option_keys,has_question_media,has_explanation_media,has_audio,has_video,media_status'+f'&question_id={filt}')
        payloads.update({r['question_id']:r for r in rows})
    test_by_id={r['id']:r for r in tests}; hydrated=[]
    for r in selected:
        test=test_by_id[r['source_test_id']]; p=payloads.get(r['question_id'])
        if not p: continue
        hydrated.append({**r,'subject':subjects[test['subject_id']],'source_title':test['title'],'source_sequence':test['sequence'],
          'proposal_topic_id':None,'proposal_status':'unmapped','proposal_confidence':0,'proposal_ambiguity':False,'proposal_basis':None,
          'is_pyq':bool(r.get('is_pyq') or test.get('is_pyq')),'payload':p,'has_media':any(p.get(k) for k in ('has_question_media','has_explanation_media','has_audio','has_video')),'selection_reason':'source_test_spread'})
    return tests, subjects, legacy.hydrate(key,hydrated)[0]


def topic_ancestor(nodes, node):
    while node and node['node_type']!='topic': node=nodes.get(node.get('parent_id'))
    return node


def map_tests(tests, subjects, evidence, nodes, entries):
    index=FastIndex(entries,nodes); by_test=defaultdict(list)
    for r in evidence: by_test[r['source_test_id']].append(r)
    topic_names={n['id']:n['name'] for n in nodes.values() if n['node_type']=='topic'}
    results=[]
    for test in tests:
        subject=subjects[test['subject_id']]; samples=by_test.get(test['id'],[]); votes=[]; snippets=[]
        for row in samples:
            exp=teaching_excerpt(row['positive_explanation_text']); ew=tokens(exp); sw=tokens(row['stem_text']); ids=index.candidates(subject,ew|sw)
            score_by_topic=defaultdict(float)
            for i in ids:
                e=index.entries[i]; score=4.8*index.channel_score(i,ew)+2.0*index.channel_score(i,sw)
                score_by_topic[e['topic_id']]=max(score_by_topic[e['topic_id']],score)
            ranked=sorted(score_by_topic.items(),key=lambda x:(x[1],topic_names.get(x[0],'')),reverse=True)
            if ranked and ranked[0][1]>=2.3 and (len(ranked)==1 or ranked[0][1]-ranked[1][1]>=.25): votes.append(ranked[0][0])
            snippets.append({'question_id':row['question_id'],'stem':row['stem_text'][:240],'explanation':exp[:320],
                             'candidate_topic':topic_names.get(ranked[0][0]) if ranked else None})
        counts=Counter(votes); ordered=counts.most_common(); dominant=ordered[0] if ordered else (None,0); runner=ordered[1] if len(ordered)>1 else (None,0)
        support=dominant[1]/len(votes) if votes else 0; coverage=len(votes)/len(samples) if samples else 0
        broad=bool(legacy.BROAD_TITLE.search(test['title']))
        if broad: kind='MIXED'; proposed=None
        elif dominant[0] and support>=.78 and coverage>=.55: kind='SINGLE_TOPIC'; proposed=dominant[0]
        elif dominant[0] and support>=.58 and coverage>=.45: kind='BROAD_RELATED'; proposed=dominant[0]
        else: kind='MIXED'; proposed=None
        confidence=0 if not proposed else min(.97,.45+.38*support+.14*coverage)
        ambiguous=bool((kind=='MIXED' and not broad) or (proposed and (support<.72 or confidence<.78)))
        needs_review=ambiguous or (kind=='MIXED' and not broad)
        results.append({'source_test_id':test['id'],'subject':subject,'source_test':test['title'],'type':kind,
          'proposed_topic_id':proposed,'proposed_topic':topic_names.get(proposed),'confidence':round(confidence,4),
          'sample_size':len(samples),'classified_samples':len(votes),'dominant_support_percent':round(100*support,1),
          'runner_up_topic':topic_names.get(runner[0]),'runner_up_support':runner[1],'ambiguity':ambiguous,
          'needs_review':needs_review,'samples':snippets})
    return results


def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--report',type=Path,default=REPORT); args=ap.parse_args()
    key=os.environ.get('SUPABASE_SERVICE_ROLE_KEY');
    if not key: raise SystemExit('SUPABASE_SERVICE_ROLE_KEY is required')
    started=time.perf_counter(); tests,subjects,evidence=fetch(key); _,nodes,entries=legacy.fetch_taxonomy(key)
    results=map_tests(tests,subjects,evidence,nodes,entries); elapsed=time.perf_counter()-started
    counts=Counter(r['type'] for r in results); queue=[r['source_test_id'] for r in results if r['needs_review']]
    report={'version':VERSION,'read_only':True,'summary':{'source_tests':len(results),**counts,'review_queue':len(queue),'sampled_questions':len(evidence),'seconds':round(elapsed,3)},'results':results}
    args.report.write_text(json.dumps(report,indent=2)); print(json.dumps(report['summary'],indent=2)); print(args.report)

if __name__=='__main__': main()
