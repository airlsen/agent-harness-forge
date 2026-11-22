"""空间：把场景、Skill、MCP、插件、会话按部门/项目分开存放。

公共空间（id=1）内置，不能删除或改名；它的内容在每个空间都能看到和使用。
其他空间只能看到自己的内容和公共空间的内容。空间不设权限，任何人都能进入任何空间。
"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..core.database import Base

# 公共空间固定为 1：旧数据与未指定空间的新数据（server_default）都归公共空间。
PUBLIC_SPACE_ID = 1


class Space(Base):
    __tablename__ = "space"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    # 颜色键（orange/blue/green/purple/red/cyan/yellow/pink；公共空间为 gray）
    color: Mapped[str] = mapped_column(String(16), default="blue")
    description: Mapped[str] = mapped_column(String(200), default="")
    is_public: Mapped[bool] = mapped_column(Boolean, default=False)
    # 本空间关闭的基础工具（默认全部开启）。生效 = 执行策略允许 且 本空间未关闭。
    disabled_tools: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


def space_column():
    """各资源表的 space_id 列：默认公共空间。"""
    return mapped_column(Integer, default=PUBLIC_SPACE_ID, server_default=str(PUBLIC_SPACE_ID), index=True)
