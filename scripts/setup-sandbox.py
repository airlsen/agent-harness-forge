"""初始化本地管理员和内部 Runner Token。不打印/提交凭据，重复运行不覆盖。"""

import hashlib
import json
from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True, mode=0o700)
DATA.chmod(0o700)
auth_path = DATA / "auth.json"
if not auth_path.exists():
    password = secrets.token_urlsafe(12)
    salt = secrets.token_hex(16)
    auth = {
        "username": "admin",
        "salt": salt,
        "digest": hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1
        ).hex(),
        "signing_key": secrets.token_hex(32),
    }
    auth_path.write_text(json.dumps(auth))
    auth_path.chmod(0o600)
    login = DATA / "admin-login.txt"
    login.write_text(f"username=admin\npassword={password}\n")
    login.chmod(0o600)
env = DATA / "business.env"
if not env.exists():
    env.write_text(
        "FORGE_RUNNER_TOKEN="
        + secrets.token_urlsafe(40)
        + "\nFORGE_RUNNER_ENDPOINTS=http://127.0.0.1:9000\nRUNNER_MAX_SESSIONS=4\n"
        # 会话「关联代码」的根目录（Runner 读取，一级子目录即可选项目，只读）
        + "FORGE_CODE_ROOT=/usr/data/git\n"
    )
    env.chmod(0o600)
print(
    "Workspace initialized. Credentials: data/admin-login.txt (0600), environment: data/business.env (0600)."
)
