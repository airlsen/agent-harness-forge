#!/usr/bin/env python3
"""Two-account regression for chat, streaming, files, approval, audit and Skill editor ownership."""

import asyncio
import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
import secrets
import sqlite3
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

with tempfile.TemporaryDirectory(prefix="forge-ownership-") as directory:
    data = Path(directory)
    admin_password, salt = secrets.token_urlsafe(18), secrets.token_hex(16)
    (data / "auth.json").write_text(
        json.dumps(
            {
                "username": "admin",
                "salt": salt,
                "digest": hashlib.scrypt(
                    admin_password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1
                ).hex(),
                "signing_key": secrets.token_hex(32),
            }
        )
    )
    os.environ.update(
        {
            "FORGE_DATA_DIR": directory,
            "FORGE_DATABASE_URL": f"sqlite+aiosqlite:///{data / 'ownership.db'}",
            "FORGE_RUNNER_TOKEN": secrets.token_urlsafe(40),
            "FORGE_REGISTRATION_ENABLED": "true",
        }
    )

    import httpx
    from fastapi.testclient import TestClient
    from sqlalchemy import select, update
    from src.api.main import app
    from src.api.core.database import SessionFactory
    from src.api.models.agent_session import AgentSession, SessionEventIndex
    from src.api.models.agent_scenario import AgentScenario
    from src.api.models.approval_ticket import ApprovalTicket
    from src.api.models.platform import ModelConnection, SessionMessage
    from src.api.models.registry import PluginRegistry
    from src.api.models.session_file import SessionFile
    from src.api.models.space import Space
    from src.api.models.skill import Skill, SkillAuthoringMessage, SkillAuthoringSession
    from src.api.services.file_store import file_store
    from src.api.services.skill_service import _recent_authoring_history

    async def seed(alice_id: str, bob_id: str):
        async with SessionFactory() as db:
            private_space = Space(name="Team One")
            db.add(private_space)
            await db.flush()
            db.add(
                ModelConnection(
                    name="Fixture",
                    base_url="https://example.org",
                    model="fixture-model",
                    credential="",
                    is_default=True,
                )
            )
            scenario_id = await db.scalar(select(AgentScenario.id).limit(1))
            assert scenario_id is not None
            plugin_id = await db.scalar(
                select(PluginRegistry.plugin_id)
                .where(PluginRegistry.plugin_id != "")
                .limit(1)
            )
            sessions = []
            for user_id in (alice_id, bob_id):
                row = AgentSession(
                    user_id=user_id,
                    space_id=private_space.id if user_id == alice_id else 1,
                    scenario_id=1,
                    scenario_version=1,
                    bundle_hash="fixture",
                    bundle_snapshot={"meta": {"scenarioName": "Test"}},
                    files_synced_at=datetime.now(UTC).replace(tzinfo=None),
                )
                db.add(row)
                await db.flush()
                sessions.append(row.id)
                db.add(
                    SessionMessage(
                        session_id=row.id, role="user", content=f"private {user_id}"
                    )
                )
                db.add(
                    SessionEventIndex(
                        session_id=row.id,
                        seq=1,
                        source="agent",
                        kind="done",
                        attrs={"user": user_id},
                    )
                )
                if plugin_id:
                    db.add(
                        SessionEventIndex(
                            session_id=row.id,
                            seq=2,
                            source="tools",
                            kind="plugin_call",
                            attrs={"package": plugin_id, "tool": "fixture"},
                        )
                    )
                db.add(
                    ApprovalTicket(
                        session_id=row.id,
                        tool_call_id=f"tool-{row.id}",
                        tool="bash",
                        status="pending",
                    )
                )
                content = f"file for {user_id}".encode()
                db.add(
                    SessionFile(
                        session_id=row.id,
                        path="private.txt",
                        sha256=file_store.put(content),
                        bytes=len(content),
                        mime="text/plain",
                    )
                )
            skill = Skill(name="Shared Skill")
            db.add(skill)
            await db.flush()
            authoring = []
            for user_id in (alice_id, bob_id):
                row = SkillAuthoringSession(skill_id=skill.id, owner_id=user_id)
                db.add(row)
                await db.flush()
                authoring.append(row.id)
                db.add(
                    SkillAuthoringMessage(
                        authoring_session_id=row.id,
                        seq=1,
                        role="user",
                        content=f"secret {user_id}",
                    )
                )
            await db.commit()
            alice_history = await _recent_authoring_history(db, skill.id, alice_id)
            assert f"secret {alice_id}" in alice_history
            assert f"secret {bob_id}" not in alice_history
            return (
                sessions,
                skill.id,
                authoring,
                private_space.id,
                plugin_id,
                scenario_id,
            )

    # 默认连接池上限为 5 个常驻 + 10 个临时；多开一个才能暴露“事件流一直占着连接”的问题
    STREAM_COUNT = 16

    async def concurrent_streams(cookie: str, user_id: str, scenario_id: int) -> None:
        """运行中会话的事件流会长时间保持打开，不能一直占着数据库连接：
        同时打开超过连接池上限的事件流后，其他接口仍须立即响应。"""
        async with SessionFactory() as db:
            rows = [
                AgentSession(
                    user_id=user_id,
                    scenario_id=scenario_id,
                    bundle_hash="stream",
                    status="running",
                )
                for _ in range(STREAM_COUNT)
            ]
            db.add_all(rows)
            await db.commit()
            ids = [row.id for row in rows]
        headers = [
            (b"host", b"testserver"),
            (b"cookie", f"forge_session={cookie}".encode()),
        ]
        closing = asyncio.Event()

        def stream(session_id: int, opened: asyncio.Event):
            # 直接走 ASGI：TestClient 和 httpx 的 ASGITransport 都要等响应结束才返回，测不了长连接
            path = f"/api/agent/sessions/{session_id}/events"
            scope = {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": path,
                "raw_path": path.encode(),
                "query_string": b"",
                "root_path": "",
                "headers": headers,
                "client": ("127.0.0.1", 50000 + session_id),
                "server": ("testserver", 80),
            }
            requested = False

            async def receive():
                nonlocal requested
                if not requested:
                    requested = True
                    return {"type": "http.request", "body": b"", "more_body": False}
                await closing.wait()
                return {"type": "http.disconnect"}

            async def send(message):
                if message["type"] == "http.response.start":
                    assert message["status"] == 200, (session_id, message["status"])
                elif message["type"] == "http.response.body" and message.get("body"):
                    opened.set()

            return app(scope, receive, send)

        events = [asyncio.Event() for _ in ids]
        tasks = [asyncio.create_task(stream(i, ready)) for i, ready in zip(ids, events)]
        try:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*(ready.wait() for ready in events)), 10
                )
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://testserver"
                ) as http:
                    listed = await asyncio.wait_for(
                        http.get(
                            "/api/agent/sessions",
                            headers={"cookie": f"forge_session={cookie}"},
                        ),
                        5,
                    )
            except TimeoutError:
                raise AssertionError(
                    f"同时打开 {STREAM_COUNT} 个运行中会话的事件流后接口无响应：事件流占住了数据库连接"
                ) from None
            assert listed.status_code == 200, listed.text
            assert set(ids).issubset(
                {item["id"] for item in listed.json()["data"]["items"]}
            )
        finally:
            closing.set()
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 10)
            # 收尾：不留“运行中”会话，避免下次启动时对账去找 Runner
            async with SessionFactory() as db:
                await db.execute(
                    update(AgentSession)
                    .where(AgentSession.id.in_(ids))
                    .values(status="idle")
                )
                await db.commit()

    with TestClient(app) as client:
        users = {}
        for username in ("alice", "bob"):
            password = f"secure-password-{username}"
            assert (
                client.post(
                    "/api/auth/register",
                    json={
                        "username": username,
                        "email": f"{username}@example.org",
                        "password": password,
                    },
                ).status_code
                == 201
            )
            assert (
                client.post(
                    "/api/auth/login",
                    json={
                        "username": username,
                        "password": password,
                    },
                ).status_code
                == 200
            )
            users[username] = (
                client.get("/api/auth/session").json()["data"]["user"]["id"],
                password,
            )
        (alice, _), (bob, bob_password) = users["alice"], users["bob"]
        (
            (alice_session, bob_session),
            skill_id,
            (alice_edit, bob_edit),
            private_space_id,
            plugin_id,
            scenario_id,
        ) = client.portal.call(seed, alice, bob)

        # Bob sees only his own session even in "all spaces", and cannot access Alice by a known ID.
        listed = client.get("/api/agent/sessions?space=all")
        assert listed.status_code == 200
        assert {item["id"] for item in listed.json()["data"]["items"]} == {bob_session}
        assert client.get(f"/api/agent/sessions/{bob_session}").status_code == 200
        if plugin_id:
            detail = client.get(f"/api/registry/plugins/{plugin_id}")
            assert detail.status_code == 200
            assert {
                row["sessionId"] for row in detail.json()["data"]["recentCalls"]
            } == {bob_session}
        assert (
            client.get(f"/api/agent/sessions/{bob_session}/trajectory").status_code
            == 200
        )
        assert (
            client.get(f"/api/agent/sessions/{bob_session}/export").status_code == 200
        )
        paths = (
            "",
            "/events",
            "/trajectory",
            "/files",
            "/files/raw?path=private.txt",
            "/files/archive",
            "/files/changes/1",
            "/file?path=private.txt",
            "/export",
        )
        for path in paths:
            response = client.get(f"/api/agent/sessions/{alice_session}{path}")
            assert response.status_code == 404, (path, response.status_code)
        csrf = client.get("/api/auth/session").json()["data"]["csrfToken"]
        created = client.post(
            "/api/agent/sessions",
            json={"scenarioId": scenario_id},
            headers={"X-Forge-CSRF": csrf},
        )
        assert created.status_code == 200, created.text
        assert created.json()["data"]["userId"] == bob
        assert (
            client.delete(
                f"/api/spaces/{private_space_id}", headers={"X-Forge-CSRF": csrf}
            ).status_code
            == 403
        )
        for method, path, body in (
            ("POST", "/turns", {"message": "steal"}),
            ("POST", "/interrupt", None),
            ("DELETE", "", None),
            ("DELETE", "/files?path=private.txt", None),
        ):
            response = client.request(
                method,
                f"/api/agent/sessions/{alice_session}{path}",
                json=body,
                headers={"X-Forge-CSRF": csrf},
            )
            assert response.status_code == 404, (path, response.status_code)
        assert (
            client.get(
                f"/api/agent/sessions/{bob_session}/files/raw?path=private.txt"
            ).content
            == f"file for {bob}".encode()
        )
        approvals = client.get("/api/agent/approvals")
        assert approvals.status_code == 200
        assert {item["sessionId"] for item in approvals.json()["data"]["items"]} == {
            bob_session
        }
        assert (
            client.post(
                "/api/agent/approvals/1/resolve",
                json={"action": "approve"},
                headers={"X-Forge-CSRF": csrf},
            ).status_code
            == 404
        )
        assert client.get("/api/audit/sessions").status_code == 403
        assert (
            client.get(f"/api/audit/sessions/{alice_session}/export").status_code == 403
        )
        assert (
            client.get(f"/api/audit/sessions/{alice_session}/replay").status_code == 403
        )

        latest = client.get(f"/api/skills/{skill_id}/authoring-session/latest")
        assert latest.status_code == 200 and latest.json()["data"]["id"] == bob_edit
        for path in ("/files", "/files/raw?path=private.txt"):
            assert (
                client.get(
                    f"/api/skills/{skill_id}/authoring-sessions/{alice_edit}{path}"
                ).status_code
                == 404
            )
        for path in ("/turns", "/interrupt", "/files?path=private.txt"):
            method = "DELETE" if path.startswith("/files") else "POST"
            response = client.request(
                method,
                f"/api/skills/{skill_id}/authoring-sessions/{alice_edit}{path}",
                json={"message": "steal"} if path == "/turns" else None,
                headers={"X-Forge-CSRF": csrf},
            )
            assert response.status_code == 404, (path, response.status_code)

        assert (
            client.post(
                "/api/auth/login",
                json={
                    "username": "admin",
                    "password": admin_password,
                },
            ).status_code
            == 200
        )
        audit = client.get("/api/audit/sessions")
        assert audit.status_code == 200
        assert {alice_session, bob_session}.issubset(
            {item["id"] for item in audit.json()["data"]["items"]}
        )
        assert (
            client.get(f"/api/audit/sessions/{alice_session}/replay").status_code == 200
        )
        assert client.get(f"/api/agent/sessions/{alice_session}").status_code == 404
        assert (
            client.get(f"/api/audit/sessions/{alice_session}/export").status_code == 200
        )
        assert (
            client.post(
                "/api/auth/login",
                json={"username": "alice", "password": users["alice"][1]},
            ).status_code
            == 200
        )
        assert client.get(f"/api/agent/sessions/{alice_session}").status_code == 200
        assert client.get(f"/api/agent/sessions/{bob_session}").status_code == 404
        assert (
            client.get(f"/api/skills/{skill_id}/authoring-session/latest").json()[
                "data"
            ]["id"]
            == alice_edit
        )
        client.portal.call(
            concurrent_streams, client.cookies.get("forge_session"), alice, scenario_id
        )

    # Simulate an old editor table without owner_id; restart must assign its sessions to admin.
    with sqlite3.connect(data / "ownership.db") as db:
        db.execute("DROP INDEX ix_skill_authoring_session_owner_id")
        db.execute("ALTER TABLE skill_authoring_session DROP COLUMN owner_id")
    with TestClient(app) as client:
        with sqlite3.connect(data / "ownership.db") as db:
            assert {
                row[0]
                for row in db.execute("SELECT owner_id FROM skill_authoring_session")
            } == {"admin"}
        assert (
            client.post(
                "/api/auth/login",
                json={
                    "username": "admin",
                    "password": admin_password,
                },
            ).status_code
            == 200
        )
        assert (
            client.get(f"/api/skills/{skill_id}/authoring-session/latest").json()[
                "data"
            ]["id"]
            == bob_edit
        )

    print(
        "PASS owner-only chat, SSE, files, messages, approvals, Skill editor; admin-only audit; legacy migration; concurrent SSE keeps DB pool free"
    )
