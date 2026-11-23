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
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
requests, checks = [], []


def check(name, condition):
    assert condition, name
    checks.append(name)
    print("PASS", name)


# 演示 CRM 插件中声明为「需审批」的工具：审批相关的端到端检查都用它触发确认
APPROVAL_TOOL = "crm_add_customer_note"
APPROVAL_PLUGIN = {
    "plugin_names": ["forge-runtime", "forge-demo-crm"],
    "plugin_tools": {"forge-demo-crm": ["crm_find_customer", APPROVAL_TOOL]},
}


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
        answered = sum(
            1 for item in body["messages"][last + 1 :] if item["role"] == "tool"
        )
        upper = text.upper()
        # 审批夹具：bash 与 Skill 脚本已直接执行，改用演示 CRM 插件中声明「需审批」的写入工具
        if not answered and ("PENDING INTERRUPT" in upper or "APPROVAL" in upper):
            tool_name = APPROVAL_TOOL
            tool_arguments = {
                "customerId": "crm-1001",
                "note": "API integration fixture",
            }
        elif "WRITE" in text and (
            not answered or (answered == 1 and "APPROVAL" in upper)
        ):
            tool_name = "workspace_write"
            tool_arguments = {
                "path": "result.md",
                "content": "# API integration fixture\n",
            }
        else:
            tool_name = None
            tool_arguments = None

        if tool_name:
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
                                            "name": tool_name,
                                            "arguments": json.dumps(tool_arguments),
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
                {
                    "choices": [
                        {"delta": {"reasoning_content": "Protocol fixture thinking. "}}
                    ]
                },
                {"choices": [{"delta": {"reasoning_content": "Still reasoning."}}]},
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
        frames = [f"data: {json.dumps(chunk)}\n\n".encode() for chunk in chunks]
        raw = b"".join(frames) + b"data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if "HOLD" in text:
            # Pause after visible assistant text starts so the browser can reliably
            # observe the in-progress state before the fixture completes the turn.
            content_index = next(
                (
                    index
                    for index, chunk in enumerate(chunks)
                    if any(
                        choice.get("delta", {}).get("content")
                        for choice in chunk.get("choices", [])
                    )
                ),
                None,
            )
            boundary = (
                sum(len(frame) for frame in frames[: content_index + 1])
                if content_index is not None
                else len(frames[0])
            )
            self.wfile.write(raw[:boundary])
            self.wfile.flush()
            time.sleep(8 if content_index is not None else 3)
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
            payload = {
                **scene["payload"],
                "name": "API acceptance fixture",
                "capabilities": {**scene["payload"]["capabilities"], **APPROVAL_PLUGIN},
            }
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
            check(
                "saved model key is shown only via explicit reveal request",
                "secret-fixture-key" not in json.dumps(api("GET", "/models"))
                and api("POST", f"/models/{saved['id']}/key")["apiKey"]
                == "secret-fixture-key",
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
            api(
                "POST",
                f"/agent/sessions/{sid}/turns",
                {"message": "APPROVAL HOLD"},
                202,
            )
            approvals = wait_value(
                lambda: api("GET", "/agent/approvals")["items"], bool
            )
            api("POST", f"/agent/sessions/{sid}/turns", {"message": "second"}, 409)
            check(
                "one turn per session; an approval-required plugin tool pauses execution",
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
                    m["role"] == "tool"
                    and m["meta"]["tool"] == APPROVAL_TOOL
                    and not m["meta"]["isError"]
                    for m in detail["messages"]
                )
                and any(m["role"] == "assistant" for m in detail["messages"]),
            )
            check(
                "reasoning settles into assistant message meta",
                any(
                    m["role"] == "assistant"
                    and "Protocol fixture thinking." in m["meta"].get("reasoning", "")
                    for m in detail["messages"]
                ),
            )
            check(
                "usage and snapshot pricing calculated",
                detail["tokensIn"] == 200
                and detail["tokensOut"] == 20
                and abs(detail["cost"] - 0.00048) < 1e-8,
            )
            api(
                "POST",
                f"/agent/sessions/{sid}/turns",
                {"message": "WRITE"},
                202,
            )
            write_detail = wait_value(
                lambda: api("GET", f"/agent/sessions/{sid}"),
                lambda item: item["status"] != "running",
            )
            check(
                "workspace_write runs directly without an approval prompt",
                any(
                    message["role"] == "tool"
                    and message["meta"]["tool"] == "workspace_write"
                    and not message["meta"]["isError"]
                    for message in write_detail["messages"]
                )
                and not api("GET", "/agent/approvals")["items"],
            )
            files = api("GET", f"/agent/sessions/{sid}/files")["items"]
            check(
                "workspace file can be listed and read",
                any(item["path"] == "result.md" for item in files)
                and api("GET", f"/agent/sessions/{sid}/file?path=result.md")[
                    "content"
                ].startswith("# API"),
            )
            events_response = client.get(f"/api/agent/sessions/{sid}/events")
            check(
                "SSE carries durable event IDs and a settled event",
                "event: kernel" in events_response.text
                and "event: settled" in events_response.text
                and "approval_required" in events_response.text
                and "reasoning_delta" in events_response.text,
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
            plugin_scenario = api(
                "POST",
                "/agent-scenarios",
                {
                    **payload,
                    "name": "API plugin policy fixture",
                    "capabilities": {
                        **payload["capabilities"],
                        "plugin_names": ["forge-runtime", "forge-demo-crm"],
                        "plugin_tools": {
                            "forge-demo-crm": [
                                "crm_find_customer",
                                "crm_add_customer_note",
                            ]
                        },
                    },
                },
            )
            policy = api("GET", "/governance/policies")
            api(
                "PUT",
                "/governance/policies",
                {
                    **policy,
                    "allowedTools": ["current_time"],
                    "allowedPluginTools": ["crm_find_customer"],
                },
            )
            api("POST", f"/agent-scenarios/{scene['id']}/publish", code=409)
            check(
                "policy changes invalidate the earlier publish test",
                not api("GET", f"/agent-scenarios/{scene['id']}")["tested"],
            )
            existing_snapshot = api("GET", f"/agent/sessions/{sid}")["bundle"]["meta"]
            check(
                "governance changes leave existing session policy snapshots unchanged",
                "workspace_write" in existing_snapshot["builtin_tools"]
                and "workspace_write" in existing_snapshot["policy"]["allowedTools"],
            )
            plugin_session = api(
                "POST",
                "/agent/sessions",
                {"scenarioId": plugin_scenario["id"]},
            )
            plugin_meta = api("GET", f"/agent/sessions/{plugin_session['id']}")[
                "bundle"
            ]["meta"]
            check(
                "new sessions intersect frozen plugin bindings with current policy",
                plugin_meta["plugin_tools"] == ["crm_find_customer"]
                and [tool["name"] for tool in plugin_meta["pluginBindings"][0]["tools"]]
                == ["crm_find_customer"],
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
            # Runner 重启后，业务会话按数据库快照恢复并从磁盘会话日志接续（session/resume）
            api(
                "POST",
                f"/agent/sessions/{restricted['id']}/turns",
                {"message": "PLAIN after restart"},
                202,
            )
            resumed = wait_value(
                lambda: api("GET", f"/agent/sessions/{restricted['id']}"),
                lambda item: item["status"] != "running",
            )
            check(
                "business session resumes from its session log after Runner restart",
                resumed["status"] == "idle"
                and resumed["messages"][-1]["role"] == "assistant",
            )

            async def runner_session_id(session_id):
                async with SessionFactory() as db:
                    return (await db.get(AgentSession, session_id)).runner_session_id

            lost = client.portal.call(runner_session_id, cancelled["id"])
            shutil.rmtree(data / "runner-sessions" / lost / "session-log")
            runner.terminate()
            runner.wait(timeout=10)
            runner = start_runner()
            api(
                "POST",
                f"/agent/sessions/{cancelled['id']}/turns",
                {"message": "after restart"},
                409,
            )
            check(
                "missing session log after Runner restart returns explicit conflict",
                True,
            )
            api("DELETE", f"/agent-scenarios/{scene['id']}")
            api("GET", f"/agent-scenarios/{scene['id']}", code=404)
            check(
                "deleted scenario does not destroy historic session snapshot",
                api("GET", f"/agent/sessions/{sid}")["scenarioName"]
                == "API acceptance fixture",
            )
            if "--browser" in sys.argv:
                # 测试专用：浏览器流程使用官方模板「文档与报告」，在隔离数据库中为它挂上演示 CRM 插件，
                # 让 APPROVAL 夹具有一个需审批的工具可调用；生产模板与真实工作空间不受影响。
                async def attach_approval_plugin():
                    from dataclasses import asdict
                    from sqlalchemy import select
                    from src.api.models.agent_scenario import AgentScenario
                    from src.api.schemas.agent_scenario import ScenarioPayload
                    from src.api.services.scenario_service import scenario_service
                    from src.api.services.settings_service import get_policy

                    async with SessionFactory() as db:
                        row = await db.scalar(
                            select(AgentScenario).where(
                                AgentScenario.space == "official",
                                AgentScenario.name == "文档与报告",
                            )
                        )
                        version = await scenario_service.version(db, row)
                        stored = version.bundle_json["payload"]
                        clean = ScenarioPayload.model_validate(
                            {
                                **stored,
                                "capabilities": {
                                    **stored["capabilities"],
                                    **APPROVAL_PLUGIN,
                                },
                            }
                        )
                        bundle = await scenario_service.assembler.compile(
                            db,
                            clean,
                            tenant_policy=await get_policy(db),
                            rendered_prompt=clean.prompt_template,
                        )
                        version.bundle_json = {
                            "payload": clean.model_dump(),
                            "bundle": asdict(bundle),
                        }
                        version.bundle_hash = bundle.bundle_hash
                        await db.commit()
                        return row.id

                template_id = client.portal.call(attach_approval_plugin)
                probe = api("POST", "/agent/sessions", {"scenarioId": template_id})
                api(
                    "POST",
                    f"/agent/sessions/{probe['id']}/turns",
                    {"message": "APPROVAL template probe"},
                    202,
                )
                pending = wait_value(
                    lambda: api("GET", "/agent/approvals")["items"], bool
                )
                api(
                    "POST",
                    f"/agent/approvals/{pending[0]['ticketId']}/resolve",
                    {"action": "deny"},
                )
                wait_value(
                    lambda: api("GET", f"/agent/sessions/{probe['id']}"),
                    lambda item: item["status"] != "running",
                )
                api("DELETE", f"/agent/sessions/{probe['id']}")
                check(
                    "browser fixture template exposes an approval-required plugin tool",
                    pending[0]["tool"] == APPROVAL_TOOL,
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
                browser_report = ROOT / (
                    "data/business-checks/execution-ui-cookie-blocked-report.json"
                    if cookie_blocked
                    else "data/business-checks/execution-ui-report.json"
                )
                try:
                    asyncio.run(
                        check_execution_ui(
                            f"http://127.0.0.1:{api_port}",
                            "admin",
                            password,
                            browser_report,
                            cookie_blocked=cookie_blocked,
                        )
                    )
                except Exception as error:
                    detail = f"{type(error).__name__}: {error}"
                    failure_report = browser_report.with_name(
                        browser_report.stem + "-failure.json"
                    )
                    if failure_report.is_file():
                        try:
                            state = json.loads(failure_report.read_text())
                            context = {
                                key: state.get(key)
                                for key in (
                                    "completedChecks",
                                    "url",
                                    "apiState",
                                    "pendingApprovalCards",
                                )
                            }
                            detail += " | browser state: " + json.dumps(
                                context, ensure_ascii=False, separators=(",", ":")
                            )
                        except (OSError, json.JSONDecodeError):
                            pass
                    annotation = (
                        detail.replace("%", "%25")
                        .replace("\r", "%0D")
                        .replace("\n", "%0A")
                    )
                    print(
                        f"::error title=Browser acceptance failure::{annotation}",
                        flush=True,
                    )
                    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
                    if summary_path:
                        with Path(summary_path).open("a", encoding="utf-8") as summary:
                            summary.write("### Browser acceptance failure\n\n```text\n")
                            summary.write(traceback.format_exc())
                            summary.write("\n```\n")
                    raise
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
