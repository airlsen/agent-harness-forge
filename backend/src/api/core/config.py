"""配置管理：pydantic-settings，全部经环境变量注入（密钥不进代码库）。"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FORGE_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://forge:forge@127.0.0.1:5432/forge"
    redis_url: str = "redis://127.0.0.1:6379/0"

    s3_endpoint: str = "http://127.0.0.1:9000"
    s3_bucket: str = "forge-artifacts"
    s3_access_key: str = ""
    s3_secret_key: str = ""

    runner_endpoints: str = "http://127.0.0.1:9000"
    callback_base_url: str = "http://127.0.0.1:8000"
    model_gateway_url: str = "http://127.0.0.1:4000"

    session_idle_ttl_seconds: int = 1800
    approval_timeout_seconds: int = 600
    event_raw_retention_days: int = 180

    cors_origins: list[str] = ["http://localhost:5173"]

    @property
    def runner_endpoint_list(self) -> list[str]:
        return [e.strip() for e in self.runner_endpoints.split(",") if e.strip()]


settings = Settings()
