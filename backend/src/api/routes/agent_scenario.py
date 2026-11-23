from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..core.config import settings
from ..schemas.agent_scenario import CreateScenarioRequest, GenerateScenarioRequest, UpdateScenarioRequest
from ..services import scenario_generator
from ..services.scenario_service import scenario_service
from ..services.space_service import current_space
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("")
async def list_scenarios(
    db: AsyncSession = Depends(get_session), space_id: int | None = Depends(current_space)
):
    return ResponseUtil.ok(await scenario_service.list_mine(db, settings.admin_username, space_id))


@router.post("")
async def create_scenario(
    req: CreateScenarioRequest,
    db: AsyncSession = Depends(get_session),
    space_id: int | None = Depends(current_space),
):
    # 创建在当前空间（新建对话框里可改目标空间，前端以请求头传入）
    return ResponseUtil.ok(await scenario_service.create(db, settings.admin_username, req, space_id=space_id))


@router.post("/generate")
async def generate_scenario(
    req: GenerateScenarioRequest,
    db: AsyncSession = Depends(get_session),
    space_id: int | None = Depends(current_space),
):
    # AI 生成场景草稿：只返回结果供编辑器填充，不保存。编辑已有场景时按场景所在空间匹配能力
    if req.scenarioId is not None:
        space_id = (await scenario_service.row(db, req.scenarioId)).space_id
    return ResponseUtil.ok(await scenario_generator.generate(db, req, space_id))


@router.get("/{scenario_id}")
async def get_scenario(scenario_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await scenario_service.view(db, await scenario_service.row(db, scenario_id)))


@router.put("/{scenario_id}")
async def update_scenario(
    scenario_id: int, req: UpdateScenarioRequest, db: AsyncSession = Depends(get_session)
):
    return ResponseUtil.ok(await scenario_service.update(db, settings.admin_username, scenario_id, req))


@router.delete("/{scenario_id}")
async def delete_scenario(scenario_id: int, db: AsyncSession = Depends(get_session)):
    await scenario_service.delete(db, settings.admin_username, scenario_id)
    return ResponseUtil.ok()


@router.get("/{scenario_id}/versions")
async def versions(scenario_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await scenario_service.versions(db, scenario_id))


@router.post("/{scenario_id}/copy")
async def copy_scenario(
    scenario_id: int, db: AsyncSession = Depends(get_session), space_id: int | None = Depends(current_space)
):
    original = await scenario_service.view(db, await scenario_service.row(db, scenario_id))
    payload = CreateScenarioRequest.model_validate(
        {**original["payload"], "name": original["payload"]["name"] + " · 副本"}
    )
    # 副本放在当前空间；没有当前空间时与原场景同一空间
    target = space_id if space_id is not None else original["spaceId"]
    return ResponseUtil.ok(
        await scenario_service.create(db, settings.admin_username, payload, space_id=target)
    )


@router.post("/{scenario_id}/run-test")
async def run_test(scenario_id: int, request: Request):
    from ..services.session_service import session_service

    result = await session_service.test_scenario(scenario_id, user_id=request.state.user.id)
    return ResponseUtil.ok(result)


@router.post("/{scenario_id}/publish")
async def publish(scenario_id: int, db: AsyncSession = Depends(get_session)):
    row = await scenario_service.row(db, scenario_id)
    scenario_service.editable(row, settings.admin_username)
    tested = (await scenario_service.view(db, row))["tested"]
    if not tested:
        raise HTTPException(409, "当前版本尚未在当前模型与策略下通过试运行，不能发布")
    if row.published_version != row.current_version:
        # The database column is timezone-naive UTC (SQLite and PostgreSQL).
        row.published_at = datetime.now(timezone.utc).replace(tzinfo=None)
    row.published_version = row.current_version
    row.status = "published"
    await db.commit()
    await db.refresh(row)
    return ResponseUtil.ok(await scenario_service.view(db, row))
