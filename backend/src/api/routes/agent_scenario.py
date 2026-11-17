from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..core.config import settings
from ..schemas.agent_scenario import CreateScenarioRequest, UpdateScenarioRequest
from ..services.scenario_service import scenario_service
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("")
async def list_scenarios(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await scenario_service.list_mine(db, settings.admin_username))


@router.post("")
async def create_scenario(req: CreateScenarioRequest, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await scenario_service.create(db, settings.admin_username, req))


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
async def copy_scenario(scenario_id: int, db: AsyncSession = Depends(get_session)):
    original = await scenario_service.view(db, await scenario_service.row(db, scenario_id))
    payload = CreateScenarioRequest.model_validate(
        {**original["payload"], "name": original["payload"]["name"] + " · 副本"}
    )
    return ResponseUtil.ok(await scenario_service.create(db, settings.admin_username, payload))


@router.post("/{scenario_id}/run-test")
async def run_test(scenario_id: int):
    from ..services.session_service import session_service

    result = await session_service.test_scenario(scenario_id)
    return ResponseUtil.ok(result)


@router.post("/{scenario_id}/publish")
async def publish(scenario_id: int, db: AsyncSession = Depends(get_session)):
    row = await scenario_service.row(db, scenario_id)
    scenario_service.editable(row, settings.admin_username)
    tested = (await scenario_service.view(db, row))["tested"]
    if not tested:
        raise HTTPException(409, "当前版本尚未在当前模型与策略下通过试运行，不能发布")
    row.status = "published"
    await db.commit()
    await db.refresh(row)
    return ResponseUtil.ok(await scenario_service.view(db, row))
