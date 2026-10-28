"""Serve dist locally and stall the first Gaussian response per scene.

Inspect /__qa/state.json to confirm the browser closed the unfinished body.
No changes are made to the assets. Restart the server to reset the experiment.
"""
import json
import select
import socket
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import monotonic

ROOT = Path(__file__).resolve().parents[2]
STATE = {}
LOCK = threading.Lock()
PATHS = {f"/scenes/{scene}/gaussians.ply.gz" for scene in ("pipes", "office")}


class Handler(SimpleHTTPRequestHandler):
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
        asset = ROOT / "dist" / self.path.lstrip("/")
        self.send_response(200)
        self.send_header("Content-Type", "application/gzip")
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
    ThreadingHTTPServer(("127.0.0.1", 5189), partial(Handler, directory=str(ROOT / "dist"))).serve_forever()
