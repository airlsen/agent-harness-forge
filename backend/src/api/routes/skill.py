import json
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import settings
from ..core.database import get_session
from ..schemas.skill import SkillApprovalDecision, SkillCreate, SkillDraftUpdate, SkillFileWrite, SkillTurn
from ..services import skill_service
from ..services.runner_client import runner_client
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("")
async def list_skills(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok({"items": await skill_service.list_skills(db)})


@router.post("")
async def create_skill(payload: SkillCreate, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(
        await skill_service.create_skill(
            db, payload.name, payload.description, payload.content, settings.admin_username
        )
    )


@router.get("/published")
async def list_published_skills(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok({"items": await skill_service.list_published_skills(db)})


@router.get("/{skill_id}")
async def get_skill(skill_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await skill_service.skill_detail(db, skill_id))


@router.get("/{skill_id}/published")
async def get_published_skill(skill_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await skill_service.published_skill_detail(db, skill_id))


@router.get("/{skill_id}/published/files")
async def get_published_file(skill_id: int, path: str = Query(...), db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await skill_service.published_file(db, skill_id, path))


@router.get("/{skill_id}/download")
async def download_skill(
    skill_id: int,
    version: Literal["current", "published"] = Query("current"),
    db: AsyncSession = Depends(get_session),
):
    content, name = await skill_service.skill_archive(db, skill_id, version)
    return Response(
        content,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}.zip"', "Cache-Control": "no-store"},
    )


@router.delete("/{skill_id}")
async def delete_skill_draft(skill_id: int, db: AsyncSession = Depends(get_session)):
    await skill_service.delete_draft(db, skill_id)
    return ResponseUtil.ok({"deleted": True})


@router.put("/{skill_id}/draft")
async def update_draft(skill_id: int, payload: SkillDraftUpdate, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(
        await skill_service.update_draft(
            db, skill_id, payload.content, payload.change_summary, settings.admin_username
        )
    )


@router.get("/{skill_id}/revisions")
async def get_revisions(skill_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok({"items": await skill_service.revisions(db, skill_id)})


@router.post("/{skill_id}/revisions/{revision_id}/restore")
async def restore_revision(skill_id: int, revision_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(
        await skill_service.restore_revision(db, skill_id, revision_id, settings.admin_username)
    )


@router.post("/{skill_id}/publish")
async def publish_skill(skill_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await skill_service.publish_skill(db, skill_id, settings.admin_username))


@router.get("/{skill_id}/files/{revision_id}")
async def get_file(
    skill_id: int, revision_id: int, path: str = Query(...), db: AsyncSession = Depends(get_session)
):
    return ResponseUtil.ok(await skill_service.revision_file(db, skill_id, revision_id, path))


@router.put("/{skill_id}/files")
async def write_file(skill_id: int, payload: SkillFileWrite, db: AsyncSession = Depends(get_session)):
    await skill_service.write_file(db, skill_id, payload.path, payload.content, payload.change_summary)
    return ResponseUtil.ok(await skill_service.skill_detail(db, skill_id))


@router.delete("/{skill_id}/files")
async def delete_file(skill_id: int, path: str = Query(...), db: AsyncSession = Depends(get_session)):
    await skill_service.delete_file(db, skill_id, path)
    return ResponseUtil.ok(await skill_service.skill_detail(db, skill_id))


@router.get("/{skill_id}/authoring-session/latest")
async def latest_authoring_session(skill_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await skill_service.latest_authoring_session(db, skill_id))


@router.post("/{skill_id}/authoring-sessions")
async def new_authoring_session(skill_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(
        await skill_service.create_authoring_session(db, skill_id, settings.admin_username)
    )


@router.post("/{skill_id}/authoring-sessions/{session_id}/turns")
async def authoring_turn(
    skill_id: int, session_id: int, payload: SkillTurn, db: AsyncSession = Depends(get_session)
):
    await skill_service.get_authoring_session(db, skill_id, session_id)

    async def stream():
        try:
            async for event in skill_service.run_authoring_turn(
                skill_id, session_id, payload.message, settings.admin_username
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as error:
            yield f"data: {json.dumps({'kind': 'error', 'payload': {'message': str(error) or 'Skill 助手执行失败'}}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{skill_id}/authoring-sessions/{session_id}/approvals/{ticket_id}/resolve")
async def resolve_authoring_approval(
    skill_id: int,
    session_id: int,
    ticket_id: UUID,
    decision: SkillApprovalDecision,
    db: AsyncSession = Depends(get_session),
):
    session = await skill_service.get_authoring_session(db, skill_id, session_id)
    if session.status != "running" or not session.runner_session_id:
        raise HTTPException(409, "当前没有等待确认的 Skill 执行")
    await runner_client.call(
        "POST",
        f"/v1/sessions/{session.runner_session_id}/approvals/{ticket_id}/resolve",
        decision.model_dump(),
    )
    return ResponseUtil.ok({"ticketId": ticket_id, "action": decision.action})
