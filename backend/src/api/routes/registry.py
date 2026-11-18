from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..models.registry import McpServer
from ..services.mcp_service import import_servers, public_view, test_server
from ..services.plugin_service import MAX_ARCHIVE_BYTES, import_archive, list_plugins, review_release, set_release_enabled
from ..services.settings_service import TOOLS, get_connection
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("/tools")
async def tools():
    return ResponseUtil.ok({"items": TOOLS})


@router.get("/plugins")
async def plugins(db: AsyncSession = Depends(get_session)):
    items, submissions = await list_plugins(db)
    return ResponseUtil.ok({"items": items, "submissions": submissions})


class PluginReview(BaseModel):
    action: str = Field(pattern="^(approved|rejected)$")
    note: str = Field(default="", max_length=1024)


class PluginEnabled(BaseModel):
    enabled: bool


@router.post("/plugins/upload")
async def plugin_upload(filename: str, request: Request, db: AsyncSession = Depends(get_session)):
    # 原始 ZIP 直传，避免把二进制塞入 JSON/Base64；不会在控制面执行其中代码。
    declared_size = request.headers.get("content-length")
    if declared_size and declared_size.isdigit() and int(declared_size) > MAX_ARCHIVE_BYTES:
        raise HTTPException(413, "插件包超过 5 MB 限制")
    raw = await request.body()
    return ResponseUtil.ok(await import_archive(db, filename, raw))


@router.post("/plugins/{release_id}/review")
async def plugin_review(release_id: int, payload: PluginReview, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await review_release(db, release_id, payload.action, payload.note))


@router.patch("/plugins/{release_id}")
async def plugin_enable(release_id: int, payload: PluginEnabled, db: AsyncSession = Depends(get_session)):
    return ResponseUtil.ok(await set_release_enabled(db, release_id, payload.enabled))


@router.get("/skills")
async def skills():
    return ResponseUtil.ok(
        {"items": [], "available": False, "reason": "当前尚未接入 Skill 管理与物化执行，不提供模拟安装"}
    )


class McpImport(BaseModel):
    config: dict


class McpEnable(BaseModel):
    enabled: bool


@router.get("/mcp-servers")
async def mcp_servers(db: AsyncSession = Depends(get_session)):
    rows = (await db.scalars(select(McpServer).order_by(McpServer.name))).all()
    return ResponseUtil.ok({"items": [public_view(row) for row in rows], "available": True, "reason": ""})


@router.post("/mcp-servers/import")
async def mcp_import(payload: McpImport, db: AsyncSession = Depends(get_session)):
    rows = await import_servers(db, payload.config)
    return ResponseUtil.ok({"items": [public_view(row) for row in rows]})


@router.post("/mcp-servers/{server_id}/test")
async def mcp_test(server_id: int, db: AsyncSession = Depends(get_session)):
    row = await db.get(McpServer, server_id)
    if not row:
        raise HTTPException(404, "MCP 服务不存在")
    return ResponseUtil.ok(await test_server(db, row))


@router.patch("/mcp-servers/{server_id}")
async def mcp_enable(server_id: int, payload: McpEnable, db: AsyncSession = Depends(get_session)):
    row = await db.get(McpServer, server_id)
    if not row:
        raise HTTPException(404, "MCP 服务不存在")
    if payload.enabled and (row.status != "connected" or not row.tools_json):
        raise HTTPException(409, "请先成功测试连接并发现至少一个工具")
    row.enabled = payload.enabled
    await db.commit()
    await db.refresh(row)
    return ResponseUtil.ok(public_view(row))


@router.delete("/mcp-servers/{server_id}")
async def mcp_delete(server_id: int, db: AsyncSession = Depends(get_session)):
    row = await db.get(McpServer, server_id)
    if not row:
        raise HTTPException(404, "MCP 服务不存在")
    await db.delete(row)
    await db.commit()
    return ResponseUtil.ok()


@router.get("/models")
async def models(db: AsyncSession = Depends(get_session)):
    config = await get_connection(db)
    return ResponseUtil.ok(
        {
            "items": [
                {"id": "default", "name": config["model"], "provider": "OpenAI-compatible", "enabled": True}
            ]
            if config["configured"]
            else []
        }
    )
