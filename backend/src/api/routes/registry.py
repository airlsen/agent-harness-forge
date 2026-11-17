"""能力目录：前端场景编辑器与服务端装配器共用数据源。"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..utils.response import ApiResponse, ResponseUtil

router = APIRouter()


@router.get("/plugins")
async def list_plugins(db: AsyncSession = Depends(get_session)) -> ApiResponse:
    return ResponseUtil.ok({"items": []})  # TODO(M1): plugin_registry 白名单


@router.get("/skills")
async def list_skills(db: AsyncSession = Depends(get_session)) -> ApiResponse:
    return ResponseUtil.ok({"items": []})


@router.get("/mcp-servers")
async def list_mcp_servers(db: AsyncSession = Depends(get_session)) -> ApiResponse:
    return ResponseUtil.ok({"items": []})


@router.get("/models")
async def list_models(db: AsyncSession = Depends(get_session)) -> ApiResponse:
    return ResponseUtil.ok({"items": []})  # TODO(M1): model_registry + 租户路由策略过滤
