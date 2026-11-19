import asyncio
import json
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..services.session_service import session_service
from ..services.capability_service import CapabilityChoice
from ..services.file_service import file_service
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
    # 关联代码（代码根目录下的项目名，只读）随消息提交：不传沿用会话已保存的选择，传入则从本轮起生效。
    codeProjects: list[str] | None = Field(default=None, max_length=20)
    # 聊天临时选择的扩展能力（Skill / MCP / 联网）同样随消息提交，规则同上。
    capabilities: CapabilityChoice | None = None


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
    return ResponseUtil.ok(
        await session_service.start(
            session_id,
            payload.message,
            model_id=payload.modelId,
            code_projects=payload.codeProjects,
            capabilities=payload.capabilities,
        )
    )


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


def _attachment_name(name: str) -> str:
    from urllib.parse import quote

    return f"attachment; filename*=UTF-8''{quote(name or 'file', safe='')}"


async def _file_session(db: AsyncSession, session_id: int):
    """读取会话并补同步旧会话的文件；结束当前读事务，确保看到刚同步写入的记录。"""
    row = await session_service.row(db, session_id)
    await file_service.ensure_synced(row, runner_client)
    await db.commit()
    return row


@router.get("/{session_id}/files")
async def files(session_id: int, db: AsyncSession = Depends(get_session)):
    """会话文件清单（来自服务端存储，Runner 离线或重启后依然可用）与保留期限。"""
    row = await _file_session(db, session_id)
    return ResponseUtil.ok(await file_service.list(db, row))


@router.get("/{session_id}/files/raw")
async def file_raw(
    session_id: int, path: str = Query(min_length=1, max_length=256), db: AsyncSession = Depends(get_session)
):
    """任意类型文件的原始字节：前端以 Blob 预览/下载。

    始终以附件形式返回并附带 sandbox CSP：即使被直接打开，模型生成的 HTML/SVG 也无法在本站源下执行脚本。
    """
    await _file_session(db, session_id)
    content, media_type = await file_service.raw(db, session_id, path)
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": _attachment_name(path.rsplit("/", 1)[-1]),
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
    )


@router.delete("/{session_id}/files")
async def delete_file(
    session_id: int, path: str = Query(min_length=1, max_length=256), db: AsyncSession = Depends(get_session)
):
    """删除一个文件：同时删除 Runner 工作区与服务端副本，并留下用户删除记录。"""
    row = await _file_session(db, session_id)
    await file_service.delete(row, path, runner_client)
    return ResponseUtil.ok({"deleted": path})


@router.get("/{session_id}/files/archive")
async def file_archive(
    session_id: int, dir: str = Query("", max_length=256), db: AsyncSession = Depends(get_session)
):
    """把会话文件（或其中一个目录）打包为 zip 下载。"""
    await _file_session(db, session_id)
    content = await file_service.archive(db, session_id, dir)
    folder = dir.strip("/").rsplit("/", 1)[-1]
    name = f"forge-session-{session_id}-{folder}.zip" if folder else f"forge-session-{session_id}-files.zip"
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": _attachment_name(name), "Cache-Control": "no-store"},
    )


@router.get("/{session_id}/files/changes/{change_id}")
async def file_change(session_id: int, change_id: int, db: AsyncSession = Depends(get_session)):
    """一次文件改动的 unified diff；二进制或过大文件只返回元数据。"""
    await session_service.row(db, session_id)
    return ResponseUtil.ok(await file_service.diff(db, session_id, change_id))


@router.get("/{session_id}/file")
async def file(
    session_id: int, path: str = Query(min_length=1, max_length=256), db: AsyncSession = Depends(get_session)
):
    """兼容旧接口：以文本读取 256 KB 内的文件。"""
    await _file_session(db, session_id)
    content, _ = await file_service.raw(db, session_id, path)
    if len(content) > 256000:
        raise HTTPException(422, "仅支持 256 KB 内的文本文件")
    try:
        return ResponseUtil.ok({"content": content.decode("utf-8")})
    except UnicodeDecodeError as error:
        raise HTTPException(422, "这是二进制文件，请使用下载") from error


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
