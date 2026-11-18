"""会话工作区文件的服务端持久化：当前文件清单与逐轮改动记录。

文件内容按 SHA-256 存放在服务端磁盘（见 services/file_store.py），表内只记元数据；
同一内容只存一份，改动记录引用改动前后的内容哈希，用于查看对比。
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from ..core.database import Base


class SessionFile(Base):
    """会话工作区当前文件（每轮结束与执行中写入时同步）。"""

    __tablename__ = "session_file"
    __table_args__ = (UniqueConstraint("session_id", "path", name="uq_session_file_path"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(Integer, index=True)
    path: Mapped[str] = mapped_column(String(256))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    mime: Mapped[str] = mapped_column(String(128), default="application/octet-stream")
    modified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class SessionFileChange(Base):
    """一次文件改动：智能体在某一轮中的新增/修改/删除，或用户在界面上的删除。"""

    __tablename__ = "session_file_change"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(Integer, index=True)
    # 本轮的用户消息 ID；用户手动删除时为空
    message_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    actor: Mapped[str] = mapped_column(String(16), default="agent")
    path: Mapped[str] = mapped_column(String(256))
    action: Mapped[str] = mapped_column(String(16))
    before_sha: Mapped[str] = mapped_column(String(64), default="", index=True)
    after_sha: Mapped[str] = mapped_column(String(64), default="", index=True)
    before_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    after_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    lines_added: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lines_removed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
