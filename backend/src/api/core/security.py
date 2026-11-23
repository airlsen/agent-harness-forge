"""Local account authentication; business-resource authorization is a later milestone."""

import hashlib
import hmac
import json
import secrets
import time

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, Request
from sqlalchemy import select, update

from .config import settings
from .database import SessionFactory
from ..models.user import LoginSession, User
from ..models.skill import SkillAuthoringSession
from ..models.agent_session import AgentSession
from ..models.platform import PlatformSetting

COOKIE = "forge_session"
AUTH_FILE = settings.data_dir / "auth.json"
KEY_FILE = settings.data_dir / "encryption.key"
PREVIEW_HEADER = "X-Forge-Session"
PREVIEW_TTL = 3600
COOKIE_TTL = 86400 * 7


def initialize_security() -> None:
    if not AUTH_FILE.exists():
        raise RuntimeError("请先运行 python scripts/setup-sandbox.py 初始化管理员账号")
    if not KEY_FILE.exists():
        KEY_FILE.write_bytes(Fernet.generate_key())
        KEY_FILE.chmod(0o600)


def _auth() -> dict:
    return json.loads(AUTH_FILE.read_text())


async def seed_admin() -> None:
    """Keep the original admin password and ID on an existing installation."""
    legacy = _auth()
    async with SessionFactory() as db:
        if await db.scalar(select(User.id).limit(1)) is None:
            db.add(
                User(
                    id=legacy["username"],
                    username=legacy["username"].lower(),
                    email=None,
                    display_name="管理员",
                    password_salt=legacy["salt"],
                    password_digest=legacy["digest"],
                    role="admin",
                    status="active",
                )
            )
        if not await db.get(PlatformSetting, "session-owner-migration-v1"):
            # Before account ownership, chat sessions used the configured admin ID and
            # authoring sessions had no owner. Backfill only once: later users may use those names.
            if legacy["username"] != settings.admin_username:
                await db.execute(
                    update(AgentSession)
                    .where(AgentSession.user_id == settings.admin_username)
                    .values(user_id=legacy["username"])
                )
            if legacy["username"] != "admin":
                await db.execute(
                    update(SkillAuthoringSession)
                    .where(SkillAuthoringSession.owner_id == "admin")
                    .values(owner_id=legacy["username"])
                )
            db.add(PlatformSetting(key="session-owner-migration-v1", value={"adminId": legacy["username"]}))
        await db.commit()


def encrypt(value: str) -> str:
    return Fernet(KEY_FILE.read_bytes()).encrypt(value.encode()).decode() if value else ""


def decrypt(value: str) -> str:
    return Fernet(KEY_FILE.read_bytes()).decrypt(value.encode()).decode() if value else ""


def reveal_secret(value: str) -> str:
    try:
        return decrypt(value)
    except InvalidToken:
        raise HTTPException(409, "已保存的密钥无法读取，请重新填写") from None


def password_hash(password: str, salt: str) -> str:
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()


def new_password(password: str) -> tuple[str, str]:
    salt = secrets.token_hex(16)
    return salt, password_hash(password, salt)


async def password_user(username: str, password: str) -> User | None:
    async with SessionFactory() as db:
        user = await db.scalar(select(User).where(User.username == username.strip().lower()))
    salt = user.password_salt if user else "00" * 16
    digest = password_hash(password, salt)
    if user and user.status == "active" and hmac.compare_digest(digest, user.password_digest):
        return user
    return None


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create_login_session(user: User, transport: str) -> tuple[str, int]:
    token = ("fp1_" if transport == "preview-header" else "fs1_") + secrets.token_urlsafe(32)
    expiry = int(time.time()) + (PREVIEW_TTL if transport == "preview-header" else COOKIE_TTL)
    async with SessionFactory() as db:
        db.add(
            LoginSession(
                token_digest=token_digest(token),
                user_id=user.id,
                transport=transport,
                expires_at=expiry,
            )
        )
        await db.commit()
    return token, expiry


def auth_credential(request: Request) -> str:
    if request.headers.get(PREVIEW_HEADER):
        return request.headers[PREVIEW_HEADER] if settings.preview_header_auth else ""
    return request.cookies.get(COOKIE, "")


async def current_user(request: Request) -> User | None:
    token = auth_credential(request)
    transport = "preview-header" if request.headers.get(PREVIEW_HEADER) else "cookie"
    if not token.startswith("fp1_" if transport == "preview-header" else "fs1_") or len(token) != 47:
        return None
    async with SessionFactory() as db:
        session = await db.get(LoginSession, token_digest(token))
        if not session or session.transport != transport or session.expires_at <= time.time():
            return None
        user = await db.get(User, session.user_id)
        return user if user and user.status == "active" else None


async def revoke_session(request: Request) -> None:
    token = auth_credential(request)
    if token:
        async with SessionFactory() as db:
            session = await db.get(LoginSession, token_digest(token))
            if session:
                await db.delete(session)
                await db.commit()


def csrf_token(request: Request) -> str:
    return hmac.new(
        bytes.fromhex(_auth()["signing_key"]),
        ("csrf:" + auth_credential(request)).encode(),
        hashlib.sha256,
    ).hexdigest()


async def require_auth(request: Request) -> None:
    user = await current_user(request)
    if not user:
        raise HTTPException(401, "请登录工作空间")
    if request.method not in ("GET", "HEAD", "OPTIONS") and not hmac.compare_digest(
        request.headers.get("X-Forge-CSRF", ""), csrf_token(request)
    ):
        raise HTTPException(403, "请求校验失败，请刷新页面重试")
    request.state.user = user
