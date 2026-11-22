"""Forge 业务控制面正式入口。工作台、场景、会话、模型与治理共用数据库。"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from .core.database import close_db, init_db, SessionFactory
from .core.config import settings
from .core.security import initialize_security, require_auth
from .routes import (
    agent_scenario,
    agent_session,
    approval,
    audit,
    capability,
    code,
    governance,
    registry,
    auth,
    model,
    skill,
)
from .models.platform import PlatformSetting
from .services.scenario_service import seed_scenarios
from .services.plugin_service import seed_plugins
from .services.file_service import file_service
from .services.session_service import session_service
from .services.runner_client import runner_client
from .services.settings_service import get_connection
from .utils.response import ResponseUtil


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    initialize_security()
    if len(settings.runner_token) < 24:
        raise RuntimeError("FORGE_RUNNER_TOKEN 未设置，请先初始化并加载 data/business.env")
    await init_db()
    async with SessionFactory() as db:
        await seed_plugins(db)
        await seed_scenarios(db)
        # 执行策略中设置的关联代码目录
        saved = await db.get(PlatformSetting, "codeRoot")
        runner_client.code_root = str((saved.value or {}).get("root") or "") if saved else ""
    # 按保留期限定期清理过期会话文件
    cleanup = asyncio.create_task(file_service.retention_loop(runner_client))
    yield
    cleanup.cancel()
    await session_service.shutdown()
    await close_db()


app = FastAPI(
    title="AgentHarness Forge · Control Plane",
    version="0.2.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)


@app.middleware("http")
async def authentication(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.url.path not in (
        "/api/auth/session",
        "/api/auth/login",
    ):
        try:
            require_auth(request)
        except HTTPException as error:
            return JSONResponse(
                status_code=error.status_code,
                content={"code": error.status_code, "message": error.detail, "data": None},
            )
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(HTTPException)
async def http_error(request: Request, error: HTTPException):
    return JSONResponse(
        status_code=error.status_code,
        content={"code": error.status_code, "message": str(error.detail), "data": None},
    )


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, error: RequestValidationError):
    first = error.errors()[0] if error.errors() else {}
    message = f"{'.'.join(str(v) for v in first.get('loc', []))}: {first.get('msg', '参数无效')}"
    return JSONResponse(status_code=422, content={"code": 422, "message": message, "data": None})


app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(agent_scenario.router, prefix="/api/agent-scenarios", tags=["scenario"])
app.include_router(agent_session.router, prefix="/api/agent/sessions", tags=["session"])
app.include_router(approval.router, prefix="/api/agent/approvals", tags=["approval"])
app.include_router(code.router, prefix="/api/code", tags=["code"])
app.include_router(capability.router, prefix="/api/capabilities", tags=["capabilities"])
app.include_router(registry.router, prefix="/api/registry", tags=["registry"])
app.include_router(model.router, prefix="/api/models", tags=["models"])
app.include_router(skill.router, prefix="/api/skills", tags=["skills"])
app.include_router(governance.router, prefix="/api/governance", tags=["governance"])
app.include_router(audit.router, prefix="/api/audit", tags=["audit"])


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "service": "forge-control-plane", "mode": "business"}


@app.get("/api/runtime/status")
async def runtime():
    async with SessionFactory() as db:
        connection = await get_connection(db)
    return ResponseUtil.ok(
        {
            "controlPlane": "online",
            "runner": await runner_client.health(),
            "model": {
                "configured": connection["configured"],
                "name": connection.get("model"),
                "connectionName": connection.get("name"),
                "lastTest": connection.get("lastTest"),
            },
            "storage": "SQLite" if settings.database_url.startswith("sqlite") else "PostgreSQL",
            "authMode": "local-workspace",
            "deployment": "sandbox",
            "limitations": [
                "单工作空间管理员账号；OIDC 与多租户 RBAC 尚未接入",
                "会话工作区文件工具与终端命令（bash）直接执行，仅拦截少数高危命令，受平台策略约束；不是容器级隔离",
                "原生 fork 与跨 Runner 重启恢复尚未接入；历史消息和事件持久化保留",
                "本地数据库与文件存储，尚未接入 S3/WORM 和生产容器隔离",
            ],
        }
    )


# 部署时服务构建后的真实 Vue SPA；开发时可继续用 Vite 的同源 /api 代理。
if settings.serve_frontend and (settings.frontend_dist / "index.html").is_file():
    if (settings.frontend_dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=settings.frontend_dist / "assets"), name="frontend-assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str):
        if path == "api" or path.startswith("api/") or path.rsplit("/", 1)[-1].find(".") >= 0:
            raise HTTPException(404, "接口或资源不存在")
        return FileResponse(settings.frontend_dist / "index.html")
