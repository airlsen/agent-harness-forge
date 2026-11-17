"""治理路由：RBAC / 配额 / 策略矩阵 / 模型路由（租户管理员）。
MVP 骨架：策略读写即可；判定逻辑在 runner 的 policy 插件（快照下发）。
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..utils.response import ApiResponse, ResponseUtil

router = APIRouter()


@router.get("/policies")
async def get_policies(db: AsyncSession = Depends(get_session)) -> ApiResponse:
    return ResponseUtil.ok({"tool_matrix": {}, "network": {}, "data_rules": []})


@router.put("/policies")
async def put_policies(payload: dict, db: AsyncSession = Depends(get_session)) -> ApiResponse:
    # TODO(M2): 生成 policy_snapshot，推送 Runner policy 插件热更新（Cordis 可逆注册）
    return ResponseUtil.ok()


@router.get("/quotas")
async def get_quotas(db: AsyncSession = Depends(get_session)) -> ApiResponse:
    return ResponseUtil.ok({"tenant": {}, "department": [], "users": []})


@router.get("/model-routes")
async def get_model_routes(db: AsyncSession = Depends(get_session)) -> ApiResponse:
    return ResponseUtil.ok({"rules": []})
