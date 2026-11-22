"""扩展能力选项：聊天临时选择与场景编辑器共用（只列可用项，不含任何凭据）。"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..services.capability_service import options
from ..services.space_service import current_space
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("/options")
async def capability_options(
    db: AsyncSession = Depends(get_session), space_id: int | None = Depends(current_space)
):
    # 只列当前空间和公共空间的内容
    return ResponseUtil.ok(await options(db, space_id))
