"""审计路由：六问检索（谁/何时/场景版本/模型看到什么/工具调用/成本）、回放、导出。"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..utils.response import ApiResponse, ResponseUtil

router = APIRouter()


@router.get("/sessions")
async def search_sessions(
    user_id: str | None = None,
    scenario_id: int | None = None,
    db: AsyncSession = Depends(get_session),
) -> ApiResponse:
    # TODO(M1): join agent_session + usage_record；权限=审计员角色
    return ResponseUtil.ok({"items": []})


@router.get("/sessions/{session_id}/replay")
async def replay_session(session_id: int, db: AsyncSession = Depends(get_session)) -> ApiResponse:
    """只读回放视图数据（事件流重建）；访问本身也记审计事件。"""
    return ResponseUtil.ok({"sessionId": session_id, "events": []})


@router.post("/export")
async def create_export(range: dict, db: AsyncSession = Depends(get_session)) -> ApiResponse:
    """生成审计导出工单（WORM 快照 + 限时链接）。"""
    return ResponseUtil.ok({"exportId": None, "todo": "M2"})
