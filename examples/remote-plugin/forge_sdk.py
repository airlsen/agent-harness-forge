"""Minimal Forge remote Worker contract. Copy or vendor this file into a Worker service."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def serve(tools: dict, *, credential_env: str, host: str = "127.0.0.1", port: int = 8765):
    token = os.environ.get(credential_env, "")
    if not token:
        raise RuntimeError(f"{credential_env} is required")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/healthz":
                return self.respond(404, {"message": "not found"})
            return self.respond(200, {"status": "ok"})

        def do_POST(self):
            if self.path != "/invoke":
                return self.respond(404, {"message": "not found"})
            if self.headers.get("Authorization") != f"Bearer {token}":
                return self.respond(401, {"message": "unauthorized"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size < 1 or size > 65536:
                    return self.respond(413, {"message": "request too large"})
                request = json.loads(self.rfile.read(size))
                tool = tools.get(request.get("tool"))
                if tool is None or not isinstance(request.get("arguments"), dict):
                    return self.respond(422, {"message": "unknown tool or invalid arguments"})
                return self.respond(200, {"result": tool(request["arguments"])})
            except (ValueError, KeyError, TypeError) as error:
                return self.respond(422, {"message": str(error)[:200]})

        def respond(self, code, value):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    ThreadingHTTPServer((host, port), Handler).serve_forever()
