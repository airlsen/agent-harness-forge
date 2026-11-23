"""Self-registration and local login. Resources are still shared until authorization is added."""

import asyncio
import secrets
import smtplib
import ssl
import time
from collections import defaultdict
from email.message import EmailMessage
from typing import Literal
from urllib.parse import quote
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from ..core.config import settings
from ..core.database import SessionFactory
from ..core.security import (
    COOKIE,
    PREVIEW_HEADER,
    create_login_session,
    csrf_token,
    current_user,
    new_password,
    password_user,
    revoke_session,
    token_digest,
)
from ..models.user import EmailVerification, User
from ..utils.response import ResponseUtil

router = APIRouter()
attempts: dict[str, list[float]] = defaultdict(list)


def limit_attempts(key: str, maximum: int) -> None:
    now = time.monotonic()
    recent = [stamp for stamp in attempts[key] if now - stamp < 60]
    if len(recent) >= maximum:
        raise HTTPException(429, "操作过于频繁，请一分钟后再试")
    attempts[key] = [*recent, now]


def login_limit(key: str, maximum: int) -> None:
    now = time.monotonic()
    attempts[key] = [stamp for stamp in attempts[key] if now - stamp < 60]
    if len(attempts[key]) >= maximum:
        raise HTTPException(429, "登录尝试过多，请一分钟后再试")


class Login(BaseModel):
    username: str = Field(max_length=80)
    password: str = Field(max_length=500)
    transport: Literal["cookie", "preview-header"] = "cookie"


class Register(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[A-Za-z][A-Za-z0-9_.-]*$")
    email: str = Field(min_length=5, max_length=254, pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
    password: str = Field(min_length=12, max_length=128)
    display_name: str = Field(default="", max_length=80)


class VerifyEmail(BaseModel):
    token: str = Field(min_length=32, max_length=128)


def registration_available() -> bool:
    return settings.registration_enabled and (
        not settings.registration_require_email_verification
        or bool(settings.smtp_host and settings.smtp_from and settings.public_base_url)
    )


def send_verification(email: str, token: str) -> None:
    message = EmailMessage()
    message["Subject"] = "验证 Forge 账号邮箱"
    message["From"] = settings.smtp_from
    message["To"] = email
    message.set_content(
        "请在 24 小时内打开以下链接完成邮箱验证：\n"
        f"{settings.public_base_url.rstrip('/')}/?verify={quote(token)}\n"
        "如果这不是你的操作，请忽略此邮件。"
    )
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        if settings.smtp_username:
            smtp.login(settings.smtp_username, settings.smtp_password)
        smtp.send_message(message)


@router.get("/session")
async def session(request: Request):
    user = await current_user(request)
    return ResponseUtil.ok(
        {
            "authenticated": user is not None,
            "user": {
                "id": user.id,
                "name": user.display_name,
                "username": user.username,
                "role": user.role,
                "workspace": "Forge Workspace",
            }
            if user
            else None,
            "csrfToken": csrf_token(request) if user else None,
            "authMode": "local-accounts",
            "registrationAvailable": registration_available(),
            "registrationRequiresEmailVerification": settings.registration_require_email_verification,
            "previewHeaderAuth": settings.preview_header_auth,
            "transport": ("preview-header" if request.headers.get(PREVIEW_HEADER) else "cookie")
            if user
            else None,
        }
    )


@router.post("/register", status_code=201)
async def register(payload: Register, request: Request):
    if not registration_available():
        raise HTTPException(403, "当前未开放自助注册，请联系管理员")
    limit_attempts(f"register:{request.client.host if request.client else 'local'}", 5)
    username = payload.username.strip().lower()
    email = payload.email.strip().lower()
    domains = {
        domain.strip().lower() for domain in settings.registration_email_domains.split(",") if domain.strip()
    }
    if domains and email.rsplit("@", 1)[-1] not in domains:
        raise HTTPException(422, "请使用允许的企业邮箱注册")
    salt, digest = new_password(payload.password)
    user = User(
        id=uuid4().hex,
        username=username,
        email=email,
        display_name=payload.display_name.strip() or username,
        password_salt=salt,
        password_digest=digest,
        role="member",
        status="pending" if settings.registration_require_email_verification else "active",
    )
    async with SessionFactory() as db:
        db.add(user)
        try:
            if settings.registration_require_email_verification:
                token = secrets.token_urlsafe(32)
                db.add(
                    EmailVerification(
                        token_digest=token_digest(token),
                        user_id=user.id,
                        expires_at=int(time.time()) + 86400,
                    )
                )
                await asyncio.to_thread(send_verification, email, token)
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(409, "账号或邮箱已被使用") from None
        except (OSError, smtplib.SMTPException):
            await db.rollback()
            raise HTTPException(503, "验证邮件发送失败，请稍后重试") from None
    return ResponseUtil.ok({"verificationRequired": settings.registration_require_email_verification})


@router.post("/verify-email")
async def verify_email(payload: VerifyEmail):
    async with SessionFactory() as db:
        token = await db.get(EmailVerification, token_digest(payload.token))
        if not token or token.expires_at <= time.time():
            raise HTTPException(400, "验证链接已失效")
        user = await db.get(User, token.user_id)
        if not user or user.status != "pending":
            raise HTTPException(400, "验证链接已失效")
        user.status = "active"
        await db.delete(token)
        await db.commit()
    return ResponseUtil.ok({"ok": True})


@router.post("/login")
async def login(payload: Login, request: Request, response: Response):
    host = request.client.host if request.client else "local"
    key = f"login:{host}"
    login_limit(key, 12)
    user = await password_user(payload.username, payload.password)
    if not user:
        attempts[key].append(time.monotonic())
        raise HTTPException(401, "账号或密码不正确")
    attempts.pop(key, None)
    if payload.transport == "preview-header" and not settings.preview_header_auth:
        raise HTTPException(403, "当前部署未开启预览兼容会话，请允许 Cookie 或从新标签页登录")
    token, expiry = await create_login_session(user, payload.transport)
    if payload.transport == "preview-header":
        return ResponseUtil.ok({"ok": True, "previewSession": {"token": token, "expiresAt": expiry}})
    write_cookie(response, request, token)
    return ResponseUtil.ok({"ok": True})


@router.post("/logout")
async def logout(response: Response, request: Request):
    await revoke_session(request)
    write_cookie(response, request, "", clear=True)
    return ResponseUtil.ok()


def write_cookie(response: Response, request: Request, value: str, *, clear=False):
    secure = (
        settings.cookie_secure
        or request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto") == "https"
    )
    response.set_cookie(
        COOKIE,
        value,
        httponly=True,
        secure=secure,
        samesite=settings.cookie_samesite,
        max_age=0 if clear else 86400 * 7,
        path="/",
        **({"expires": 0} if clear else {}),
    )
    if settings.cookie_partitioned:
        response.headers["set-cookie"] += "; Partitioned"
