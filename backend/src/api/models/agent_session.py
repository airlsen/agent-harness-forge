"""会话快照、append-only 事件索引；开发环境事件原文先存本地数据库。"""

from datetime import datetime
from sqlalchemy import JSON, BigInteger, DateTime, Float, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column
from ..core.database import Base


class AgentSession(Base):
    __tablename__ = "agent_session"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(64), default="sandbox", index=True)
    user_id: Mapped[str] = mapped_column(String(64), default="admin", index=True)
    title: Mapped[str] = mapped_column(String(160), default="新会话")
    scenario_id: Mapped[int] = mapped_column(Integer, index=True)
    scenario_version: Mapped[int] = mapped_column(Integer, default=1)
    bundle_hash: Mapped[str] = mapped_column(String(64))
    bundle_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    runner_id: Mapped[str] = mapped_column(String(80), default="")
    runner_session_id: Mapped[str] = mapped_column(String(80), default="")
    status: Mapped[str] = mapped_column(String(20), default="idle", index=True)
    workspace_uri: Mapped[str] = mapped_column(String(512), default="")
    tokens_in: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_out: Mapped[int] = mapped_column(BigInteger, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    cost_known: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SessionEventIndex(Base):
    __tablename__ = "session_event_index"
    __table_args__ = (UniqueConstraint("session_id", "seq", name="uq_session_event_seq"),)
    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    session_id: Mapped[int] = mapped_column(Integer, index=True)
    seq: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(24))
    kind: Mapped[str] = mapped_column(String(64))
    payload_uri: Mapped[str] = mapped_column(String(512), default="")
    attrs: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class AgentSessionModel(Base):
    """会话模型分段（append-only）：会话创建时一段，每次会话内切换模型追加一段，最新一段即当前模型。

    每段冻结执行所需的连接参数（密钥仅存加密值）与单价，并累计本段用量，用于按轮计价与追溯。
    """

    __tablename__ = "agent_session_model"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(Integer, index=True)
    # 本段生效的第一条用户消息；None 表示自会话创建起（含旧会话迁移）。
    from_message_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    connection_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    name: Mapped[str] = mapped_column(String(100), default="")
    model: Mapped[str] = mapped_column(String(128))
    base_url: Mapped[str] = mapped_column(String(512))
    context_window: Mapped[int] = mapped_column(Integer, default=64000)
    credential: Mapped[str] = mapped_column(Text, default="")
    input_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    output_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    tokens_in: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_out: Mapped[int] = mapped_column(BigInteger, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
