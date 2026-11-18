from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..models.platform import PlatformSetting
from ..services.file_service import file_service
from ..services.runner_client import runner_client
from ..services.settings_service import PolicyInput, get_policy
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("/policies")
async def policies(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(
        {
            **(await get_policy(db)),
            "scope": "single-workspace",
            "shellEnabled": False,
            "networkToolsEnabled": False,
            "notice": "工具与执行限额只影响新建会话，现有会话继续使用其不可变策略快照；文件保留期限对所有会话即时生效。",
        }
    )


@router.put("/policies")
async def save(payload: PolicyInput, db: AsyncSession = Depends(get_session)):
    row = await db.get(PlatformSetting, "policy")
    if not row:
        row = PlatformSetting(key="policy", value=payload.model_dump())
        db.add(row)
    else:
        row.value = payload.model_dump()
    await db.commit()
    return ResponseUtil.ok(await get_policy(db))


@router.get("/storage")
async def storage(db: AsyncSession = Depends(get_session)):
    """会话文件存储概况：文件数、逻辑大小、去重后实际占用、保留期限与最近一次清理结果。"""
    return ResponseUtil.ok(await file_service.stats(db))


@router.post("/storage/cleanup")
async def cleanup():
    """立即按当前保留期限清理过期会话文件，并回收不再引用的内容。"""
    return ResponseUtil.ok(await file_service.cleanup_expired(runner_client))
