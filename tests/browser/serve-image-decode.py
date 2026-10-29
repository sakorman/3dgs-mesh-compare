"""Serve photos locally and stall the first JPEG response per scene.

Inspect /__qa/state.json to observe whether the unfinished request closed.
No changes are made to the assets. Restart the server to reset the experiment.
"""
import json
import select
import socket
import threading
from argparse import ArgumentParser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import monotonic

ROOT = Path(__file__).resolve().parents[2]
SERVE_ROOT = ROOT / "public"
STATE = {}
LOCK = threading.Lock()
PATHS = {}
for scene in ("pipes", "office"):
    data = json.loads((ROOT / "public" / "scenes" / scene / "scene.json").read_text())
    view = next(v for v in data["views"] if v["heldOut"])
    PATHS[f"/scenes/{scene}/{view['url']}"] = True


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:5190")
        super().end_headers()

    def do_GET(self):
        if self.path == "/__qa/state.json":
            with LOCK:
                body = json.dumps(STATE).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        with LOCK:
            stall = self.path in PATHS and self.path not in STATE
            if stall:
                STATE[self.path] = {"sentBytes": 0, "closedBeforeCompletion": False}
        if not stall:
            return super().do_GET()
        asset = SERVE_ROOT / self.path.lstrip("/")
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(asset.stat().st_size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with asset.open("rb") as f:
            prefix = f.read(1024)
        self.wfile.write(prefix)
        self.wfile.flush()
        with LOCK:
            STATE[self.path]["sentBytes"] = len(prefix)
        deadline = monotonic() + 60
        while monotonic() < deadline:
            if select.select([self.connection], [], [], 0.1)[0]:
                try:
                    closed = not self.connection.recv(1, socket.MSG_PEEK)
                except ConnectionResetError:
                    closed = True
                if closed:
                    with LOCK:
                        STATE[self.path]["closedBeforeCompletion"] = True
                    return
        with LOCK:
            STATE[self.path]["serverTimeout"] = True


if __name__ == "__main__":
    parser = ArgumentParser()
    parser.add_argument("--built", action="store_true", help="Serve the production page as well as photos")
    if parser.parse_args().built:
        SERVE_ROOT = ROOT / "dist"
    ThreadingHTTPServer(("127.0.0.1", 5191), partial(Handler, directory=str(SERVE_ROOT))).serve_forever()
