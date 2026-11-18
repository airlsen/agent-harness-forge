"""Skill catalog, immutable revisions, DSH authoring sessions and durable messages."""

from datetime import datetime
from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column
from ..core.database import Base


class Skill(Base):
    __tablename__ = "skill"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), index=True)
    description: Mapped[str] = mapped_column(String(512), default="")
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    current_revision_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    published_revision_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    next_published_version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class SkillRevision(Base):
    __tablename__ = "skill_revision"
    __table_args__ = (
        UniqueConstraint("skill_id", "revision", name="uq_skill_revision_number"),
        UniqueConstraint("skill_id", "published_version", name="uq_skill_published_version"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[int] = mapped_column(ForeignKey("skill.id", ondelete="CASCADE"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    published_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    change_summary: Mapped[str] = mapped_column(String(500), default="")
    source: Mapped[str] = mapped_column(String(24), default="manual")  # manual/agent/restore/publish
    reference_files: Mapped[list] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(80), default="admin")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class SkillAuthoringSession(Base):
    __tablename__ = "skill_authoring_session"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    skill_id: Mapped[int] = mapped_column(ForeignKey("skill.id", ondelete="CASCADE"), index=True)
    runner_session_id: Mapped[str] = mapped_column(String(80), default="", index=True)
    status: Mapped[str] = mapped_column(String(20), default="idle")  # idle/running/interrupted
    current_revision_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_message_seq: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class SkillAuthoringMessage(Base):
    __tablename__ = "skill_authoring_message"
    __table_args__ = (UniqueConstraint("authoring_session_id", "seq", name="uq_skill_authoring_message_seq"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    authoring_session_id: Mapped[int] = mapped_column(
        ForeignKey("skill_authoring_session.id", ondelete="CASCADE"), index=True
    )
    seq: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(20))  # user/assistant/tool/system
    content: Mapped[str] = mapped_column(Text)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
