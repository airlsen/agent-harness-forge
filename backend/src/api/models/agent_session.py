"""会话与事件索引模型。

Runner 亲和路由 + Bundle 快照锚点 + 计量汇总；
事件原文在 S3（WORM），本表仅存索引（02-技术方案 §六）。
"""

from datetime import datetime

from sqlalchemy import JSON, BigInteger, DateTime, Float, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..core.database import Base


class AgentSession(Base):
    __tablename__ = "agent_session"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    scenario_id: Mapped[int] = mapped_column(Integer, index=True)
    scenario_version: Mapped[int] = mapped_column(Integer, default=0)
    bundle_hash: Mapped[str] = mapped_column(String(64))
    runner_id: Mapped[str] = mapped_column(String(64), default="")
    # creating/hydrating/active/idle/archived/finished/aborted
    status: Mapped[str] = mapped_column(String(16), default="creating", index=True)
    workspace_uri: Mapped[str] = mapped_column(String(512), default="")
    tokens_in: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_out: Mapped[int] = mapped_column(BigInteger, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SessionEventIndex(Base):
    """append-only 事件索引；payload_uri 指向 S3 原文。"""

    __tablename__ = "session_event_index"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(Integer, index=True)
    seq: Mapped[int] = mapped_column(Integer)  # 会话内单调递增，SSE 断线重连锚点
    source: Mapped[str] = mapped_column(String(24))  # system/llm/tools/agent/ui
    kind: Mapped[str] = mapped_column(String(48))
    payload_uri: Mapped[str] = mapped_column(String(512), default="")
    attrs: Mapped[dict] = mapped_column(JSON, default=dict)  # 脱敏后的检索摘要
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
