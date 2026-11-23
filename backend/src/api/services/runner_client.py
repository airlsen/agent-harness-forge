"""控制面唯一执行出口。内部 Token 不向浏览器下发。"""

import asyncio
import json
import logging
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException
from pydantic import ValidationError

from ..core.config import settings
from ..core.manifest import manifest_from_bundle

SKILL_CONTENT_REQUIRED = "SKILL_CONTENT_REQUIRED"
# 控制面内部标记（不落库）：Runner 执行日志已重置，续读位置退回 payload.after
JOURNAL_RESET = "journal_reset"
# 事件流断线后的自动续读次数（有进展即重置）
FOLLOW_RETRIES = 5
log = logging.getLogger(__name__)


def retry_delay(attempt: int) -> float:
    """第 attempt 次重连前的等待秒数（指数退避，最长 8 秒）。"""
    return min(8, 0.5 * 2 ** (attempt - 1))


def journal_seq(event: dict) -> int | None:
    """持久事件的执行日志序号；流式增量（transient）与没有序号的事件返回 None。"""
    seq = event.get("seq")
    if event.get("transient") or not isinstance(seq, int) or isinstance(seq, bool):
        return None
    return seq


class RunnerEventsUnavailable(RuntimeError):
    """Runner 无法提供执行事件（会话与执行日志都不存在等）：status 为 Runner 返回的 HTTP 状态码。"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


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

    def _session_body(self, bundle, model_config, code_projects, capabilities) -> dict:
        """创建 / 恢复执行会话的请求体：Bundle 快照只下发其清单投影（SessionManifest）。"""
        try:
            manifest = manifest_from_bundle(bundle)
        except ValidationError as error:
            log.warning("会话装配快照不完整：%s", error)
            raise HTTPException(409, "会话装配快照不完整，无法下发执行内核，请新建会话") from error
        return {
            "manifest": manifest,
            "modelConfig": model_config,
            "codeProjects": list(code_projects or []),
            **({"codeRoot": self.code_root} if self.code_root else {}),
            # 扩展能力含 MCP 凭据与联网密钥：只随请求下发，不进入清单与快照
            "capabilities": capabilities or {"skills": [], "mcp": [], "web": None},
        }

    async def create_session(self, bundle, model_config, code_projects=None, capabilities=None):
        return await self.call(
            "POST", "/v1/sessions", self._session_body(bundle, model_config, code_projects, capabilities)
        )

    async def restore_session(
        self, runner_session_id, bundle, model_config, code_projects=None, capabilities=None
    ):
        """以原 id 重新装配执行会话：Runner 重启后从磁盘会话日志接续上下文（404 日志缺失 / 410 无法恢复），
        会话仍在内存中时替换为新配置、下一轮重启接续。"""
        return await self.call(
            "POST",
            f"/v1/sessions/{runner_session_id}/restore",
            self._session_body(bundle, model_config, code_projects, capabilities),
        )

    async def code_projects(self, root: str | None = None):
        """代码目录下可关联的项目；目录由 Runner 读取，控制面不接触代码。传 root 时只检查该目录，不改变设置。"""
        query = urlencode({"root": self.code_root if root is None else root})
        return await self.call("GET", f"/v1/code/projects?{query}")

    async def submit_turn(
        self,
        runner_session_id: str,
        message: str,
        model_config: dict | None = None,
        code_projects: list[str] | None = None,
        capabilities: dict | None = None,
    ) -> dict:
        """提交一轮，立即返回 {turnId, after}：回合由 Runner 执行到底，与本连接无关。

        每轮都下发当前模型配置、关联代码与扩展能力：Runner 比对后，任一变化都以新配置重启并接续会话。
        Skill 通常只带快照引用；Runner 缺内容时抛出 SkillContentRequired（此时尚未产生任何事件）。
        """
        body = {
            "message": message,
            **({"modelConfig": model_config} if model_config else {}),
            **({"codeProjects": list(code_projects)} if code_projects is not None else {}),
            **({"codeRoot": self.code_root} if self.code_root else {}),
            **({"capabilities": capabilities} if capabilities is not None else {}),
        }
        try:
            return await self.call("POST", f"/v1/sessions/{runner_session_id}/turns", body)
        except SkillContentRequired:
            raise
        except HTTPException as error:
            # 与旧的流式接口保持一致：提交失败以 RuntimeError 交给调用方写入错误事件
            raise RuntimeError(str(error.detail)) from error

    async def follow(self, runner_session_id: str, after: int = 0, turn_id: str | None = None):
        """订阅执行日志中 after 之后的事件，直到本轮结束（done）或 Runner 没有进行中的回合。

        turn_id：只在这一轮的 done 处结束；从更早的位置补读时，途经的其他回合的 done 不转发。

        连接中断时用最后收到的 seq 自动续读（有进展即重置重试次数）：持久事件不丢不重，
        断线期间的流式增量会缺失，由随后的完整 message 兜底。Runner 重启后会话尚未恢复时，
        Runner 直接返回磁盘日志中的积压后关闭，调用方据此判断回合是否完整结束。
        """
        attempts = 0
        while True:
            try:
                async with self.client(stream=True) as client:
                    async with client.stream(
                        "GET", f"/v1/sessions/{runner_session_id}/events", params={"after": after}
                    ) as response:
                        if response.status_code != 200:
                            await response.aread()
                            try:
                                error = response.json().get("message", "执行事件读取失败")
                            except ValueError:
                                error = "执行事件读取失败"
                            raise RunnerEventsUnavailable(response.status_code, error)
                        async for line in response.aiter_lines():
                            if not line.startswith("data: "):
                                continue  # 心跳与空行
                            event = json.loads(line[6:])
                            if (seq := journal_seq(event)) is not None:
                                after = max(after, seq)
                                attempts = 0
                            if event.get("kind") == "done":
                                done_turn = (event.get("payload") or {}).get("turnId")
                                if turn_id and done_turn and done_turn != turn_id:
                                    continue  # 补读途经的上一轮结束标记
                                yield event
                                return
                            yield event
                return  # Runner 正常关闭：没有进行中的回合，积压已全部收到
            except httpx.HTTPError as error:
                attempts += 1
                if attempts > FOLLOW_RETRIES:
                    raise RuntimeError("与执行内核的连接中断，多次重连失败") from error
                await asyncio.sleep(retry_delay(attempts))

    async def events(
        self,
        runner_session_id: str,
        message: str,
        model_config: dict | None = None,
        code_projects: list[str] | None = None,
        capabilities: dict | None = None,
        *,
        since: int | None = None,
    ):
        """提交一轮并订阅它的事件直到本轮结束（断线自动续读）。

        since：调用方已落库的执行日志位置。早于本轮起点时从 since 补读，先补齐此前漏掉的事件
        （例如控制面重启时 Runner 不可达、上一轮未能对账），再进入本轮。
        """
        accepted = await self.submit_turn(
            runner_session_id, message, model_config, code_projects, capabilities
        )
        after = int(accepted.get("after") or 0)
        if since is not None and since > after:
            # Runner 的执行日志比已落库的位置还短（日志被清理过）：通知调用方把续读位置退回，
            # 否则之后的新事件会被当作重复事件丢弃
            yield {"kind": JOURNAL_RESET, "payload": {"after": after}}
        elif since is not None and since < after:
            after = since
        async for event in self.follow(runner_session_id, after, turn_id=accepted.get("turnId")):
            yield event

    async def ack(self, runner_session_id: str, seq: int):
        """回执：seq 及之前的事件已落库，Runner 可从执行日志中移除。失败不影响业务（下次回执会覆盖）。"""
        if seq <= 0:
            return
        try:
            await self.call("POST", f"/v1/sessions/{runner_session_id}/events/ack", {"seq": seq})
        except HTTPException:
            log.warning("执行日志回执失败：%s@%s", runner_session_id, seq)

    async def session_state(self, runner_session_id: str) -> dict | None:
        """Runner 上的会话状态（turnActive / lastSeq）；会话不在 Runner 内存中时返回 None。"""
        try:
            return await self.call("GET", f"/v1/sessions/{runner_session_id}")
        except HTTPException as error:
            if error.status_code == 404:
                return None
            raise


async def ensure_session(
    client,
    runner_session_id,
    bundle,
    model_config,
    code_projects=None,
    capabilities=None,
    expected_policy_ref=None,
) -> bool:
    """确保执行会话可用：仍在 Runner 内存中直接返回 False；Runner 重启过则按快照从会话日志恢复并返回 True。
    日志缺失或无法恢复时抛出 Runner 的 404 / 410，由调用方决定降级方式。"""
    try:
        state = await client.call("GET", f"/v1/sessions/{runner_session_id}")
        if not expected_policy_ref or state.get("policyRef") == expected_policy_ref:
            return False
    except HTTPException as error:
        if error.status_code != 404:
            raise
    await client.restore_session(runner_session_id, bundle, model_config, code_projects, capabilities)
    return True


runner_client = RunnerClient()
