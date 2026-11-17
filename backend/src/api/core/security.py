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
    token = request.cookies.get(COOKIE, "")
    try:
        expiry, nonce, signature = token.split(".")
        return int(expiry) > time.time() and hmac.compare_digest(signature, _signature(expiry + "." + nonce))
    except (ValueError, TypeError, FileNotFoundError):
        return False


def csrf_token(request: Request) -> str:
    return _signature("csrf:" + request.cookies.get(COOKIE, ""))


def require_auth(request: Request) -> None:
    if not authenticated(request):
        raise HTTPException(401, "请登录工作空间")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if not hmac.compare_digest(
            request.headers.get("X-Forge-CSRF", "").encode(), csrf_token(request).encode()
        ):
            raise HTTPException(403, "请求校验失败，请刷新页面重试")
