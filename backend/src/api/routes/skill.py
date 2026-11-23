import json
from typing import Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import settings
from ..core.database import get_session
from ..schemas.skill import (
    SkillApprovalDecision,
    SkillAuthoringSessionCreate,
    SkillCreate,
    SkillDraftUpdate,
    SkillFileWrite,
    SkillTurn,
)
from ..services import skill_service
from ..services.runner_client import runner_client
from ..services.space_service import current_space
from ..utils.response import ResponseUtil

router = APIRouter()


async def require_authoring_owner(
    skill_id: int, session_id: int, request: Request, db: AsyncSession = Depends(get_session)
):
    return await skill_service.owned_authoring_session(db, skill_id, session_id, request.state.user.id)


@router.get("")
async def list_skills(db: AsyncSession = Depends(get_session), space_id: int | None = Depends(current_space)):
    return ResponseUtil.ok({"items": await skill_service.list_skills(db, space_id)})


@router.post("")
async def create_skill(
    payload: SkillCreate,
    db: AsyncSession = Depends(get_session),
    space_id: int | None = Depends(current_space),
):
    # 创建在当前空间（新建对话框里可改目标空间，前端以请求头传入）
    return ResponseUtil.ok(
        await skill_service.create_skill(
            db, payload.name, payload.description, payload.content, settings.admin_username, space_id
        )
    )


@router.get("/published")
async def list_published_skills(
    db: AsyncSession = Depends(get_session), space_id: int | None = Depends(current_space)
):
    return ResponseUtil.ok({"items": await skill_service.list_published_skills(db, space_id)})


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
async def delete_skill(skill_id: int, db: AsyncSession = Depends(get_session)):
    """删除草稿或已下线的技能；上线中的需先下线，仍被场景使用的需先在场景中移除。"""
    await skill_service.delete_skill(db, skill_id)
    return ResponseUtil.ok({"deleted": True})


@router.get("/{skill_id}/usage")
async def skill_usage(skill_id: int, db: AsyncSession = Depends(get_session)):
    """正在使用这个技能的场景（下线、删除前确认用）。"""
    return ResponseUtil.ok({"scenarios": await skill_service.skill_usage(db, skill_id)})


@router.post("/{skill_id}/unpublish")
async def unpublish_skill(skill_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await skill_service.unpublish_skill(db, skill_id))


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
async def latest_authoring_session(skill_id: int, request: Request, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await skill_service.latest_authoring_session(db, skill_id, request.state.user.id))


@router.post("/{skill_id}/authoring-sessions")
async def new_authoring_session(
    skill_id: int,
    request: Request,
    payload: SkillAuthoringSessionCreate | None = None,
    db: AsyncSession = Depends(get_session),
):
    return ResponseUtil.ok(
        await skill_service.create_authoring_session(
            db, skill_id, request.state.user.id, payload.modelId if payload else None
        )
    )


@router.post(
    "/{skill_id}/authoring-sessions/{session_id}/turns", dependencies=[Depends(require_authoring_owner)]
)
async def authoring_turn(
    skill_id: int, session_id: int, payload: SkillTurn, db: AsyncSession = Depends(get_session)
):
    await skill_service.get_authoring_session(db, skill_id, session_id)
    if payload.modelId is not None:
        # 先校验所选模型：不可用时直接返回错误，消息不会被受理
        await skill_service.ensure_authoring_model(db, payload.modelId)

    async def stream():
        try:
            async for event in skill_service.run_authoring_turn(
                skill_id, session_id, payload.message, payload.modelId
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as error:
            message = str(error.detail if isinstance(error, HTTPException) else error) or "Skill 助手执行失败"
            yield f"data: {json.dumps({'kind': 'error', 'payload': {'message': message}}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/{skill_id}/authoring-sessions/{session_id}/interrupt", dependencies=[Depends(require_authoring_owner)]
)
async def interrupt_authoring_turn(skill_id: int, session_id: int, db: AsyncSession = Depends(get_session)):
    """停止 Skill 助手当前这一轮（与工作台「中止执行」一致）；没有正在处理的消息时什么也不做。"""
    session = await skill_service.get_authoring_session(db, skill_id, session_id)
    if session.status != "running" or not session.runner_session_id:
        return ResponseUtil.ok({"interrupted": False})
    try:
        await runner_client.call("POST", f"/v1/sessions/{session.runner_session_id}/interrupt")
    except HTTPException as error:
        if error.status_code != 404:
            raise
    return ResponseUtil.ok({"interrupted": True})


@router.post(
    "/{skill_id}/authoring-sessions/{session_id}/approvals/{ticket_id}/resolve",
    dependencies=[Depends(require_authoring_owner)],
)
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


def _attachment_name(name: str) -> str:
    return f"attachment; filename*=UTF-8''{quote(name or 'file', safe='')}"


@router.get(
    "/{skill_id}/authoring-sessions/{session_id}/files", dependencies=[Depends(require_authoring_owner)]
)
async def trial_files(
    skill_id: int, session_id: int, refresh: bool = Query(False), db: AsyncSession = Depends(get_session)
):
    """试用文件清单：编辑对话的会话工作区文件（来自服务端存储，Runner 重启后依然可用）。"""
    return ResponseUtil.ok(await skill_service.trial_files(db, skill_id, session_id, refresh))


@router.get(
    "/{skill_id}/authoring-sessions/{session_id}/files/raw", dependencies=[Depends(require_authoring_owner)]
)
async def trial_file_raw(
    skill_id: int,
    session_id: int,
    path: str = Query(min_length=1, max_length=256),
    db: AsyncSession = Depends(get_session),
):
    """试用文件原始字节：与会话文件一致，始终以附件形式返回并附带 sandbox CSP。"""
    content, media_type = await skill_service.trial_file_raw(db, skill_id, session_id, path)
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": _attachment_name(path.rsplit("/", 1)[-1]),
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
    )


@router.delete(
    "/{skill_id}/authoring-sessions/{session_id}/files", dependencies=[Depends(require_authoring_owner)]
)
async def delete_trial_file(
    skill_id: int,
    session_id: int,
    path: str = Query(min_length=1, max_length=256),
    db: AsyncSession = Depends(get_session),
):
    await skill_service.delete_trial_file(db, skill_id, session_id, path)
    return ResponseUtil.ok({"deleted": path})
