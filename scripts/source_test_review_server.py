#!/usr/bin/env python3
"""Local-only paginated review UI for the aggregate Source-Test report."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
import argparse,json,urllib.parse

REPORT=Path('/tmp/qbank-prepladder-source-test-map-v1.json')
DECISIONS=Path('/tmp/qbank-prepladder-source-test-review-decisions.json')
PAGE=Path(__file__).parents[1]/'source-test-review.html'
class Handler(SimpleHTTPRequestHandler):
 def do_GET(self):
  u=urllib.parse.urlparse(self.path)
  if u.path=='/':
   data=PAGE.read_bytes(); self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(data); return
  if u.path=='/api/tests':
   q=urllib.parse.parse_qs(u.query); d=json.loads(REPORT.read_text())['results']; subjects=sorted({r['subject'] for r in d}); term=q.get('q',[''])[0].lower(); subject=q.get('subject',[''])[0]; kind=q.get('type',[''])[0]; exceptions=q.get('exceptions',[''])[0]=='1'
   d=[r for r in d if (not term or term in (r['source_test']+' '+r['subject']).lower()) and (not subject or r['subject']==subject) and (not kind or r['type']==kind) and (not exceptions or r['needs_review'])]
   page=max(1,int(q.get('page',['1'])[0])); size=25; decisions=json.loads(DECISIONS.read_text()) if DECISIONS.exists() else {}; items=d[(page-1)*size:page*size]
   for item in items: item['review_decision']=decisions.get(item['source_test_id'])
   body=json.dumps({'total':len(d),'page':page,'subjects':subjects,'items':items}).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(body); return
  self.send_error(404)
 def do_POST(self):
  if self.path!='/api/decision': self.send_error(404); return
  length=int(self.headers.get('Content-Length','0')); item=json.loads(self.rfile.read(length)); allowed={'accept','correct_topic','mixed','broad_related','defer'}
  if item.get('decision') not in allowed or not item.get('source_test_id'): self.send_error(400); return
  decisions=json.loads(DECISIONS.read_text()) if DECISIONS.exists() else {}; decisions[item['source_test_id']]={'decision':item['decision'],'topic':item.get('topic')}
  DECISIONS.write_text(json.dumps(decisions,indent=2)); body=b'{"ok":true}'; self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(body)
if __name__=='__main__':
 ap=argparse.ArgumentParser(); ap.add_argument('--port',type=int,default=4174); a=ap.parse_args(); ThreadingHTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
