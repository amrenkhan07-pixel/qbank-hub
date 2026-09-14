#!/usr/bin/env python3
"""Local-only paginated review UI for Concept-Key exceptions."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
import argparse,json,urllib.parse
REPORT=Path('/tmp/qbank-prepladder-concept-key-v1.json'); DECISIONS=Path('/tmp/qbank-concept-key-review-decisions.json'); PAGE=Path(__file__).parents[1]/'concept-review.html'
class Handler(SimpleHTTPRequestHandler):
 def reply(self,obj):
  body=json.dumps(obj).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(body)
 def do_GET(self):
  u=urllib.parse.urlparse(self.path)
  if u.path=='/': data=PAGE.read_bytes(); self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(data); return
  if u.path!='/api/items': self.send_error(404); return
  q=urllib.parse.parse_qs(u.query); allrows=json.loads(REPORT.read_text())['results']; subjects=sorted({x['subject'] for x in allrows}); term=q.get('q',[''])[0].lower(); subject=q.get('subject',[''])[0]
  rows=[x for x in allrows if x['review_reason'] and x['review_reason']!='no_clear_concept' and (not subject or x['subject']==subject) and (not term or term in (x['source_test']+' '+x['diagnostic']['stem']+' '+str(x['concept_candidate'])).lower())]
  page=max(1,int(q.get('page',['1'])[0])); size=25; decisions=json.loads(DECISIONS.read_text()) if DECISIONS.exists() else {}; items=rows[(page-1)*size:page*size]
  for x in items: x['decision']=decisions.get(x['question_id'])
  self.reply({'total':len(rows),'page':page,'subjects':subjects,'items':items})
 def do_POST(self):
  if self.path!='/api/decision': self.send_error(404); return
  item=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0')))); allowed={'link_existing','accept_candidate','rename','defer','no_concept'}
  if item.get('action') not in allowed or not item.get('question_id'): self.send_error(400); return
  decisions=json.loads(DECISIONS.read_text()) if DECISIONS.exists() else {}; decisions[item['question_id']]={'action':item['action'],'value':item.get('value')}; DECISIONS.write_text(json.dumps(decisions,indent=2)); self.reply({'ok':True})
if __name__=='__main__':
 ap=argparse.ArgumentParser(); ap.add_argument('--port',type=int,default=4175); a=ap.parse_args(); ThreadingHTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
