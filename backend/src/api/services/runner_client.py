"""RunnerClient：控制面 → Runner 的唯一协议出口（ADR-1 防火墙的一侧）。

Runner 暴露 AgentKernel HTTP 契约（契约本体在 runner/src/kernel/types.ts，
两侧手工对齐，P1 起用 OpenAPI codegen 单源化）。
"""

import httpx

from ..core.config import settings


class RunnerClient:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=120.0))

    def _endpoint_for(self, session_id: int | None) -> str:
        # TODO(M1): session_id -> Redis 路由表查 runner；新会话按隔离档+占用率选择
        return settings.runner_endpoint_list[0]

    async def create_session(self, bundle: dict, user_ctx: dict) -> dict:
        """下发不可变 Bundle；Runner 验签 + hydrate。"""
        async with httpx.AsyncClient(base_url=self._endpoint_for(None)) as c:
            r = await c.post("/v1/sessions", json={"bundle": bundle, "userCtx": user_ctx})
            r.raise_for_status()
            return r.json()

    async def send_turn(self, runner_id: str, session_id: str, message: str, opts: dict) -> dict:
        async with httpx.AsyncClient(base_url=self._endpoint_for(None)) as c:
            r = await c.post(f"/v1/sessions/{session_id}/turns", json={"message": message, **opts})
            r.raise_for_status()
            return r.json()

    async def interrupt(self, session_id: str) -> None: ...            # TODO(M1)
    async def fork(self, session_id: str, at_seq: int) -> dict: ...    # TODO(M1)
    async def replay(self, session_id: str) -> dict: ...               # TODO(M1)
    async def resolve_approval(self, session_id: str, ticket: str, decision: dict) -> None: ...
    async def get_trajectory(self, session_id: str, source: str | None, cursor: int) -> dict: ...


runner_client = RunnerClient()
