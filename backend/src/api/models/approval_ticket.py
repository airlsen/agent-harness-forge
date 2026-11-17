"""审批工单：approval-bridge 插件回调建立，UI/IM 决策回写。"""

from datetime import datetime

from sqlalchemy import JSON, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..core.database import Base


class ApprovalTicket(Base):
    __tablename__ = "approval_ticket"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(Integer, index=True)
    tool_call_id: Mapped[str] = mapped_column(String(64), unique=True)
    tool: Mapped[str] = mapped_column(String(64))
    args_digest: Mapped[str] = mapped_column(String(4096), default="")  # 脱敏后参数
    channel: Mapped[str] = mapped_column(String(16), default="ui")  # ui/feishu/dingtalk
    # pending/approved/denied/timeout
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    decided_by: Mapped[str] = mapped_column(String(64), default="")
    decision_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
