import asyncio
import json
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..services.session_service import session_service
from ..services.runner_client import runner_client
from ..utils.response import ResponseUtil

router = APIRouter()


class NewSession(BaseModel):
    scenarioId: int = Field(gt=0)
    # 本次会话使用的模型配置；不传则使用平台默认模型。
    modelId: int | None = Field(default=None, gt=0)


class Turn(BaseModel):
    message: str = Field(min_length=1, max_length=64000)
    # 从本轮起使用的模型；不传或与当前相同则沿用会话当前模型。
    modelId: int | None = Field(default=None, gt=0)


@router.get("")
async def list_sessions():
    return ResponseUtil.ok({"items": await session_service.list()})


@router.post("")
async def create(payload: NewSession):
    return ResponseUtil.ok(await session_service.create(payload.scenarioId, model_id=payload.modelId))


@router.get("/{session_id}")
async def detail(session_id: int):
    return ResponseUtil.ok(await session_service.detail(session_id))


@router.post("/{session_id}/turns", status_code=202)
async def turn(session_id: int, payload: Turn):
    return ResponseUtil.ok(await session_service.start(session_id, payload.message, model_id=payload.modelId))


@router.get("/{session_id}/events")
async def events(session_id: int, request: Request, after: int = Query(default=0, ge=0)):
    await session_service.status(session_id)
    try:
        after = max(after, int(request.headers.get("last-event-id", "0")))
    except ValueError:
        pass

    async def generate():
        cursor = after
        while not await request.is_disconnected():
            rows = await session_service.events(session_id, cursor)
            for event in rows:
                cursor = event["seq"]
                yield f"id: {cursor}\nevent: kernel\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            state = await session_service.status(session_id)
            if state != "running" and not rows:
                yield "event: settled\ndata: {}\n\n"
                return
            if not rows:
                yield ": heartbeat\n\n"
            await asyncio.sleep(0.2)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.post("/{session_id}/interrupt")
async def interrupt(session_id: int, db: AsyncSession = Depends(get_session)):
    await session_service.interrupt(session_id)
    return ResponseUtil.ok()


@router.delete("/{session_id}")
async def archive(session_id: int):
    await session_service.archive(session_id)
    return ResponseUtil.ok()


@router.get("/{session_id}/trajectory")
async def trajectory(session_id: int, source: str | None = None, cursor: int = Query(0, ge=0)):
    rows = await session_service.events(session_id, cursor, source=source)
    return ResponseUtil.ok({"events": rows, "nextCursor": rows[-1]["seq"] if rows else cursor})


@router.get("/{session_id}/files")
async def files(session_id: int, db: AsyncSession = Depends(get_session)):
    row = await session_service.row(db, session_id)
    if not row.runner_session_id:
        return ResponseUtil.ok({"items": []})
    return ResponseUtil.ok(await runner_client.call("GET", f"/v1/sessions/{row.runner_session_id}/files"))


@router.get("/{session_id}/file")
async def file(
    session_id: int, path: str = Query(min_length=1, max_length=220), db: AsyncSession = Depends(get_session)
):
    from urllib.parse import quote

    row = await session_service.row(db, session_id)
    if not row.runner_session_id:
        raise HTTPException(404, "会话尚未产生文件")
    data = await runner_client.call(
        "GET", f"/v1/sessions/{row.runner_session_id}/file?path={quote(path, safe='')}"
    )
    return ResponseUtil.ok(data)


@router.get("/{session_id}/export")
async def export(session_id: int):
    data = await session_service.detail(session_id)
    all_events, cursor = [], 0
    while True:
        page = await session_service.events(session_id, cursor, limit=2000)
        if not page:
            break
        all_events.extend(page)
        cursor = page[-1]["seq"]
    data["events"] = all_events
    return Response(
        json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="forge-session-{session_id}.json"'},
    )
