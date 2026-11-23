#!/usr/bin/env python3
"""Isolated account registration, verification and login checks without a model."""

import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

with tempfile.TemporaryDirectory(prefix="forge-user-auth-") as directory:
    data = Path(directory)
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
            "FORGE_DATA_DIR": directory,
            "FORGE_DATABASE_URL": f"sqlite+aiosqlite:///{data / 'accounts.db'}",
            "FORGE_RUNNER_TOKEN": secrets.token_urlsafe(40),
            "FORGE_REGISTRATION_ENABLED": "true",
            "FORGE_REGISTRATION_REQUIRE_EMAIL_VERIFICATION": "false",
        }
    )
    from fastapi.testclient import TestClient
    from src.api.main import app
    from src.api.core.config import settings
    from src.api.routes import auth

    with TestClient(app) as client:
        assert (
            client.post(
                "/api/auth/login", json={"username": "admin", "password": password}
            ).status_code
            == 200
        )
        original_cookie = client.cookies.get("forge_session")
        assert original_cookie
        legacy_user = client.get("/api/auth/session").json()["data"]["user"]
        assert legacy_user["id"] == "admin" and legacy_user["role"] == "admin"
        assert client.get("/api/registry/tools").status_code == 200
        csrf = client.get("/api/auth/session").json()["data"]["csrfToken"]
        assert (
            client.post("/api/auth/logout", headers={"X-Forge-CSRF": csrf}).status_code
            == 200
        )
        assert (
            client.get(
                "/api/registry/tools", cookies={"forge_session": original_cookie}
            ).status_code
            == 401
        )

        payload = {
            "username": "Alice",
            "email": "ALICE@example.org",
            "password": "long-test-password",
            "display_name": "Alice",
        }
        assert client.post("/api/auth/register", json=payload).status_code == 201
        assert client.post("/api/auth/register", json=payload).status_code == 409
        assert (
            client.post(
                "/api/auth/login",
                json={"username": "alice", "password": payload["password"]},
            ).status_code
            == 200
        )
        identity = client.get("/api/auth/session").json()["data"]["user"]
        assert (
            identity["username"] == "alice"
            and identity["role"] == "member"
            and identity["id"] != "admin"
        )
        assert client.get("/api/registry/tools").status_code == 200
        assert client.post("/api/auth/logout").status_code == 403
        assert client.get("/api/registry/tools").status_code == 200
        csrf = client.get("/api/auth/session").json()["data"]["csrfToken"]
        assert (
            client.post("/api/auth/logout", headers={"X-Forge-CSRF": csrf}).status_code
            == 200
        )
        with sqlite3.connect(data / "accounts.db") as db:
            assert (
                db.execute(
                    "SELECT password_digest FROM app_user WHERE username='alice'"
                ).fetchone()[0]
                != payload["password"]
            )

        settings.registration_require_email_verification = True
        settings.smtp_host = "mail.example.org"
        settings.smtp_from = "no-reply@example.org"
        settings.public_base_url = "https://forge.example.org"
        sent = []
        auth.send_verification = lambda address, token: sent.append((address, token))
        bob = {
            "username": "bob",
            "email": "bob@example.org",
            "password": "another-long-password",
        }
        assert client.post("/api/auth/register", json=bob).status_code == 201
        assert sent[0][0] == bob["email"]
        assert (
            client.post(
                "/api/auth/login", json={"username": "bob", "password": bob["password"]}
            ).status_code
            == 401
        )
        assert (
            client.post(
                "/api/auth/verify-email", json={"token": sent[0][1]}
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/auth/verify-email", json={"token": sent[0][1]}
            ).status_code
            == 400
        )
        assert (
            client.post(
                "/api/auth/login", json={"username": "bob", "password": bob["password"]}
            ).status_code
            == 200
        )
        settings.registration_enabled = False
        assert (
            client.post(
                "/api/auth/register",
                json={
                    "username": "eve",
                    "email": "eve@example.org",
                    "password": "another-long-password",
                },
            ).status_code
            == 403
        )

print(
    "PASS admin migration, registration, duplicate prevention, login, CSRF, revoke, email verification"
)
