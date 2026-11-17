"""会话路由：建会话 / SSE 执行 / 中断 / 分叉 / 回放 / 轨迹。

SSE 事件协议沿用旧协议（session/message_delta/tool_use/approval/cost_tick/files/done…），
事件生产由 Runner 侧 Event Bridge 完成，本站负责鉴权、落库与扇出接线。
"""

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from ..core.database import get_session
from ..utils.response import ApiResponse, ResponseUtil

router = APIRouter()
OwnerHeader = Header(default="dev-user", alias="X-Dev-User")


@router.post("")
async def create_session(
    scenario_id: int,
    db: AsyncSession = Depends(get_session),
    owner_id: str = OwnerHeader,
) -> ApiResponse:
    """编译 Bundle 快照 -> 选 Runner -> 落 agent_session -> 返回 session_id。"""
    # TODO(M1): session_service.create(...)，内部调 ScenarioAssembler + RunnerClient
    return ResponseUtil.ok({"sessionId": None, "todo": "M1"})


@router.post("/{session_id}/stream")
async def stream_turn(session_id: int, message: str) -> EventSourceResponse:
    """一轮任务的 SSE 流（语义对齐旧 /conversations/stream）。"""
    # TODO(M1): session_service.stream_execute(...)，事件源 = Runner Event Bridge
    raise NotImplementedError


@router.post("/{session_id}/interrupt")
async def interrupt(session_id: int) -> ApiResponse:
    return ResponseUtil.ok()


@router.post("/{session_id}/fork")
async def fork(session_id: int, at_seq: int = Query(ge=0)) -> ApiResponse:
    """从事件序号分叉出新会话（同 Bundle 快照）。"""
    return ResponseUtil.ok({"sessionId": None, "forkedFrom": session_id, "atSeq": at_seq})


@router.get("/{session_id}/trajectory")
async def trajectory(session_id: int, source: str | None = None, cursor: int = 0) -> ApiResponse:
    """轨迹分页（前端 TrajectoryPanel 与审计共用）。"""
    return ResponseUtil.ok({"events": [], "nextCursor": None})
