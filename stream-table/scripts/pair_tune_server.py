#!/usr/bin/env python3
"""
Static file server with PUT support scoped to calib/*.json.

Run from the stream-table/ directory:
    python3 scripts/pair_tune_server.py
Then open http://localhost:8000/calib/pair_tune.html
"""
import http.server
import os
import socketserver
import sys
from pathlib import Path

PORT = 8000
ROOT = Path(__file__).resolve().parent.parent
CALIB = ROOT / "calib"


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_PUT(self):
        self._write(overwrite=True)

    def do_POST(self):
        self._write(overwrite=True)

    def _write(self, overwrite: bool):
        rel = self.path.lstrip("/")
        target = (ROOT / rel).resolve()
        # Sandbox: only allow writes inside calib/ and only .json
        try:
            target.relative_to(CALIB.resolve())
        except ValueError:
            self.send_error(403, "writes only allowed inside calib/")
            return
        if target.suffix != ".json":
            self.send_error(403, "writes only allowed for .json files")
            return
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 10 * 1024 * 1024:
            self.send_error(411, "missing or oversize Content-Length")
            return
        body = self.rfile.read(length)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')
        sys.stderr.write(f"PUT {rel} ({length} bytes)\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    os.chdir(ROOT)
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Serving {ROOT} on http://localhost:{PORT}")
        print(f"PUT sink: {CALIB}/*.json")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")


if __name__ == "__main__":
    main()
