"""Skill catalog, immutable revisions, DSH authoring sessions and durable messages."""

from datetime import datetime
from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint, func
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
    # 编辑对话使用的模型配置（与工作台一致可在对话中切换）；NULL 表示跟随平台默认模型
    model_connection_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
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


class SkillAuthoringFile(Base):
    """试用文件：Skill 编辑对话的会话工作区文件（试用产出、脚本输出），同步到服务端存储。

    与 Skill 目录（SKILL.md 与附加文件）分开：不进入修订、不随发布；内容按 SHA-256 存在会话文件存储中。
    runner_session_id 记录文件来自哪个执行会话：执行会话重建后旧工作区的文件仍保留，不会被新的空清单删掉。
    """

    __tablename__ = "skill_authoring_file"
    __table_args__ = (UniqueConstraint("authoring_session_id", "path", name="uq_skill_authoring_file_path"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    authoring_session_id: Mapped[int] = mapped_column(
        ForeignKey("skill_authoring_session.id", ondelete="CASCADE"), index=True
    )
    runner_session_id: Mapped[str] = mapped_column(String(80), default="")
    path: Mapped[str] = mapped_column(String(256))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    mime: Mapped[str] = mapped_column(String(128), default="application/octet-stream")
    modified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
