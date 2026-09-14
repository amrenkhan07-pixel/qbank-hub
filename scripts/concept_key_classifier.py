#!/usr/bin/env python3
"""Fast platform-independent explanation-first Concept-Key classifier."""
from __future__ import annotations
import argparse,hashlib,json,os,re,sys,time
from collections import defaultdict
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
import canonical_batch_classifier as legacy
import fast_explanation_classifier as fast

REPORT=Path('/tmp/qbank-prepladder-concept-key-v1.json'); CHECKPOINT=Path('/tmp/qbank-prepladder-concept-key-v1.jsonl')
VERSION='concept-key-explanation-first-v1'
GENERIC={'treatment','management','diagnosis','disease','condition','syndrome','patient','answer','none','all of the above','true','false'}
CUES=[
 re.compile(r'\b(?:diagnosis|condition|presentation|scenario)\s+(?:is|suggests|is consistent with)\s+(?:a |an )?([a-z][a-z0-9+\- ]{2,70})',re.I),
 re.compile(r'\b(?:consistent with|diagnostic of|characteristic of|hallmark of)\s+([a-z][a-z0-9+\- ]{2,70})',re.I),
 re.compile(r'(?:^|[.!?]\s+)([A-Z][A-Za-z0-9+\- ]{2,55})\s+is\s+(?:a |an |the )',re.M),
]

def norm_phrase(value):
 v=legacy.normalize(value); v=re.split(r'\b(?:because|which|that|where|with|due|caused|and is|but)\b',v,maxsplit=1)[0].strip()
 words=v.split(); v=' '.join(words[:8]); return v if 1<=len(v.split())<=8 and v not in GENERIC and len(v)>=4 else None

def extract_candidate(explanation,stem,negative=False):
 text=fast.teaching_excerpt(explanation)
 found=[]
 for pattern in CUES:
  for m in pattern.finditer(text):
   p=norm_phrase(m.group(1));
   if p: found.append(p)
 # A diagnosis question may safely use a repeated answer phrase, but negative
 # questions never use this shortcut.
 if not negative and re.search(r'\b(?:most likely diagnosis|diagnosis is|identify the condition)\b',stem,re.I):
  before=re.split(r'\bCorrect Answer\b',text,flags=re.I)[0].strip(' .:-')
  p=norm_phrase(before)
  if p: found.append(p)
 return found[0] if found else None

class ConceptKeyClassifier:
 def __init__(self,entries):
  self.entries=entries; self.aliases=defaultdict(list); self.postings=defaultdict(lambda:defaultdict(set))
  for i,e in enumerate(entries):
   phrases=[]
   for raw in [e['canonical_name'],*(e.get('aliases') or [])]:
    p=legacy.normalize(raw)
    if p and p not in GENERIC: phrases.append(p); [self.postings[e['subject_name']][w].add(i) for w in fast.tokens(p)]
   self.aliases[i]=list(dict.fromkeys(phrases))
 def classify(self,item):
  subject=item['subject']; negative=item.get('polarity')=='negative'; explanation=fast.teaching_excerpt(item.get('positive_explanation_text','')); channels=[('explanation',explanation,1.0),('stem',item.get('stem_text',''),.72),('source',item.get('source_title',''),.25)]
  if not negative: channels.append(('answer',item.get('correct_answer_text',''),.18))
  candidate_ids=set();
  for _,text,_ in channels:
   for word in fast.tokens(text): candidate_ids.update(self.postings[subject].get(word,()))
  ranked=[]
  for i in candidate_ids:
   best=0; support=[]
   for name,text,weight in channels:
    normalized=' '+legacy.normalize(text)+' '; channel=0
    for alias in self.aliases[i]:
     if f' {alias} ' in normalized: channel=max(channel,1.0+min(len(alias.split()),4)*.12)
    if channel: support.append(name); best+=weight*channel
   ranked.append((best,len(support),len(max(self.aliases[i],key=len,default='')),i,support))
  ranked.sort(reverse=True); best=ranked[0] if ranked else None; second=ranked[1] if len(ranked)>1 else None
  existing=None; confidence=0
  if best and ('explanation' in best[4] or ('stem' in best[4] and len(best[4])>=2)) and best[0]>=1.0 and (not second or best[0]-second[0]>=.18):
   existing=self.entries[best[3]]; confidence=min(.97,.64+best[0]/6)
  candidate=None
  if not existing:
   phrase=extract_candidate(explanation,item.get('stem_text',''),negative)
   if phrase: candidate={'normalized_phrase':phrase,'candidate_key':hashlib.sha256(f'{subject}|{phrase}'.encode()).hexdigest()[:20],'status':'unreviewed'}; confidence=.72
  reason=None if existing else ('candidate_review' if candidate else 'no_clear_concept')
  return {'question_id':item['question_id'],'subject':subject,'source_test_id':item['source_test_id'],'source_test':item['source_title'],'source_position':item.get('question_position'),
   'canonical_concept_id':existing['id'] if existing else None,'canonical_concept':existing['canonical_name'] if existing else None,'concept_candidate':candidate,'confidence':round(confidence,4),
   'provenance':{'classifier':VERSION,'explanation_first':True,'negative_safe':negative},'review_reason':reason,
   'diagnostic':{'polarity':item.get('polarity'),'stem':item.get('stem_text','')[:300],'teaching':explanation[:450]}}

def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--resume',action='store_true'); ap.add_argument('--report',type=Path,default=REPORT); ap.add_argument('--checkpoint',type=Path,default=CHECKPOINT); a=ap.parse_args(); key=os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
 if not key: raise SystemExit('SUPABASE_SERVICE_ROLE_KEY is required')
 saved=json.loads(Path('/tmp/qbank-canonical-batch-1000.json').read_text()); rows,_=fast.load_rows(key,True,saved); _,_,entries=legacy.fetch_taxonomy(key); hydrated,_=legacy.hydrate(key,rows); classifier=ConceptKeyClassifier(entries)
 completed=set(); mode='w'
 if a.resume and a.checkpoint.exists(): completed={json.loads(x)['question_id'] for x in a.checkpoint.read_text().splitlines() if x}; mode='a'
 started=time.perf_counter(); out=[]
 with a.checkpoint.open(mode) as f:
  for row in hydrated:
   if row['question_id'] in completed: continue
   result=classifier.classify(row); out.append(result); f.write(json.dumps(result,separators=(',',':'))+'\n')
 if completed: out=[json.loads(x) for x in a.checkpoint.read_text().splitlines() if x]
 elapsed=time.perf_counter()-started; existing=sum(bool(x['canonical_concept_id']) for x in out); candidates=sum(bool(x['concept_candidate']) for x in out); blank=len(out)-existing-candidates; exceptions=sum(x['review_reason'] not in (None,'no_clear_concept') for x in out)
 report={'version':VERSION,'read_only':True,'summary':{'processed':len(out),'existing_concepts':existing,'candidates':candidates,'no_concept':blank,'exceptions':exceptions,'seconds':round(elapsed,4),'questions_per_second':round(len(out)/elapsed,1)},'results':out}; a.report.write_text(json.dumps(report,indent=2)); print(json.dumps(report['summary'],indent=2)); print(a.report)
if __name__=='__main__': main()
