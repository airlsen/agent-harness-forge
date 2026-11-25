"""会话内提问（ask_user_question）的回执：与审批平行，不复用 approve/deny 语义。"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..models.approval_ticket import ApprovalTicket
from ..services.runner_client import runner_client
from ..services.session_service import session_service
from ..utils.response import ResponseUtil

router = APIRouter()


class QuestionAnswer(BaseModel):
    id: str
    selected: list[str] = []
    custom: str | None = None


class QuestionDecision(BaseModel):
    """回答一批问题（answers），或忽略整批（action=cancel，模型会自行继续）。"""

    answers: list[QuestionAnswer] | None = None
    action: str | None = None


@router.post("/{ticket_id}/resolve")
async def resolve(
    ticket_id: int,
    decision: QuestionDecision,
    request: Request,
    db: AsyncSession = Depends(get_session),
):
    ticket = await db.get(ApprovalTicket, ticket_id)
    if not ticket or ticket.kind != "question":
        raise HTTPException(404, "提问不存在")
    session = await session_service.owned_row(db, ticket.session_id, request.state.user.id)
    if ticket.status != "pending":
        raise HTTPException(409, "提问已回答或已过期")
    # 取消与回答分两种形状下发；Runner 侧会再按原问题校验每个 id 恰好一条
    body = {"action": "cancel"} if decision.action == "cancel" else decision.model_dump(exclude_none=True)
    await runner_client.call(
        "POST",
        f"/v1/sessions/{session.runner_session_id}/questions/{ticket.decision_payload['runnerTicketId']}/resolve",
        body,
    )
    ticket.status = "cancelled" if decision.action == "cancel" else "answered"
    ticket.decided_by = request.state.user.id
    ticket.decided_at = datetime.now(timezone.utc)
    if decision.answers is not None:
        ticket.decision_payload = {
            **ticket.decision_payload,
            "answers": [answer.model_dump(exclude_none=True) for answer in decision.answers],
        }
    await db.commit()
    return ResponseUtil.ok({"ticketId": ticket.id, "status": ticket.status})
