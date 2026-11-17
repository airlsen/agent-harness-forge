from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.database import get_session
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


@router.get("/mcp-servers")
async def mcp_servers():
    return ResponseUtil.ok({"items": [], "available": False, "reason": "MCP 注册与认证托管将在后续版本接入"})


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
