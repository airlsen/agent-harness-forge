"""审批路由：UI/IM 决策统一入口；runner 侧 approval-bridge 在此等待结果。"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..utils.response import ApiResponse, ResponseUtil

router = APIRouter()


@router.post("/{ticket_id}/resolve")
async def resolve_approval(ticket_id: int, decision: dict, db: AsyncSession = Depends(get_session)) -> ApiResponse:
    """decision: {action: approve|deny|submit, payload?: ...}
    TODO(M1): 落 approval_ticket -> RunnerClient.resolve_approval 透传 ->
    SSE 回推 approval_resolved；超时由控制面定时器自动 deny（默认 600s）。
    """
    return ResponseUtil.ok({"ticketId": ticket_id, "status": "recorded"})
