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

    async def raw(self, path):
        """读取工作区文件原始字节，返回 (内容, MIME)。工作区总量有上限，整体读入内存即可。"""
        try:
            async with self.client() as client:
                response = await client.get(path)
                if response.status_code >= 400:
                    try:
                        message = response.json().get("message", "文件读取失败")
                    except ValueError:
                        message = "文件读取失败"
                    raise HTTPException(response.status_code if response.status_code < 500 else 502, message)
                return response.content, response.headers.get("content-type", "application/octet-stream")
        except httpx.HTTPError as error:
            raise HTTPException(503, "执行内核暂不可用，请稍后重试") from error

    async def health(self):
        try:
            return await self.call("GET", "/v1/runtime")
        except HTTPException:
            return {"status": "offline"}

    async def create_session(self, bundle, user_ctx, model_config, code_projects=None, capabilities=None):
        return await self.call(
            "POST",
            "/v1/sessions",
            {
                "bundle": bundle,
                "userCtx": user_ctx,
                "modelConfig": model_config,
                "codeProjects": list(code_projects or []),
                # 扩展能力含 MCP 凭据与联网密钥：只随请求下发，不进入 Bundle
                "capabilities": capabilities or {"skills": [], "mcp": [], "web": None},
            },
        )

    async def code_projects(self):
        """代码根目录（Runner 的 FORGE_CODE_ROOT）下可关联的项目；目录由 Runner 读取，控制面不接触代码。"""
        return await self.call("GET", "/v1/code/projects")

    async def events(
        self,
        runner_session_id: str,
        message: str,
        model_config: dict | None = None,
        code_projects: list[str] | None = None,
        capabilities: dict | None = None,
    ):
        # 每轮都下发当前模型配置、关联代码与扩展能力：Runner 比对后，任一变化都以新配置重启并接续会话。
        body = {
            "message": message,
            **({"modelConfig": model_config} if model_config else {}),
            **({"codeProjects": list(code_projects)} if code_projects is not None else {}),
            **({"capabilities": capabilities} if capabilities is not None else {}),
        }
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
