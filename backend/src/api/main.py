"""AgentHarness Forge 控制面入口。

分层规范（沿袭旧 AgentX）：route 不写业务 / service 不碰 HTTP / model 不做序列化。
启动顺序：中间件 -> 路由注册 -> 生命周期（连接池、Runner 调度器后台任务）。
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .core.config import settings
from .core.database import close_db, init_db
from .routes import agent_scenario, agent_session, approval, audit, governance, registry


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await init_db()
    # TODO(M1): 初始化 Redis 路由表 / Runner 健康检查后台任务 / 空闲会话回收协程(1800s)
    yield
    await close_db()


app = FastAPI(
    title="AgentHarness Forge · Control Plane",
    version="0.1.0",
    docs_url="/docs",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# TODO(M1): SSO(OIDC) 登录态中间件 + 全接口 RBAC 依赖注入

app.include_router(agent_scenario.router, prefix="/api/agent-scenarios", tags=["scenario"])
app.include_router(agent_session.router, prefix="/api/agent/sessions", tags=["session"])
app.include_router(approval.router, prefix="/api/agent/approvals", tags=["approval"])
app.include_router(audit.router, prefix="/api/audit", tags=["audit"])
app.include_router(registry.router, prefix="/api/registry", tags=["registry"])
app.include_router(governance.router, prefix="/api/governance", tags=["governance"])


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "forge-control-plane"}
