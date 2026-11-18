import json
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..core.config import settings
from ..schemas.skill import SkillCreate, SkillDraftUpdate, SkillReferenceInput, SkillTurn
from ..services import skill_service
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


@router.get("/{skill_id}")
async def get_skill(skill_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await skill_service.skill_detail(db, skill_id))


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


@router.post("/{skill_id}/references")
async def add_reference(skill_id: int, payload: SkillReferenceInput, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await skill_service.add_reference(db, skill_id, payload.filename, payload.content))


@router.get("/{skill_id}/references/{revision_id}/{reference_index}")
async def get_reference(
    skill_id: int, revision_id: int, reference_index: int, db: AsyncSession = Depends(get_session)
):
    skill = await skill_service.get_skill(db, skill_id)
    revision = await db.get(skill_service.SkillRevision, revision_id)
    if not revision or revision.skill_id != skill.id:
        raise HTTPException(404, "参考资料不存在")
    files = revision.reference_files or []
    if reference_index < 0 or reference_index >= len(files):
        raise HTTPException(404, "参考资料不存在")
    ref = files[reference_index]
    path = (skill_service.settings.data_dir / str(ref.get("path", ""))).resolve()
    if not path.is_relative_to(skill_service.settings.data_dir.resolve()):
        raise HTTPException(400, "参考资料路径无效")
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as error:
        raise HTTPException(404, "参考资料文件不可读取") from error
    return ResponseUtil.ok({"filename": ref.get("filename"), "content": content})


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
            async for event in skill_service.run_authoring_turn(skill_id, session_id, payload.message):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as error:
            yield f"data: {json.dumps({'kind': 'error', 'payload': {'message': str(error) or 'Skill 助手执行失败'}}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
