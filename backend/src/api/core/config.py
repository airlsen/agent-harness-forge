"""应用配置。开发环境默认 SQLite；生产可改为 PostgreSQL URL。"""

from pathlib import Path
from typing import Literal
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FORGE_", env_file=".env", extra="ignore")
    database_url: str = f"sqlite+aiosqlite:///{ROOT / 'data' / 'forge.db'}"
    data_dir: Path = ROOT / "data"
    runner_endpoints: str = "http://127.0.0.1:9000"
    runner_token: str = ""
    admin_username: str = "admin"
    cookie_secure: bool = False
    cookie_samesite: Literal["strict", "lax", "none"] = "strict"
    cookie_partitioned: bool = False
    preview_header_auth: bool = False
    serve_frontend: bool = True
    frontend_dist: Path = ROOT / "frontend" / "dist"
    session_idle_ttl_seconds: int = 1800
    approval_timeout_seconds: int = 120
    max_message_chars: int = 64000
    cors_origins: list[str] = []
    # 保留生产部署扩展配置；本次不假装 Redis/S3/OIDC 已接入。
    redis_url: str = "redis://127.0.0.1:6379/0"
    s3_endpoint: str = ""
    s3_bucket: str = "forge-artifacts"
    s3_access_key: str = ""
    s3_secret_key: str = ""
    callback_base_url: str = "http://127.0.0.1:8000"
    model_gateway_url: str = ""
    event_raw_retention_days: int = 180

    @property
    def runner_endpoint_list(self) -> list[str]:
        return [e.strip() for e in self.runner_endpoints.split(",") if e.strip()]


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
settings.data_dir.chmod(0o700)
