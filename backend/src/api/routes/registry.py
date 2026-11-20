from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..models.registry import McpServer
from ..services.mcp_service import editable_view, import_servers, public_view, test_server, update_server
from ..services.plugin_service import (
    MAX_ARCHIVE_BYTES,
    import_archive,
    list_plugins,
    review_release,
    set_release_enabled,
)
from ..services.settings_service import TOOLS, list_connections
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


class McpImport(BaseModel):
    config: dict


class McpEnable(BaseModel):
    enabled: bool


class McpUpdate(BaseModel):
    config: dict
    credential_action: str = Field(pattern="^(keep|replace|clear)$")


@router.get("/mcp-servers")
async def mcp_servers(db: AsyncSession = Depends(get_session)):
    rows = (await db.scalars(select(McpServer).order_by(McpServer.name))).all()
    return ResponseUtil.ok({"items": [public_view(row) for row in rows], "available": True, "reason": ""})


@router.post("/mcp-servers/import")
async def mcp_import(payload: McpImport, db: AsyncSession = Depends(get_session)):
    rows = await import_servers(db, payload.config)
    return ResponseUtil.ok({"items": [public_view(row) for row in rows]})


@router.get("/mcp-servers/{server_id}/edit")
async def mcp_edit_config(server_id: int, db: AsyncSession = Depends(get_session)):
    row = await db.get(McpServer, server_id)
    if not row:
        raise HTTPException(404, "MCP 服务不存在")
    return ResponseUtil.ok(editable_view(row))


@router.put("/mcp-servers/{server_id}")
async def mcp_update(server_id: int, payload: McpUpdate, db: AsyncSession = Depends(get_session)):
    row = await db.get(McpServer, server_id)
    if not row:
        raise HTTPException(404, "MCP 服务不存在")
    return ResponseUtil.ok(await update_server(db, row, payload.config, payload.credential_action))


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
    if payload.enabled and row.transport == "sse":
        raise HTTPException(409, "旧版 SSE 服务仅支持连接测试，暂不能在会话中运行；请改用 Streamable HTTP")
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
    connections = await list_connections(db)
    return ResponseUtil.ok(
        {
            "items": [
                {
                    "id": str(connection["id"]),
                    "name": connection["name"],
                    "model": connection["model"],
                    "provider": "OpenAI-compatible",
                    "enabled": True,
                }
                for connection in connections
                if connection["enabled"]
            ]
        }
    )
