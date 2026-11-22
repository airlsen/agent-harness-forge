"""控制面唯一执行出口。内部 Token 不向浏览器下发。"""

import json
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException
from ..core.config import settings

SKILL_CONTENT_REQUIRED = "SKILL_CONTENT_REQUIRED"


class SkillContentRequired(HTTPException):
    """Runner 没有某些 Skill 快照的内容（重启或缓存淘汰）：调用方补发这些 Skill 的全文后重试一次。

    补发后仍缺（不应发生）时不再重试，按 502 报告给用户。
    """

    def __init__(self, snapshots: list[str]):
        super().__init__(502, "执行内核缺少 Skill 内容，请重新发送消息")
        self.snapshots = snapshots


def missing_skills(response: httpx.Response) -> list[str] | None:
    if response.status_code != 409:
        return None
    try:
        body = response.json()
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    snapshots = body.get("missingSkills")
    if body.get("code") != SKILL_CONTENT_REQUIRED or not isinstance(snapshots, list):
        return None
    return [item for item in snapshots if isinstance(item, str)]


class RunnerClient:
    # 执行策略中设置的关联代码目录（空 = Runner 的 FORGE_CODE_ROOT）；启动时从数据库加载，保存时更新，随请求下发
    code_root = ""

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
                if (snapshots := missing_skills(response)) is not None:
                    raise SkillContentRequired(snapshots)
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
                **({"codeRoot": self.code_root} if self.code_root else {}),
                # 扩展能力含 MCP 凭据与联网密钥：只随请求下发，不进入 Bundle
                "capabilities": capabilities or {"skills": [], "mcp": [], "web": None},
            },
        )

    async def restore_session(
        self, runner_session_id, bundle, user_ctx, model_config, code_projects=None, capabilities=None
    ):
        """以原 id 重新装配执行会话：Runner 重启后从磁盘会话日志接续上下文（404 日志缺失 / 410 无法恢复），
        会话仍在内存中时替换为新配置、下一轮重启接续。"""
        return await self.call(
            "POST",
            f"/v1/sessions/{runner_session_id}/restore",
            {
                "bundle": bundle,
                "userCtx": user_ctx,
                "modelConfig": model_config,
                "codeProjects": list(code_projects or []),
                **({"codeRoot": self.code_root} if self.code_root else {}),
                "capabilities": capabilities or {"skills": [], "mcp": [], "web": None},
            },
        )

    async def code_projects(self, root: str | None = None):
        """代码目录下可关联的项目；目录由 Runner 读取，控制面不接触代码。传 root 时只检查该目录，不改变设置。"""
        query = urlencode({"root": self.code_root if root is None else root})
        return await self.call("GET", f"/v1/code/projects?{query}")

    async def events(
        self,
        runner_session_id: str,
        message: str,
        model_config: dict | None = None,
        code_projects: list[str] | None = None,
        capabilities: dict | None = None,
    ):
        # 每轮都下发当前模型配置、关联代码与扩展能力：Runner 比对后，任一变化都以新配置重启并接续会话。
        # Skill 通常只带快照引用；Runner 缺内容时抛出 SkillContentRequired（在产生任何事件之前）。
        body = {
            "message": message,
            **({"modelConfig": model_config} if model_config else {}),
            **({"codeProjects": list(code_projects)} if code_projects is not None else {}),
            **({"codeRoot": self.code_root} if self.code_root else {}),
            **({"capabilities": capabilities} if capabilities is not None else {}),
        }
        async with self.client(stream=True) as client:
            async with client.stream(
                "POST", f"/v1/sessions/{runner_session_id}/stream", json=body
            ) as response:
                if response.status_code != 200:
                    await response.aread()
                    if (snapshots := missing_skills(response)) is not None:
                        raise SkillContentRequired(snapshots)
                    try:
                        error = response.json().get("message", "执行请求失败")
                    except ValueError:
                        error = "执行请求失败"
                    raise RuntimeError(error)
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        yield json.loads(line[6:])


async def ensure_session(
    client, runner_session_id, bundle, user_ctx, model_config, code_projects=None, capabilities=None
) -> bool:
    """确保执行会话可用：仍在 Runner 内存中直接返回 False；Runner 重启过则按快照从会话日志恢复并返回 True。
    日志缺失或无法恢复时抛出 Runner 的 404 / 410，由调用方决定降级方式。"""
    try:
        await client.call("GET", f"/v1/sessions/{runner_session_id}")
        return False
    except HTTPException as error:
        if error.status_code != 404:
            raise
    await client.restore_session(
        runner_session_id, bundle, user_ctx, model_config, code_projects, capabilities
    )
    return True


runner_client = RunnerClient()
