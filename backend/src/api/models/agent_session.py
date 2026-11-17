"""会话快照、append-only 事件索引；开发环境事件原文先存本地数据库。"""

from datetime import datetime
from sqlalchemy import JSON, BigInteger, DateTime, Float, Integer, String, UniqueConstraint, func
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
