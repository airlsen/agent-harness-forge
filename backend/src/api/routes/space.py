"""空间：增删改查、删除时转移内容、基础工具开关、把内容移动到别的空间。"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..models.agent_session import AgentSession
from ..services import space_service
from ..services.space_service import SpaceInput
from ..utils.response import ResponseUtil

router = APIRouter()


class ToolSwitch(BaseModel):
    enabled: bool


class MoveRequest(BaseModel):
    kind: str = Field(pattern="^(scenario|skill|mcp|plugin)$")
    # 场景 / Skill / MCP 为数字编号，插件为 plugin_id
    id: str = Field(min_length=1, max_length=128)
    targetSpaceId: int = Field(gt=0)


@router.get("")
async def list_spaces(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok({"items": await space_service.list_spaces(db)})


@router.post("")
async def create_space(payload: SpaceInput, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await space_service.create_space(db, payload))


@router.post("/move/check")
async def move_check(payload: MoveRequest, db: AsyncSession = Depends(get_session)):
    """移动前检查：blockers（会受影响的场景或缺少的依赖）与 conflicts（Skill 重名）都为空才能移动。"""
    return ResponseUtil.ok(
        await space_service.move_check(db, payload.kind, payload.id, payload.targetSpaceId)
    )


@router.post("/move")
async def move(payload: MoveRequest, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(
        await space_service.move_resource(db, payload.kind, payload.id, payload.targetSpaceId)
    )


@router.get("/{space_id}")
async def get_space(space_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await space_service.get_space(db, space_id))


@router.put("/{space_id}")
async def update_space(space_id: int, payload: SpaceInput, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await space_service.update_space(db, space_id, payload))


@router.get("/{space_id}/delete-check")
async def delete_check(
    space_id: int, target: int | None = Query(default=None, gt=0), db: AsyncSession = Depends(get_session)
):
    return ResponseUtil.ok(await space_service.delete_check(db, space_id, target))


@router.delete("/{space_id}")
async def delete_space(
    space_id: int,
    request: Request,
    target: int | None = Query(default=None, gt=0),
    db: AsyncSession = Depends(get_session),
):
    """删除空间：有内容时全部转移到 target（默认公共空间）；不提供连内容一起删除。"""
    if request.state.user.role != "admin" and await db.scalar(
        select(AgentSession.id)
        .where(AgentSession.space_id == space_id, AgentSession.user_id != request.state.user.id)
        .limit(1)
    ):
        raise HTTPException(403, "空间内有其他用户的会话，请联系管理员处理")
    return ResponseUtil.ok(await space_service.delete_space(db, space_id, target))


@router.get("/{space_id}/tools")
async def space_tools(space_id: int, db: AsyncSession = Depends(get_session)):
    await space_service.require_space(db, space_id)
    return ResponseUtil.ok({"items": await space_service.tool_states(db, space_id)})


@router.get("/{space_id}/tools/{tool}/usage")
async def space_tool_usage(space_id: int, tool: str, db: AsyncSession = Depends(get_session)):
    """本空间里用到这个工具的场景：关闭前提示，确认后这些场景从下一次新对话起不再使用它。"""
    await space_service.require_space(db, space_id)
    return ResponseUtil.ok({"scenarios": await space_service.tool_usage(db, space_id, tool)})


@router.put("/{space_id}/tools/{tool}")
async def switch_space_tool(
    space_id: int, tool: str, payload: ToolSwitch, db: AsyncSession = Depends(get_session)
):
    return ResponseUtil.ok(
        {"items": await space_service.set_tool_enabled(db, space_id, tool, payload.enabled)}
    )
