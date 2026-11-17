"""业务配置与持久化消息。密钥只保存加密值，API 永不回传。"""

from datetime import datetime
from sqlalchemy import JSON, DateTime, Float, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column
from ..core.database import Base


class PlatformSetting(Base):
    __tablename__ = "platform_setting"
    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, default=dict)


class ModelConnection(Base):
    __tablename__ = "model_connection"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), default="默认模型连接")
    base_url: Mapped[str] = mapped_column(String(512))
    model: Mapped[str] = mapped_column(String(128))
    credential: Mapped[str] = mapped_column(Text, default="")
    context_window: Mapped[int] = mapped_column(Integer, default=64000)
    input_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    output_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_test: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class SessionMessage(Base):
    __tablename__ = "session_message"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(Integer, index=True)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
