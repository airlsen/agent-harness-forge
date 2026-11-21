"""场景与场景版本模型。

场景 = Bundle（02-技术方案 ADR-2）：版本记录不可变，会话启动时快照 bundle_hash。
space 三级：official（预置只读）/ personal（我的）/ team（部门空间，V1）。
"""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from ..core.database import Base


class AgentScenario(Base):
    __tablename__ = "agent_scenario"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(64), index=True)
    space: Mapped[str] = mapped_column(String(16), default="personal", index=True)
    owner_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(String(512), default="")
    icon: Mapped[str] = mapped_column(String(64), default="ri-robot-line")
    # draft（草稿） / review（上架审批中，V1） / published
    status: Mapped[str] = mapped_column(String(16), default="draft")
    current_version: Mapped[int] = mapped_column(Integer, default=0)
    # 已发布版本单独指向；维护中的新修订不影响使用目录和新会话。
    published_version: Mapped[int] = mapped_column(Integer, default=0)
    # Historical rows have no reliable publication timestamp and remain NULL.
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class AgentScenarioVersion(Base):
    """不可变版本：发布后任何修改都产生新行。"""

    __tablename__ = "agent_scenario_version"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scenario_id: Mapped[int] = mapped_column(Integer, index=True)
    version: Mapped[int] = mapped_column(Integer)
    # Bundle 装配单：profile_patch / skill_files 引用 / mcp / model_route / policy / input_schema
    bundle_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    bundle_hash: Mapped[str] = mapped_column(String(64), index=True)
    change_log: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
