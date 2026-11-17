"""场景路由：仅鉴权 + 参数解析 + service + ResponseUtil 包装。"""

from fastapi import APIRouter, Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..schemas.agent_scenario import (
    CreateScenarioRequest,
    GenerateScenarioRequest,
    UpdateScenarioRequest,
)
from ..services.scenario_service import scenario_service
from ..utils.response import ApiResponse, ResponseUtil

router = APIRouter()

# TODO(M1): 登录态/RBAC 依赖（get_current_user），暂用 header 透传占位
OwnerHeader = Header(default="dev-user", alias="X-Dev-User")


@router.get("")
async def list_my_scenarios(
    db: AsyncSession = Depends(get_session), owner_id: str = OwnerHeader
) -> ApiResponse:
    items = await scenario_service.list_mine(db, owner_id)
    return ResponseUtil.ok(items)


@router.post("")
async def create_scenario(
    req: CreateScenarioRequest,
    db: AsyncSession = Depends(get_session),
    owner_id: str = OwnerHeader,
) -> ApiResponse:
    return ResponseUtil.ok(await scenario_service.create(db, owner_id, req))


@router.put("/{scenario_id}")
async def update_scenario(
    scenario_id: int,
    req: UpdateScenarioRequest,
    db: AsyncSession = Depends(get_session),
    owner_id: str = OwnerHeader,
) -> ApiResponse:
    await scenario_service.update(db, owner_id, scenario_id, req)
    return ResponseUtil.ok()


@router.delete("/{scenario_id}")
async def delete_scenario(
    scenario_id: int,
    db: AsyncSession = Depends(get_session),
    owner_id: str = OwnerHeader,
) -> ApiResponse:
    await scenario_service.delete(db, owner_id, scenario_id)
    return ResponseUtil.ok()


@router.post("/generate")
async def generate_scenario(
    req: GenerateScenarioRequest,
    db: AsyncSession = Depends(get_session),
    owner_id: str = OwnerHeader,
) -> ApiResponse:
    """AI 生成草稿（不落库），回传与 CreateScenarioRequest 同构的装配单。"""
    return ResponseUtil.ok(await scenario_service.generate(db, owner_id, req))


@router.post("/{scenario_id}/run-test")
async def run_test_scenario(
    scenario_id: int,
    db: AsyncSession = Depends(get_session),
    owner_id: str = OwnerHeader,
) -> ApiResponse:
    return ResponseUtil.ok(await scenario_service.run_test(db, owner_id, scenario_id))
