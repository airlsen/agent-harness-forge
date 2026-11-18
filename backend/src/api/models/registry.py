"""能力注册表 + 模型目录与路由策略 + 配额账簿。

白名单制：Runner 镜像内置的插件必须在本表登记（签名 + 版本 pin + 审核状态）。
"""

from datetime import datetime

from sqlalchemy import JSON, BigInteger, DateTime, Float, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from ..core.database import Base


class PluginRegistry(Base):
    __tablename__ = "plugin_registry"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    package: Mapped[str] = mapped_column(String(128), index=True)  # npm 包名
    version: Mapped[str] = mapped_column(String(32))
    extension_points: Mapped[list] = mapped_column(JSON, default=list)  # ctx.llm/tools/*...
    permissions: Mapped[list] = mapped_column(JSON, default=list)  # 权限用途声明
    signature: Mapped[str] = mapped_column(String(128), default="")
    audit_status: Mapped[str] = mapped_column(String(16), default="pending")  # pending/approved/rejected
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class McpServer(Base):
    """管理员接入的远程 MCP 服务；认证头加密保存，不随 API/场景返回。"""

    __tablename__ = "mcp_server"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(96), unique=True, index=True)
    url: Mapped[str] = mapped_column(String(2048))
    headers_encrypted: Mapped[str] = mapped_column(Text, default="")
    enabled: Mapped[bool] = mapped_column(default=False, index=True)
    tools_json: Mapped[list] = mapped_column(JSON, default=list)
    server_info: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24), default="unverified", index=True)
    last_error: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class ModelRegistry(Base):
    __tablename__ = "model_registry"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)  # deepseek-v4-pro / v3.2-thinking ...
    provider: Mapped[str] = mapped_column(String(32))  # deepseek-api / private-vllm / external
    endpoint_ref: Mapped[str] = mapped_column(String(256))  # 密钥引用，不内联
    modes: Mapped[list] = mapped_column(JSON, default=list)  # ["thinking","non-thinking"]
    price_in: Mapped[float] = mapped_column(Float, default=0.0)  # 元/百万 token
    price_out: Mapped[float] = mapped_column(Float, default=0.0)
    price_cache_hit: Mapped[float] = mapped_column(Float, default=0.0)
    enabled: Mapped[bool] = mapped_column(default=True)


class ModelRoutePolicy(Base):
    __tablename__ = "model_route_policy"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    rules_json: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class UsageRecord(Base):
    """计量账：Runner 事件流与模型网关双侧对账后的权威记录。"""

    __tablename__ = "usage_record"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(Integer, index=True)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    model: Mapped[str] = mapped_column(String(64))
    tokens_in: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_out: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_cache_hit: Mapped[int] = mapped_column(BigInteger, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
