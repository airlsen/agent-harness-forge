from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
from ..models.registry import McpServer
from ..services.mcp_service import import_servers, public_view, test_server
from ..services.settings_service import TOOLS, get_connection
from ..utils.response import ResponseUtil

router = APIRouter()


@router.get("/tools")
async def tools():
    return ResponseUtil.ok({"items": TOOLS})


@router.get("/plugins")
async def plugins():
    return ResponseUtil.ok(
        {
            "items": [
                {
                    "name": "forge-runtime",
                    "package": "@forge/runtime-plugin",
                    "version": "0.1.0",
                    "type": "platform",
                    "status": "active",
                    "description": "企业模型出口、受限会话工作区工具与审批门控。",
                    "extensionPoints": ["ctx.llm", "ctx.tools", "tools/pre-execute"],
                    "permissions": ["model-gateway", "session-workspace"],
                },
                {
                    "name": "dsh-sdk",
                    "package": "@deepseek-ai/dsh",
                    "version": "0.2.2-rc.1",
                    "type": "kernel",
                    "status": "installed",
                    "description": "DeepSeek Harness Agent Loop、会话日志与 JSON-RPC SDK 运行时。",
                    "extensionPoints": ["sdk-minimal", "session.event"],
                    "permissions": ["agent-runtime"],
                },
            ]
        }
    )


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
