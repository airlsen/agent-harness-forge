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
    # package 是内部 release key；plugin_id 才是场景引用的稳定标识。
    # 保留 package 以兼容 P0 已落库记录，并让同一插件的多个不可变版本可并存。
    package: Mapped[str] = mapped_column(String(128), index=True)
    plugin_id: Mapped[str] = mapped_column(String(128), default="", index=True)
    version: Mapped[str] = mapped_column(String(32))
    display_name: Mapped[str] = mapped_column(String(128), default="")
    description: Mapped[str] = mapped_column(String(512), default="")
    runtime: Mapped[str] = mapped_column(String(32), default="forge-bridge")
    source_ref: Mapped[str] = mapped_column(String(256), default="")
    artifact_hash: Mapped[str] = mapped_column(String(128), default="")
    artifact_name: Mapped[str] = mapped_column(String(256), default="")
    artifact_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    manifest_json: Mapped[dict] = mapped_column(JSON, default=dict)
    execution_json: Mapped[dict] = mapped_column(JSON, default=dict)
    scan_status: Mapped[str] = mapped_column(String(32), default="builtin")
    review_note: Mapped[str] = mapped_column(String(1024), default="")
    tools_json: Mapped[list] = mapped_column(JSON, default=list)
    extension_points: Mapped[list] = mapped_column(JSON, default=list)  # ctx.llm/tools/*...
    permissions: Mapped[list] = mapped_column(JSON, default=list)  # 权限用途声明
    signature: Mapped[str] = mapped_column(String(128), default="")
    audit_status: Mapped[str] = mapped_column(String(16), default="pending")  # pending/approved/rejected
    enabled: Mapped[bool] = mapped_column(default=False, index=True)
    is_default: Mapped[bool] = mapped_column(default=False, index=True)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_test_error: Mapped[str] = mapped_column(String(512), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class McpServer(Base):
    """管理员接入的远程 MCP 服务；认证头加密保存，不随 API/场景返回。"""

    __tablename__ = "mcp_server"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(96), unique=True, index=True)
    url: Mapped[str] = mapped_column(String(2048))
    transport: Mapped[str] = mapped_column(String(24), default="streamable-http")
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
