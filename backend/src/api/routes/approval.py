from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Literal
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..core.config import settings
from ..models.approval_ticket import ApprovalTicket
from ..services.session_service import session_service
from ..services.runner_client import runner_client
from ..utils.response import ResponseUtil

router = APIRouter()


class Decision(BaseModel):
    action: Literal["approve", "deny"]


@router.get("")
async def pending(db: AsyncSession = Depends(get_session)):
    rows = (
        await db.scalars(
            select(ApprovalTicket)
            .where(ApprovalTicket.status == "pending")
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
                }
                for r in rows
            ]
        }
    )


@router.post("/{ticket_id}/resolve")
async def resolve(ticket_id: int, decision: Decision, db: AsyncSession = Depends(get_session)):
    ticket = await db.get(ApprovalTicket, ticket_id)
    if not ticket:
        raise HTTPException(404, "审批不存在")
    if ticket.status != "pending":
        raise HTTPException(409, "审批已经处理或过期")
    session = await session_service.row(db, ticket.session_id)
    await runner_client.call(
        "POST",
        f"/v1/sessions/{session.runner_session_id}/approvals/{ticket.tool_call_id}/resolve",
        decision.model_dump(),
    )
    ticket.status = "approved" if decision.action == "approve" else "denied"
    ticket.decided_by = settings.admin_username
    ticket.decided_at = datetime.now(timezone.utc)
    await db.commit()
    return ResponseUtil.ok({"ticketId": ticket.id, "status": ticket.status})
