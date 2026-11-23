#!/usr/bin/env python3
"""隔离验证预览会话：默认关闭、密码门槛、CSRF、过期和退出吊销。无模型调用。"""

import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
checks = []


def check(name, condition):
    assert condition, name
    checks.append(name)
    print("PASS", name)


with tempfile.TemporaryDirectory(prefix="forge-preview-auth-") as temporary:
    data = Path(temporary)
    password, salt = secrets.token_urlsafe(18), secrets.token_hex(16)
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
    os.environ.update(
        {
            "FORGE_DATA_DIR": temporary,
            "FORGE_DATABASE_URL": f"sqlite+aiosqlite:///{data / 'auth-test.db'}",
            "FORGE_RUNNER_TOKEN": secrets.token_urlsafe(40),
            "FORGE_COOKIE_SECURE": "false",
            "FORGE_COOKIE_PARTITIONED": "false",
            "FORGE_COOKIE_SAMESITE": "strict",
            "FORGE_PREVIEW_HEADER_AUTH": "false",
        }
    )
    from fastapi.testclient import TestClient
    from src.api.main import app
    from src.api.core.config import settings
    from src.api.core.security import token_digest

    with TestClient(app) as client:
        payload = {"username": "admin", "password": password}
        response = client.post("/api/auth/login", json=payload)
        check(
            "ordinary login remains HttpOnly-cookie-only by default",
            response.status_code == 200
            and "HttpOnly" in response.headers.get("set-cookie", "")
            and "previewSession" not in response.json()["data"],
        )
        check(
            "ordinary cookie still authenticates protected APIs",
            client.get("/api/registry/tools").status_code == 200,
        )
        response = client.post(
            "/api/auth/login", json={**payload, "transport": "preview-header"}
        )
        check(
            "preview header transport is disabled unless explicitly enabled",
            response.status_code == 403,
        )
        client.cookies.clear()
        settings.preview_header_auth = True
        response = client.post(
            "/api/auth/login",
            json={**payload, "password": "incorrect", "transport": "preview-header"},
        )
        check(
            "preview transport cannot bypass password authentication",
            response.status_code == 401,
        )

        def create():
            response = client.post(
                "/api/auth/login", json={**payload, "transport": "preview-header"}
            )
            assert response.status_code == 200
            assert "set-cookie" not in response.headers
            return response.json()["data"]["previewSession"]

        session = create()
        token = session["token"]
        digest = hashlib.sha256(token.encode()).hexdigest()
        headers = {"X-Forge-Session": token}
        check(
            "preview credential is random, short-lived, and stored only as a server-side digest",
            token.startswith("fp1_")
            and len(token) == 47
            and 3590 < session["expiresAt"] - time.time() <= 3600
            and sqlite3.connect(data / "auth-test.db")
            .execute(
                "SELECT count(*) FROM login_session WHERE token_digest=?", (digest,)
            )
            .fetchone()[0]
            == 1,
        )
        auth = client.get("/api/auth/session", headers=headers).json()["data"]
        check(
            "header-only session works without any cookie",
            auth["authenticated"]
            and auth["transport"] == "preview-header"
            and not client.cookies
            and client.get("/api/registry/tools", headers=headers).status_code == 200,
        )
        check(
            "missing or forged credential stays unauthorized",
            client.get("/api/registry/tools").status_code == 401
            and client.get(
                "/api/registry/tools", headers={"X-Forge-Session": "fp1_" + "x" * 43}
            ).status_code
            == 401,
        )
        check(
            "query parameters cannot be used as session credentials",
            client.get(
                "/api/registry/tools", params={"token": token, "session": token}
            ).status_code
            == 401,
        )
        scenarios = client.get("/api/agent-scenarios", headers=headers).json()["data"]
        path = f"/api/agent-scenarios/{scenarios[0]['id']}/copy"
        check(
            "header-authenticated mutations still require matching CSRF",
            client.post(path, headers=headers).status_code == 403
            and client.post(
                path, headers={**headers, "X-Forge-CSRF": "wrong"}
            ).status_code
            == 403,
        )
        valid = {**headers, "X-Forge-CSRF": auth["csrfToken"]}
        check(
            "header authentication plus CSRF performs an actual protected mutation",
            client.post(path, headers=valid).status_code == 200,
        )
        check(
            "logout without CSRF cannot revoke a session",
            client.post("/api/auth/logout", headers=headers).status_code == 403
            and client.get("/api/registry/tools", headers=headers).status_code == 200,
        )
        other = create()
        check(
            "logout revokes the copied credential on the server",
            client.post("/api/auth/logout", headers=valid).status_code == 200
            and client.get("/api/registry/tools", headers=headers).status_code == 401,
        )
        other_headers = {"X-Forge-Session": other["token"]}
        check(
            "revocation does not invalidate another legitimate session",
            client.get("/api/registry/tools", headers=other_headers).status_code == 200,
        )
        other_digest = token_digest(other["token"])
        with sqlite3.connect(data / "auth-test.db") as db:
            db.execute(
                "UPDATE login_session SET expires_at=? WHERE token_digest=?",
                (int(time.time()) - 1, other_digest),
            )
        check(
            "expired preview sessions are rejected",
            not client.get("/api/auth/session", headers=other_headers).json()["data"][
                "authenticated"
            ]
            and client.get("/api/registry/tools", headers=other_headers).status_code
            == 401,
        )
        fresh = create()
        with sqlite3.connect(data / "auth-test.db") as db:
            db.execute(
                "DELETE FROM login_session WHERE token_digest=?",
                (token_digest(fresh["token"]),),
            )
        check(
            "deleting a server-side session invalidates preview credentials",
            client.get(
                "/api/registry/tools", headers={"X-Forge-Session": fresh["token"]}
            ).status_code
            == 401,
        )
        check(
            "no raw preview credential is persisted in database or encryption files",
            all(
                token.encode() not in file.read_bytes()
                and fresh["token"].encode() not in file.read_bytes()
                for file in data.iterdir()
                if file.is_file()
            ),
        )

report = {
    "scope": "isolated auth transport, no model",
    "checks": len(checks),
    "result": "passed",
    "items": checks,
}
destination = ROOT / "data/business-checks/preview-auth-report.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps({key: value for key, value in report.items() if key != "items"}))
