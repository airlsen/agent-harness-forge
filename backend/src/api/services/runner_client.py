"""控制面唯一执行出口。内部 Token 不向浏览器下发。"""

import json
import httpx
from fastapi import HTTPException
from ..core.config import settings


class RunnerClient:
    def client(self, *, stream=False):
        return httpx.AsyncClient(
            base_url=settings.runner_endpoint_list[0],
            headers={"Authorization": "Bearer " + settings.runner_token},
            timeout=httpx.Timeout(40, read=660 if stream else 40),
            trust_env=False,
        )

    async def call(self, method, path, body=None):
        try:
            async with self.client() as client:
                response = await client.request(method, path, json=body)
                if response.status_code >= 400:
                    try:
                        message = response.json().get("message", "Runner 请求失败")
                    except ValueError:
                        message = "Runner 请求失败"
                    raise HTTPException(response.status_code if response.status_code < 500 else 502, message)
                return response.json()
        except httpx.HTTPError as error:
            raise HTTPException(503, "执行内核暂不可用，请稍后重试") from error

    async def health(self):
        try:
            return await self.call("GET", "/v1/runtime")
        except HTTPException:
            return {"status": "offline"}

    async def create_session(self, bundle, user_ctx, model_config):
        return await self.call(
            "POST", "/v1/sessions", {"bundle": bundle, "userCtx": user_ctx, "modelConfig": model_config}
        )

    async def events(self, runner_session_id: str, message: str, model_config: dict | None = None):
        # 每轮都下发当前模型配置：Runner 比对指纹，不同（会话内切换）则以新配置重启并接续会话。
        body = {"message": message, **({"modelConfig": model_config} if model_config else {})}
        async with self.client(stream=True) as client:
            async with client.stream(
                "POST", f"/v1/sessions/{runner_session_id}/stream", json=body
            ) as response:
                if response.status_code != 200:
                    await response.aread()
                    try:
                        error = response.json().get("message", "执行请求失败")
                    except ValueError:
                        error = "执行请求失败"
                    raise RuntimeError(error)
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        yield json.loads(line[6:])


runner_client = RunnerClient()
