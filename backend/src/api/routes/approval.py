from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from typing import Literal
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..models.agent_session import AgentSession
from ..models.approval_ticket import ApprovalTicket
from ..services.session_service import session_service
from ..services.runner_client import runner_client
from ..utils.response import ResponseUtil

router = APIRouter()


class Decision(BaseModel):
    action: Literal["approve", "deny"]


@router.get("")
async def pending(request: Request, db: AsyncSession = Depends(get_session)):
    rows = (
        await db.scalars(
            select(ApprovalTicket)
            .join(AgentSession, AgentSession.id == ApprovalTicket.session_id)
            .where(ApprovalTicket.status == "pending", AgentSession.user_id == request.state.user.id)
            .order_by(ApprovalTicket.id.desc())
        )
    ).all()
    return ResponseUtil.ok(
        {
            "items": [
                {
                    "ticketId": r.id,
                    "sessionId": r.session_id,
                    "tool": r.tool,
                    "arguments": r.args_digest,
                    "status": r.status,
                    **(
                        {"reason": r.decision_payload["reason"]}
                        if (r.decision_payload or {}).get("reason")
                        else {}
                    ),
                }
                for r in rows
            ]
        }
    )


@router.post("/{ticket_id}/resolve")
async def resolve(
    ticket_id: int, decision: Decision, request: Request, db: AsyncSession = Depends(get_session)
):
    ticket = await db.get(ApprovalTicket, ticket_id)
    if not ticket:
        raise HTTPException(404, "审批不存在")
    session = await session_service.owned_row(db, ticket.session_id, request.state.user.id)
    if ticket.status != "pending":
        raise HTTPException(409, "审批已经处理或过期")
    await runner_client.call(
        "POST",
        f"/v1/sessions/{session.runner_session_id}/approvals/{ticket.tool_call_id}/resolve",
        decision.model_dump(),
    )
    ticket.status = "approved" if decision.action == "approve" else "denied"
    ticket.decided_by = request.state.user.id
    ticket.decided_at = datetime.now(timezone.utc)
    await db.commit()
    return ResponseUtil.ok({"ticketId": ticket.id, "status": ticket.status})
