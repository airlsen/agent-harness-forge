"""扩展能力选项：聊天临时选择与场景编辑器共用（只列可用项，不含任何凭据）。"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..services.capability_service import options
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("/options")
async def capability_options(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await options(db))
