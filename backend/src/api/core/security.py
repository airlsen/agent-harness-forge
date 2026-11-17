"""单工作空间账号认证。生产 OIDC/RBAC 尚未接入，不伪称多租户安全。"""

import hashlib
import hmac
import json
import secrets
import time
from cryptography.fernet import Fernet
from fastapi import Request, HTTPException
from .config import settings

COOKIE = "forge_session"
AUTH_FILE = settings.data_dir / "auth.json"
KEY_FILE = settings.data_dir / "encryption.key"
PREVIEW_HEADER = "X-Forge-Session"
PREVIEW_TTL = 3600
# 仅显式开启的沙箱预览使用：服务端只存令牌摘要。过期/退出/进程重启均失效。
_preview_sessions: dict[str, int] = {}


def make_preview_session() -> dict:
    now = int(time.time())
    for digest, expiry in list(_preview_sessions.items()):
        if expiry <= now:
            _preview_sessions.pop(digest, None)
    if len(_preview_sessions) >= 100:
        raise HTTPException(429, "预览会话过多，请退出不再使用的标签页后重试")
    token = "fp1_" + secrets.token_urlsafe(32)
    expiry = now + PREVIEW_TTL
    _preview_sessions[hashlib.sha256(token.encode()).hexdigest()] = expiry
    return {"token": token, "expiresAt": expiry}


def revoke_preview_session(request: Request) -> None:
    token = request.headers.get(PREVIEW_HEADER, "")
    _preview_sessions.pop(hashlib.sha256(token.encode()).hexdigest(), None)


def auth_credential(request: Request) -> str:
    if request.headers.get(PREVIEW_HEADER):
        return request.headers[PREVIEW_HEADER] if settings.preview_header_auth else ""
    return request.cookies.get(COOKIE, "")


def initialize_security() -> None:
    if not AUTH_FILE.exists():
        raise RuntimeError("请先运行 python scripts/setup-sandbox.py 初始化管理员账号")
    if not KEY_FILE.exists():
        KEY_FILE.write_bytes(Fernet.generate_key())
        KEY_FILE.chmod(0o600)


def _auth() -> dict:
    return json.loads(AUTH_FILE.read_text())


def encrypt(value: str) -> str:
    return Fernet(KEY_FILE.read_bytes()).encrypt(value.encode()).decode() if value else ""


def decrypt(value: str) -> str:
    return Fernet(KEY_FILE.read_bytes()).decrypt(value.encode()).decode() if value else ""


def password_valid(username: str, password: str) -> bool:
    auth = _auth()
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(auth["salt"]), n=16384, r=8, p=1).hex()
    return hmac.compare_digest(username.encode(), auth["username"].encode()) and hmac.compare_digest(
        digest, auth["digest"]
    )


def _signature(value: str) -> str:
    return hmac.new(bytes.fromhex(_auth()["signing_key"]), value.encode(), hashlib.sha256).hexdigest()


def make_cookie() -> str:
    value = f"{int(time.time()) + 86400 * 7}.{secrets.token_hex(24)}"
    return value + "." + _signature(value)


def authenticated(request: Request) -> bool:
    token = auth_credential(request)
    if request.headers.get(PREVIEW_HEADER):
        if not settings.preview_header_auth or not token.startswith("fp1_") or len(token) != 47:
            return False
        return _preview_sessions.get(hashlib.sha256(token.encode()).hexdigest(), 0) > time.time()
    try:
        expiry, nonce, signature = token.split(".")
        return int(expiry) > time.time() and hmac.compare_digest(signature, _signature(expiry + "." + nonce))
    except (ValueError, TypeError, FileNotFoundError):
        return False


def csrf_token(request: Request) -> str:
    return _signature("csrf:" + auth_credential(request))


def require_auth(request: Request) -> None:
    if not authenticated(request):
        raise HTTPException(401, "请登录工作空间")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if not hmac.compare_digest(
            request.headers.get("X-Forge-CSRF", "").encode(), csrf_token(request).encode()
        ):
            raise HTTPException(403, "请求校验失败，请刷新页面重试")
