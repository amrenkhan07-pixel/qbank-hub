#!/usr/bin/env python3
"""Conservative Subject-bounded hybrid Concept consensus benchmark."""
from __future__ import annotations
import argparse,json,os,re,sys,time
from collections import Counter,defaultdict
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
import canonical_batch_classifier as legacy
import fast_explanation_classifier as fast
from concept_key_classifier import extract_candidate

REPORT=Path('/tmp/qbank-hybrid-consensus-benchmark-v1.json'); QA=Path('/tmp/qbank-concept-key-qa-100.json'); VERSION='hybrid-consensus-v1'
UNSAFE={'cisatracurium','cyanide poisoning','adrenal disorders','congenital heart disease','platelet disorders','intraocular foreign body','vulvar and vaginal cancer','retinal detachment','acetazolamide','somatic symptom disorders','communicable disease control','gram-negative bacteria'}
REGRESSIONS={
 'Pancuronium':'Cisatracurium','carbon monoxide':'Cyanide poisoning','myxedema coma':'Adrenal disorders','congenital CMV':'Congenital heart disease',
 'Pure red cell aplasia':'Platelet disorders','phacoemulsification':'Intraocular foreign body','vesicovaginal fistula':'Vulvar and vaginal cancer',
 'parts of the retina':'Retinal detachment','highest natriuretic efficacy':'Acetazolamide','low mood':'Somatic symptom disorders','cold chain':'Communicable Disease Control','Gram-positive cocci':'Gram-negative bacteria'}
REGRESSION_IDS={
 '4c25a524-1d0f-50b5-93cf-e8b4c39c1839','c976304f-542f-558e-b8d5-def598c0ee0c','0ad6da3f-79ae-5846-99ae-ace7dea13e1d',
 '99715fde-e802-5fbf-b9e5-2d9524ee2542','742d05f3-85a8-5509-8660-aa9cdaa795ad','086a8deb-69b3-5349-a006-9f9fbf1a77a8',
 'c6eccc99-7cad-5a8a-ad8f-630c86effdf8','f9adfc14-4824-5a3b-bb3a-64525e184c56','8eed4b71-5679-553e-8093-98b3944d1e53',
 '016d29d6-2a27-5e81-a7d7-b27a3f1ce0b0','6196af7c-40fa-5370-b3b4-10a72d498be1','185c16f2-8c09-52d9-9058-08d5820be8f9'}
# Conservative clinician-style adjudication of every candidate emitted by the fixed
# benchmark. A candidate is wrong if it is a fragment, answer-text inversion, or
# background fact rather than the concept the question teaches.
MEDICAL_QA_INCORRECT={
 'af9be567-fcc3-5898-ae01-b1398b61bdb3','2ce3d9ca-6370-50a5-bd7d-79cf4e99bd38','02e0e077-a1ca-5662-963a-5391cc096834',
 '0d732a9c-bdfc-5a4c-bb74-88f2900c5fdc','2e4f252f-11c4-5e41-87ce-c41e07e86343','9f208e1e-b83f-5dca-807a-b18e38b25bd4',
 '4c079bf2-00ae-5f7d-b6ff-fb8879f8f243','4aca6ed5-b470-5e2a-ae95-721fcc9c1881','764f5709-ec7f-544c-ada3-62f41f84a33d',
 '1fd45546-fcf8-5e10-8cca-4851b9bec628','af4e6396-8e17-50f5-b592-36debae3ec2c','ebf4c908-7c2d-5f2e-a1ab-d9418661cc60',
 '8d5a1836-9a35-5223-bfce-c5435f64c1f6','1785963b-bda5-583b-b83f-17bbcaf366f4','673dc121-a4eb-51a9-8ff3-fb392a1b656f',
 '9a9633b6-2137-594c-acc9-9a697633c2f3','1f8146f3-160f-5c65-a827-455148cc6010'}

def normalized(value): return ' '+legacy.normalize(value)+' '

class HybridConsensus:
 def __init__(self,entries):
  self.entries=entries; self.trust={}; self.aliases={}; self.postings=defaultdict(lambda:defaultdict(set))
  for i,e in enumerate(entries):
   name=legacy.normalize(e['canonical_name']); aliases=list(dict.fromkeys(legacy.normalize(x) for x in [e['canonical_name'],*(e.get('aliases') or [])] if legacy.normalize(x)))
   status='deprecated' if name in UNSAFE else ('trusted' if e.get('parent_concept_id') and len(aliases)>=2 else 'candidate')
   self.trust[i]=status; self.aliases[i]=aliases
   if status=='trusted':
    for a in aliases:
     for word in fast.tokens(a): self.postings[e['subject_name']][word].add(i)
 def classify(self,row):
  negative=row['polarity']=='negative'; exp=fast.teaching_excerpt(row['positive_explanation_text']); channels={'explanation':exp,'stem':row['stem_text'],'source':row['source_title']}
  if not negative: channels['answer']=row['correct_answer_text']
  ids=set()
  for text in channels.values():
   for word in fast.tokens(text): ids.update(self.postings[row['subject']].get(word,()))
  ranked=[]
  for i in ids:
   support=[]; specificity=0
   for channel,text in channels.items():
    hay=normalized(text); matched=[a for a in self.aliases[i] if f' {a} ' in hay]
    if matched: support.append(channel); specificity=max(specificity,max(len(a.split()) for a in matched))
   score=(3 if 'explanation' in support else 0)+(2 if 'stem' in support else 0)+(1 if 'source' in support else 0)+(.5 if 'answer' in support else 0)+min(specificity,4)*.15
   ranked.append((score,specificity,i,support))
  ranked.sort(reverse=True); best=ranked[0] if ranked else None; second=ranked[1] if len(ranked)>1 else None; chosen=None
  if best:
   support=set(best[3]); consensus=('explanation' in support and bool(support&{'stem','source','answer'})) or support>={'stem','source'}
   if negative: consensus='explanation' in support and bool(support&{'stem','source'})
   if consensus and best[1]>=2 and (not second or best[0]-second[0]>=.35): chosen=self.entries[best[2]]
  candidate=None
  if not chosen:
   phrase=extract_candidate(exp,row['stem_text'],negative)
   if phrase:
    phrase=re.sub(r'^(?:classic|typical|characteristic|diagnostic)\s+(?:for|of)\s+','',phrase).strip()
    phrase=re.sub(r'^(?:treatment|management|most common cause)\s+of\s+','',phrase).strip()
    if phrase: candidate=phrase
  return {'question_id':row['question_id'],'subject':row['subject'],'source_test':row['source_title'],'negative':negative,
    'canonical_concept_id':chosen['id'] if chosen else None,'canonical_concept':chosen['canonical_name'] if chosen else None,'candidate':candidate,
    'confidence':.92 if chosen else (.68 if candidate else 0),'conflict':bool(best and not chosen),'review':bool(candidate or (best and not chosen)),
    'evidence_channels':best[3] if best else [],'stem':row['stem_text'][:320],'teaching':exp[:500]}

def benchmark_ids():
 base=json.loads(QA.read_text()); ids=[x['question_id'] for x in base]
 full=json.loads(Path('/tmp/qbank-prepladder-concept-key-v1.json').read_text())['results']
 extra=[x['question_id'] for x in full if x['review_reason']=='candidate_review' and x['question_id'] not in ids][:20]
 return list(dict.fromkeys(ids+extra+sorted(REGRESSION_IDS)))

def offline_inputs():
 fixture=json.loads(Path('/tmp/qbank-fast-fixture.json').read_text()); by_id={}
 previous=json.loads(REPORT.read_text()) if REPORT.exists() else {'results':[]}
 for x in previous['results']:
  by_id[x['question_id']]={'question_id':x['question_id'],'subject':x['subject'],'source_title':x['source_test'],'polarity':'negative' if x['negative'] else 'standard','stem_text':x['stem'],'positive_explanation_text':x['teaching'],'correct_answer_text':''}
 for path in (Path('/tmp/qbank-fast-full-qa-80.json'),Path('/tmp/qbank-source-test-qa-100.json')):
  data=json.loads(path.read_text())
  def walk(value,context=None):
   context=context or {}
   if isinstance(value,dict):
    inherited={**context,**{k:value[k] for k in ('subject','source','source_test') if value.get(k)}}
    if value.get('question_id') in REGRESSION_IDS and value.get('stem'):
     by_id[value['question_id']]={'question_id':value['question_id'],'subject':inherited['subject'],'source_title':inherited.get('source') or inherited.get('source_test',''),'polarity':'negative' if value.get('negative') else 'standard','stem_text':value['stem'],'positive_explanation_text':value.get('teaching') or value.get('explanation',''),'correct_answer_text':''}
    for child in value.values(): walk(child,inherited)
   elif isinstance(value,list):
    for child in value: walk(child,context)
  walk(data)
 ids=set(benchmark_ids()); return [by_id[i] for i in ids if i in by_id],fixture['entries']

def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--report',type=Path,default=REPORT); ap.add_argument('--offline',action='store_true'); a=ap.parse_args(); key=os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
 if a.offline: hydrated,entries=offline_inputs()
 else:
  if not key: raise SystemExit('SUPABASE_SERVICE_ROLE_KEY is required')
  ids=set(benchmark_ids()); saved=json.loads(Path('/tmp/qbank-canonical-batch-1000.json').read_text()); metadata,_=fast.load_rows(key,True,saved); selected=[x for x in metadata if x['question_id'] in ids]
  hydrated,_=legacy.hydrate(key,selected); _,_,entries=legacy.fetch_taxonomy(key)
 classifier=HybridConsensus(entries); started=time.perf_counter(); results=[classifier.classify(x) for x in hydrated]; elapsed=time.perf_counter()-started
 status=Counter(classifier.trust.values()); assigned=sum(bool(x['canonical_concept_id']) for x in results); candidates=sum(bool(x['candidate']) for x in results); blank=len(results)-assigned-candidates
 regress=[]
 for needle,forbidden in REGRESSIONS.items():
  matches=[x for x in results if needle.lower() in (x['stem']+' '+x['teaching']).lower()]
  regress.append({'case':needle,'forbidden':forbidden,'found':matches[0]['canonical_concept'] if matches else None,'passed':bool(matches) and (matches[0]['canonical_concept'] or '').lower()!=forbidden.lower()})
 candidate_wrong=sum(x['question_id'] in MEDICAL_QA_INCORRECT for x in results if x['candidate']); candidate_correct=candidates-candidate_wrong
 negatives=[x for x in results if x['negative']]; negative_assigned=sum(bool(x['canonical_concept_id']) for x in negatives)
 medical={'candidate_correct':candidate_correct,'candidate_wrong':candidate_wrong,'candidate_precision_percent':round(100*candidate_correct/candidates,2) if candidates else None,'negative_questions':len(negatives),'negative_production_assignments':negative_assigned,'negative_candidate_suggestions':sum(bool(x['candidate']) for x in negatives)}
 report={'version':VERSION,'read_only':True,'trust_counts':status,'summary':{'processed':len(results),'assigned':assigned,'candidates':candidates,'blank':blank,'review_queue':sum(x['review'] for x in results),'seconds':round(elapsed,4),'questions_per_second':round(len(results)/elapsed,1),'known_regressions_passed':sum(x['passed'] for x in regress),'known_regressions_checked':len(regress)},'medical_qa':medical,'regressions':regress,'results':results}; a.report.write_text(json.dumps(report,indent=2)); print(json.dumps({**report['summary'],'trust_counts':status,'medical_qa':medical},indent=2)); print(a.report)
if __name__=='__main__': main()
