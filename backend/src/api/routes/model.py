from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..services.settings_service import (
    ModelAvailabilityInput,
    ModelInput,
    create_connection,
    delete_connection,
    get_connection,
    list_connections,
    save_connection,
    set_connection_availability,
    test_connection,
)
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("")
async def list_models(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok({"items": await list_connections(db)})


@router.post("")
async def create(payload: ModelInput, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await create_connection(db, payload))


@router.get("/connection")
async def connection(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await get_connection(db))


@router.put("/connection")
async def save(payload: ModelInput, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await save_connection(db, payload))


@router.post("/connection/test")
async def test(db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await test_connection(db))


@router.post("/{connection_id}/test")
async def test_one(connection_id: int, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await test_connection(db, connection_id=connection_id))


@router.patch("/{connection_id}/availability")
async def update_availability(
    connection_id: int, payload: ModelAvailabilityInput, db: AsyncSession = Depends(get_session)
):
    return ResponseUtil.ok(await set_connection_availability(db, connection_id, enabled=payload.enabled))


@router.get("/{connection_id}")
async def detail(connection_id: int, db: AsyncSession = Depends(get_session)):
    connection = await get_connection(db, connection_id=connection_id)
    if not connection["configured"]:
        raise HTTPException(404, "模型配置不存在")
    return ResponseUtil.ok(connection)


@router.put("/{connection_id}")
async def update(connection_id: int, payload: ModelInput, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await save_connection(db, payload, connection_id=connection_id))


@router.delete("/{connection_id}")
async def delete(connection_id: int, db: AsyncSession = Depends(get_session)):
    await delete_connection(db, connection_id)
    return ResponseUtil.ok()
