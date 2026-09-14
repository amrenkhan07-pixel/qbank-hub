#!/usr/bin/env python3
"""Local read-only review page for ambiguous two-stage label clusters."""
import argparse, json, urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

REPORT = Path("/tmp/qbank-target-adjudicator-review-v1.json")
PAGE = Path(__file__).parents[1] / "two-stage-concept-review.html"


class Handler(SimpleHTTPRequestHandler):
    def reply(self, value):
        body = json.dumps(value).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/":
            body = PAGE.read_bytes(); self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers(); self.wfile.write(body); return
        if url.path != "/api/items": self.send_error(404); return
        report = json.loads(REPORT.read_text())
        rows = ([{"kind": "cluster", **x} for x in report["ambiguous_clusters"]] +
                [{"kind": "assignment", **x} for x in report["suspicious_assignments"]])
        query = urllib.parse.parse_qs(url.query)
        page = max(1, int(query.get("page", ["1"])[0])); size = 20
        self.reply({"total": len(rows), "page": page,
                    "items": rows[(page-1)*size:page*size]})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--port", type=int, default=4176)
    args = parser.parse_args(); ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
