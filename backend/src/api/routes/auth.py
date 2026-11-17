import time
from collections import defaultdict
from typing import Literal
from fastapi import APIRouter, Request, HTTPException, Response
from pydantic import BaseModel, Field
from ..core.security import (
    COOKIE,
    PREVIEW_HEADER,
    authenticated,
    csrf_token,
    make_cookie,
    password_valid,
    make_preview_session,
    revoke_preview_session,
)
from ..core.config import settings
from ..utils.response import ResponseUtil

router = APIRouter()
attempts: dict[str, list[float]] = defaultdict(list)


class Login(BaseModel):
    username: str = Field(max_length=80)
    password: str = Field(max_length=500)
    transport: Literal["cookie", "preview-header"] = "cookie"


@router.get("/session")
async def session(request: Request):
    valid = authenticated(request)
    return ResponseUtil.ok(
        {
            "authenticated": valid,
            "user": {"name": "开发者", "username": settings.admin_username, "workspace": "Forge Workspace"}
            if valid
            else None,
            "csrfToken": csrf_token(request) if valid else None,
            "authMode": "local-workspace",
            "previewHeaderAuth": settings.preview_header_auth,
            "transport": ("preview-header" if request.headers.get(PREVIEW_HEADER) else "cookie")
            if valid
            else None,
        }
    )


@router.post("/login")
async def login(payload: Login, request: Request, response: Response):
    host = request.client.host if request.client else "local"
    recent = [t for t in attempts[host] if time.monotonic() - t < 60]
    attempts[host] = recent
    if len(recent) >= 12:
        raise HTTPException(429, "登录尝试过多，请一分钟后再试")
    if not password_valid(payload.username, payload.password):
        recent.append(time.monotonic())
        raise HTTPException(401, "账号或密码不正确")
    attempts.pop(host, None)
    if payload.transport == "preview-header":
        if not settings.preview_header_auth:
            raise HTTPException(403, "当前部署未开启预览兼容会话，请允许 Cookie 或从新标签页登录")
        return ResponseUtil.ok({"ok": True, "previewSession": make_preview_session()})
    write_cookie(response, request, make_cookie())
    return ResponseUtil.ok({"ok": True})


@router.post("/logout")
async def logout(response: Response, request: Request):
    revoke_preview_session(request)
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
    # HTTPS iframe 预览使用分区 cookie；CSRF 仍必须逐次校验。Python 3.12/3.13
    # 尚无标准库 partitioned 参数，显式附加标准属性而不是放宽前端存储权限。
    if settings.cookie_partitioned:
        response.headers["set-cookie"] += "; Partitioned"
