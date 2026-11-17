from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..models.platform import PlatformSetting
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
            "notice": "修改只影响新建会话；现有会话继续使用其不可变策略快照。",
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
