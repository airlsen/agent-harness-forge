from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..services.settings_service import ModelInput, get_connection, save_connection, test_connection
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("/connection")
async def connection(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await get_connection(db))


@router.put("/connection")
async def save(payload: ModelInput, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await save_connection(db, payload))


@router.post("/connection/test")
async def test(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await test_connection(db))
