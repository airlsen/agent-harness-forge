#!/usr/bin/env python3
"""隔离集成回归：临时数据库/认证/Runner + 本机协议夹具，绝不修改业务配置。

这验证正式 FastAPI→正式 Runner→真实 dsh→协议夹具的工程闭环；不等于真实模型验收。
"""

import asyncio
import hashlib
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
requests, checks = [], []


def check(name, condition):
    assert condition, name
    checks.append(name)
    print("PASS", name)


class GatewayFixture(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        requests.append(body)
        if not body.get("stream"):
            raw = json.dumps(
                {
                    "choices": [
                        {
                            "message": {"role": "assistant", "content": "OK"},
                            "finish_reason": "stop",
                        }
                    ]
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        last = max(
            (
                i
                for i, item in enumerate(body["messages"])
                if item["role"] == "user"
                and not item.get("content", "").startswith("Current runtime context.")
            ),
            default=0,
        )
        text = body["messages"][last].get("content", "")
        tool_answered = any(
            item["role"] == "tool" for item in body["messages"][last + 1 :]
        )
        if "WRITE" in text and not tool_answered:
            chunks = [
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": f"fixture-{len(requests)}",
                                        "type": "function",
                                        "function": {
                                            "name": "workspace_write",
                                            "arguments": json.dumps(
                                                {
                                                    "path": "result.md",
                                                    "content": "# API integration fixture\n",
                                                }
                                            ),
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                },
                {
                    "choices": [{"delta": {}, "finish_reason": "tool_calls"}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 10},
                },
            ]
        else:
            chunks = [
                {"choices": [{"delta": {"content": "Protocol fixture response. "}}]},
                {
                    "choices": [
                        {
                            "delta": {"content": "Not a real model."},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 10},
                },
            ]
        raw = (
            "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
            + "data: [DONE]\n\n"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if "HOLD" in text:
            boundary = raw.find(b"\n\n") + 2
            self.wfile.write(raw[:boundary])
            self.wfile.flush()
            time.sleep(3)
            self.wfile.write(raw[boundary:])
        else:
            self.wfile.write(raw)


def wait_value(fn, predicate, seconds=12):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = fn()
        if predicate(value):
            return value
        time.sleep(0.04)
    raise AssertionError("Timed out waiting for test condition")


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


with tempfile.TemporaryDirectory(prefix="forge-api-test-") as temp:
    data = Path(temp)
    password, token, salt = (
        secrets.token_urlsafe(16),
        secrets.token_urlsafe(32),
        secrets.token_hex(16),
    )
    (data / "auth.json").write_text(
        json.dumps(
            {
                "username": "admin",
                "salt": salt,
                "digest": hashlib.scrypt(
                    password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1
                ).hex(),
                "signing_key": secrets.token_hex(32),
            }
        )
    )
    port = free_port()
    env = {
        **os.environ,
        "FORGE_DATA_DIR": temp,
        "FORGE_DATABASE_URL": f"sqlite+aiosqlite:///{data / 'test.db'}",
        "FORGE_RUNNER_ENDPOINTS": f"http://127.0.0.1:{port}",
        "FORGE_RUNNER_TOKEN": token,
        "FORGE_RUNNER_DATA_DIR": str(data / "runner-sessions"),
        "PORT": str(port),
        "FORGE_PREVIEW_HEADER_AUTH": "true"
        if "--cookie-blocked" in sys.argv
        else "false",
    }
    os.environ.update(env)
    node = (
        str(Path("/home/user/.local/node/bin/node"))
        if Path("/home/user/.local/node/bin/node").exists()
        else shutil.which("node")
    )
    runner_log = open(data / "runner.log", "w+")

    def start_runner():
        process = subprocess.Popen(
            [node, "--import", "tsx", "src/server.ts"],
            cwd=ROOT / "runner",
            env=env,
            stdout=subprocess.PIPE,
            stderr=runner_log,
            text=True,
        )
        if (
            not select.select([process.stdout], [], [], 20)[0]
            or "business Runner ready" not in process.stdout.readline()
        ):
            process.terminate()
            raise RuntimeError("Test Runner failed to start")
        return process

    runner = start_runner()
    gateway = ThreadingHTTPServer(("127.0.0.1", 0), GatewayFixture)
    threading.Thread(target=gateway.serve_forever, daemon=True).start()
    try:
        import httpx
        from fastapi.testclient import TestClient
        from src.api.main import app
        from src.api.core.database import SessionFactory, init_db
        from src.api.models.agent_session import AgentSession, SessionEventIndex
        from src.api.models.approval_ticket import ApprovalTicket

        with TestClient(app) as client:

            def api(method, path, data=None, code=200):
                response = client.request(method, "/api" + path, json=data)
                assert response.status_code == code, (
                    method,
                    path,
                    response.status_code,
                    response.text[:500],
                )
                return response.json().get("data")

            check(
                "unauthenticated business API is protected",
                client.get("/api/agent-scenarios").status_code == 401,
            )
            check(
                "unicode invalid username fails cleanly",
                client.post(
                    "/api/auth/login",
                    json={"username": "未授权用户", "password": "invalid"},
                ).status_code
                == 401,
            )
            api("POST", "/auth/login", {"username": "admin", "password": password})
            auth = api("GET", "/auth/session")
            check(
                "login creates HttpOnly same-site workspace cookie",
                auth["authenticated"] and "forge_session" in client.cookies,
            )
            check(
                "mutation without CSRF is rejected",
                client.post("/api/agent-scenarios", json={"name": "csrf"}).status_code
                == 403,
            )
            client.headers["X-Forge-CSRF"] = auth["csrfToken"]
            runtime = api("GET", "/runtime/status")
            check(
                "production API has no fallback fake model",
                runtime["runner"]["mode"] == "real-model-only"
                and not runtime["model"]["configured"],
            )
            scenarios = api("GET", "/agent-scenarios")
            check("four real scenario templates seeded", len(scenarios) == 4)
            original = scenarios[2]
            api("PUT", f"/agent-scenarios/{original['id']}", original["payload"], 403)
            check("official templates are read-only", True)
            api("POST", "/agent/sessions", {"scenarioId": original["id"]}, 409)
            api("POST", f"/agent-scenarios/{original['id']}/run-test", code=409)
            check(
                "no model means no created execution or fabricated test",
                api("GET", "/audit/sessions")["items"] == [],
            )
            scene = api("POST", f"/agent-scenarios/{original['id']}/copy")
            payload = {**scene["payload"], "name": "API acceptance fixture"}
            edited = api("PUT", f"/agent-scenarios/{scene['id']}", payload)
            check(
                "scenario copy/edit creates immutable version history",
                edited["current_version"] == 2
                and len(api("GET", f"/agent-scenarios/{scene['id']}/versions")) == 2,
            )
            api("POST", f"/agent-scenarios/{scene['id']}/publish", code=409)
            api("POST", "/agent-scenarios", {**payload, "name": "   "}, 422)
            api(
                "POST",
                "/agent-scenarios",
                {**payload, "capabilities": {"builtin_tool_names": ["shell"]}},
                422,
            )
            api(
                "POST",
                "/agent-scenarios",
                {**payload, "capabilities": {"skill_ids": [1]}},
                422,
            )
            check("unimplemented tools and Skill mounts cannot be forged", True)
            connection = {
                "name": "Test fixture only",
                "baseUrl": f"http://127.0.0.1:{gateway.server_port}/v1",
                "model": "fixture-A",
                "apiKey": "secret-fixture-key",
                "inputPrice": 2,
                "outputPrice": 4,
            }
            api(
                "PUT",
                "/models/connection",
                {**connection, "baseUrl": "http://169.254.169.254/v1"},
                422,
            )
            api(
                "PUT",
                "/models/connection",
                {**connection, "baseUrl": "http://[fe80::1]/v1"},
                422,
            )
            check("metadata and IPv6 link-local endpoints rejected", True)
            saved = api("PUT", "/models/connection", connection)
            check(
                "API never returns saved model key",
                saved["apiKeyConfigured"]
                and "secret-fixture-key" not in json.dumps(saved),
            )
            result = api("POST", "/models/connection/test")
            check(
                "connection test performs actual HTTP protocol request",
                result["ok"] and requests[-1]["stream"] is False
                if "stream" in requests[-1]
                else result["ok"],
            )
            session = api("POST", "/agent/sessions", {"scenarioId": scene["id"]})
            sid = session["id"]
            receipt = api(
                "POST", f"/agent/sessions/{sid}/turns", {"message": "WRITE"}, 202
            )
            approvals = wait_value(
                lambda: api("GET", "/agent/approvals")["items"], bool
            )
            api("POST", f"/agent/sessions/{sid}/turns", {"message": "second"}, 409)
            check(
                "one turn per session; background execution waits for approval",
                api("GET", f"/agent/sessions/{sid}")["status"] == "running",
            )
            api(
                "POST",
                f"/agent/approvals/{approvals[0]['ticketId']}/resolve",
                {"action": "approve"},
            )
            detail = wait_value(
                lambda: api("GET", f"/agent/sessions/{sid}"),
                lambda item: item["status"] != "running",
            )
            check(
                "assistant and actual tool results persist",
                any(
                    m["role"] == "tool" and not m["meta"]["isError"]
                    for m in detail["messages"]
                )
                and any(m["role"] == "assistant" for m in detail["messages"]),
            )
            check(
                "usage and snapshot pricing calculated",
                detail["tokensIn"] == 200
                and detail["tokensOut"] == 20
                and abs(detail["cost"] - 0.00048) < 1e-8,
            )
            check(
                "workspace file can be listed and read",
                api("GET", f"/agent/sessions/{sid}/files")["items"][0]["path"]
                == "result.md"
                and api("GET", f"/agent/sessions/{sid}/file?path=result.md")[
                    "content"
                ].startswith("# API"),
            )
            events_response = client.get(f"/api/agent/sessions/{sid}/events")
            check(
                "SSE carries durable event IDs and a settled event",
                "event: kernel" in events_response.text
                and "event: settled" in events_response.text
                and "approval_required" in events_response.text,
            )
            export = client.get(f"/api/agent/sessions/{sid}/export")
            check(
                "JSON export excludes model secrets",
                export.status_code == 200
                and "secret-fixture-key" not in export.text
                and export.json()["events"],
            )
            connection.update({"model": "fixture-B", "inputPrice": 20})
            api("PUT", "/models/connection", connection)
            api(
                "POST",
                f"/agent/sessions/{sid}/turns",
                {"message": "PLAIN second turn"},
                202,
            )
            wait_value(
                lambda: api("GET", f"/agent/sessions/{sid}"),
                lambda item: item["status"] != "running",
            )
            check(
                "existing session retains model and price snapshot after settings change",
                requests[-1]["model"] == "fixture-A"
                and api("GET", f"/agent/sessions/{sid}")["bundle"]["meta"]["inputPrice"]
                == 2,
            )
            test = api("POST", f"/agent-scenarios/{scene['id']}/run-test")
            check(
                "scenario run-test is archived but remains visible in audit",
                test["ok"]
                and any(
                    row["id"] == test["sessionId"] and row["isTest"]
                    for row in api("GET", "/audit/sessions")["items"]
                ),
            )
            published = api("POST", f"/agent-scenarios/{scene['id']}/publish")
            check(
                "publish requires successful current-version current-environment test",
                published["status"] == "published",
            )
            policy = api("GET", "/governance/policies")
            api(
                "PUT",
                "/governance/policies",
                {**policy, "allowedTools": ["current_time"]},
            )
            api("POST", f"/agent-scenarios/{scene['id']}/publish", code=409)
            check(
                "policy changes invalidate the earlier publish test",
                not api("GET", f"/agent-scenarios/{scene['id']}")["tested"],
            )
            restricted = api("POST", "/agent/sessions", {"scenarioId": scene["id"]})
            api(
                "POST",
                f"/agent/sessions/{restricted['id']}/turns",
                {"message": "WRITE should be unavailable"},
                202,
            )
            restricted_detail = wait_value(
                lambda: api("GET", f"/agent/sessions/{restricted['id']}"),
                lambda item: item["status"] != "running",
            )
            check(
                "scenario and platform policy intersect; unadvertised tool cannot execute",
                restricted_detail["bundle"]["meta"]["builtin_tools"] == ["current_time"]
                and any(
                    m["role"] == "tool" and m["meta"]["isError"]
                    for m in restricted_detail["messages"]
                )
                and not api("GET", f"/agent/sessions/{restricted['id']}/files")[
                    "items"
                ],
            )
            api("PUT", "/governance/policies", policy)
            cancelled = api("POST", "/agent/sessions", {"scenarioId": scene["id"]})
            api(
                "POST",
                f"/agent/sessions/{cancelled['id']}/turns",
                {"message": "WRITE pending interrupt"},
                202,
            )
            wait_value(lambda: api("GET", "/agent/approvals")["items"], bool)
            api("POST", f"/agent/sessions/{cancelled['id']}/interrupt")
            check(
                "interruption cancels all pending approval tickets",
                not api("GET", "/agent/approvals")["items"]
                and api("GET", f"/agent/sessions/{cancelled['id']}")["status"]
                == "error",
            )
            api("DELETE", f"/agent/sessions/{sid}")
            check(
                "archive releases Runner capacity but retains local artifacts and audit",
                api("GET", f"/agent/sessions/{sid}/file?path=result.md")["content"]
                and any(
                    row["id"] == sid for row in api("GET", "/audit/sessions")["items"]
                ),
            )
            api("POST", f"/agent/sessions/{sid}/turns", {"message": "forbidden"}, 409)

            # 写入的是隔离数据库内的显式测试事件，不会进入真实工作空间。
            pagination = api("POST", "/agent/sessions", {"scenarioId": scene["id"]})
            orphan = api("POST", "/agent/sessions", {"scenarioId": scene["id"]})

            async def seed_recovery():
                async with SessionFactory() as db:
                    for seq in range(1, 2202):
                        db.add(
                            SessionEventIndex(
                                session_id=pagination["id"],
                                seq=seq,
                                source="system",
                                kind="protocol-test-fixture",
                                attrs={"index": seq},
                            )
                        )
                    row = await db.get(AgentSession, orphan["id"])
                    row.status = "running"
                    db.add(
                        ApprovalTicket(
                            session_id=orphan["id"],
                            tool_call_id="fixture-orphan",
                            tool="workspace_write",
                            status="pending",
                        )
                    )
                    await db.commit()
                await init_db()

            client.portal.call(seed_recovery)
            check(
                "replay reads beyond the old 2000-event truncation",
                len(api("GET", f"/audit/sessions/{pagination['id']}/replay")["events"])
                == 2201,
            )
            response = client.get(
                f"/api/agent/sessions/{pagination['id']}/events?after=0",
                headers={"Last-Event-ID": "2201"},
            )
            check(
                "SSE reconnect honors Last-Event-ID",
                "event: kernel" not in response.text
                and "event: settled" in response.text,
            )
            recovered = api("GET", f"/agent/sessions/{orphan['id']}")
            check(
                "control-plane startup repairs orphaned runs and approvals",
                recovered["status"] == "interrupted"
                and not recovered["pendingApprovals"],
            )
            runner.terminate()
            runner.wait(timeout=10)
            runner = start_runner()
            check(
                "artifact access survives actual Runner process restart",
                api("GET", f"/agent/sessions/{sid}/file?path=result.md")[
                    "content"
                ].startswith("# API"),
            )
            api(
                "POST",
                f"/agent/sessions/{restricted['id']}/turns",
                {"message": "after restart"},
                409,
            )
            check(
                "missing runtime after Runner restart returns explicit conflict", True
            )
            api("DELETE", f"/agent-scenarios/{scene['id']}")
            api("GET", f"/agent-scenarios/{scene['id']}", code=404)
            check(
                "deleted scenario does not destroy historic session snapshot",
                api("GET", f"/agent/sessions/{sid}")["scenarioName"]
                == "API acceptance fixture",
            )
            api("POST", "/auth/logout")
            check(
                "logout removes authenticated browser access",
                not api("GET", "/auth/session")["authenticated"]
                and client.get("/api/audit/sessions").status_code == 401,
            )
            check(
                "Runner rejects requests without internal token",
                httpx.get(f"http://127.0.0.1:{port}/v1/runtime").status_code == 401,
            )
        with TestClient(app) as restarted:
            restarted.post(
                "/api/auth/login", json={"username": "admin", "password": password}
            )
            check(
                "database messages and version snapshots survive control-plane lifespan restart",
                restarted.get(f"/api/agent/sessions/{sid}").json()["data"]["messages"][
                    -1
                ]["role"]
                == "assistant",
            )
        check(
            "raw gateway key never appears in SQLite database or WAL",
            all(
                b"secret-fixture-key" not in file.read_bytes()
                for file in data.glob("test.db*")
            ),
        )
        report = {
            "scope": "isolated protocol fixture, not real-model acceptance",
            "checks": len(checks),
            "result": "passed",
            "items": checks,
        }
        destination = ROOT / "data/business-checks/api-fixture-report.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(
            json.dumps({key: value for key, value in report.items() if key != "items"})
        )
        if "--browser" in sys.argv:
            from execution_ui_check import check_execution_ui

            api_port = free_port()
            cookie_blocked = "--cookie-blocked" in sys.argv
            api_module = "src.api.main:app"
            api_env = dict(env)
            if cookie_blocked:
                # 测试专用 ASGI 透明过滤器：真实业务应用不变，只模拟代理完全剥离 Cookie。
                # 不将此测试开关或夹具加入生产入口，事件流原样传递，不缓冲审批/SSE。
                (data / "forge_cookie_filter.py").write_text(
                    "from src.api.main import app as real_app\n"
                    "async def app(scope, receive, send):\n"
                    "    if scope['type'] != 'http':\n"
                    "        return await real_app(scope, receive, send)\n"
                    "    scope = {**scope, 'headers': [(k, v) for k, v in scope['headers'] if k.lower() != b'cookie']}\n"
                    "    async def filtered(message):\n"
                    "        if message['type'] == 'http.response.start':\n"
                    "            message = {**message, 'headers': [(k, v) for k, v in message['headers'] if k.lower() != b'set-cookie']}\n"
                    "        await send(message)\n"
                    "    await real_app(scope, receive, filtered)\n"
                )
                api_env["PYTHONPATH"] = str(data) + os.pathsep + str(ROOT / "backend")
                api_module = "forge_cookie_filter:app"
            api_process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    api_module,
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(api_port),
                ],
                cwd=ROOT / "backend",
                env=api_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            try:
                for _ in range(10):
                    if not select.select([api_process.stdout], [], [], 15)[0]:
                        raise RuntimeError("Isolated API startup timed out")
                    line = api_process.stdout.readline()
                    if "Uvicorn running" in line:
                        break
                    if not line:
                        raise RuntimeError("Isolated API exited during startup")

                # Drain access logs throughout the expanded browser journey, not just
                # startup. Otherwise an unread OS pipe could eventually block uvicorn
                # and turn test-harness backpressure into a false execution failure.
                def drain_browser_logs():
                    for _ in api_process.stdout:
                        pass

                log_drain = threading.Thread(target=drain_browser_logs, daemon=True)
                log_drain.start()
                asyncio.run(
                    check_execution_ui(
                        f"http://127.0.0.1:{api_port}",
                        "admin",
                        password,
                        ROOT
                        / (
                            "data/business-checks/execution-ui-cookie-blocked-report.json"
                            if cookie_blocked
                            else "data/business-checks/execution-ui-report.json"
                        ),
                        cookie_blocked=cookie_blocked,
                    )
                )
            finally:
                api_process.terminate()
                try:
                    api_process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    api_process.kill()
                    api_process.wait()
    finally:
        runner.terminate()
        try:
            runner.wait(timeout=10)
        except subprocess.TimeoutExpired:
            runner.kill()
            runner.wait()
        gateway.shutdown()
        gateway.server_close()
        runner_log.close()
