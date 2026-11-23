"""业务会话：不可变场景/策略/模型快照、后台执行、持久化消息与可重连事件。"""

import asyncio
import logging
from dataclasses import asdict
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy import select, func
from ..core.config import settings
from ..core.database import SessionFactory
from ..core.security import encrypt, decrypt
from ..models.agent_session import AgentSession, AgentSessionModel, SessionEventIndex
from ..models.platform import PlatformSetting, SessionMessage
from ..models.approval_ticket import ApprovalTicket
from ..schemas.agent_scenario import ScenarioPayload
from .file_service import file_service
from .live_stream import TRANSIENT_KINDS, live_hub
from .runner_client import (
    JOURNAL_RESET,
    RunnerEventsUnavailable,
    SkillContentRequired,
    ensure_session,
    journal_seq,
    runner_client,
)
from .scenario_service import scenario_service, iso
from .scenario_assembler import Bundle, apply_current_policy
from .plugin_service import ensure_bindings_available
from . import capability_service
from .capability_service import CapabilityChoice, selection_of
from .settings_service import environment_ref, resolve_session_connection
from .space_service import PUBLIC_SPACE_ID, effective_policy, is_visible, space_brief, space_map

log = logging.getLogger(__name__)


def model_ref(segment: AgentSessionModel | None, row=None) -> dict:
    """写入消息 meta 的模型标识；没有分段的旧会话回退到创建时的 Bundle 快照。"""
    if segment is not None:
        return {
            "modelId": segment.connection_id,
            "model": segment.model,
            "modelName": segment.name or segment.model,
        }
    meta = row.bundle_snapshot.get("meta", {}) if row is not None else {}
    model = meta.get("model", "")
    if not model:
        return {}
    return {
        "modelId": meta.get("modelConnectionId"),
        "model": model,
        "modelName": meta.get("modelName") or model,
    }


def segment_view(segment: AgentSessionModel) -> dict:
    priced = segment.input_price is not None and segment.output_price is not None
    return {
        "id": segment.connection_id,
        "name": segment.name or segment.model,
        "model": segment.model,
        "contextWindow": segment.context_window,
        "inputPrice": segment.input_price,
        "outputPrice": segment.output_price,
        "fromMessageId": segment.from_message_id,
        "tokensIn": segment.tokens_in,
        "tokensOut": segment.tokens_out,
        "cost": segment.cost if priced else None,
    }


def segment_from_connection(session_id: int, config: dict, from_message_id: int | None = None):
    return AgentSessionModel(
        session_id=session_id,
        from_message_id=from_message_id,
        connection_id=config["id"],
        name=config["name"],
        model=config["model"],
        base_url=config["baseUrl"],
        context_window=config["contextWindow"],
        credential=encrypt(config.get("apiKey", "")),
        input_price=config.get("inputPrice"),
        output_price=config.get("outputPrice"),
    )


def runtime_config(segment: AgentSessionModel) -> dict:
    """交给 Runner 的本轮运行配置：只含执行所需字段。"""
    return {
        "baseUrl": segment.base_url,
        "model": segment.model,
        "contextWindow": segment.context_window,
        "apiKey": decrypt(segment.credential or ""),
    }


MAX_CODE_PROJECTS = 20


def normalize_code_projects(names) -> list[str]:
    """校验会话选择的代码项目名：只能是代码根目录下的一级目录名，去重前就拒绝重复，最多 20 个。"""
    if not isinstance(names, list):
        raise HTTPException(422, "关联代码必须是项目名列表")
    if len(names) > MAX_CODE_PROJECTS:
        raise HTTPException(422, f"一个会话最多关联 {MAX_CODE_PROJECTS} 个代码项目")
    for name in names:
        if (
            not isinstance(name, str)
            or not name
            or len(name) > 200
            or name in (".", "..")
            or name.startswith(".")
            or any(char in name for char in "/\\\0")
            or not name.isprintable()
        ):
            raise HTTPException(422, f"代码项目不存在：{str(name)[:200]}")
    if len(set(names)) != len(names):
        raise HTTPException(422, "关联代码中有重复项目")
    return list(names)


async def ensure_code_projects_exist(names: list[str], previous: list[str]):
    """新加入的项目必须真实存在于代码根目录（由 Runner 列举）；已关联的不重复检查，Runner 执行前还会整体校验。"""
    added = [name for name in names if name not in previous]
    if not added:
        return
    listing = await runner_client.code_projects()
    available = {project["name"] for project in listing.get("projects", [])}
    missing = [name for name in added if name not in available]
    if missing:
        raise HTTPException(422, f"代码项目不存在：{'、'.join(missing)}")


async def current_segments(db, session_ids) -> dict[int, AgentSessionModel]:
    """批量读取各会话的当前模型分段（最新一段），避免会话列表逐条查询。"""
    if not session_ids:
        return {}
    rows = (
        await db.scalars(
            select(AgentSessionModel)
            .where(AgentSessionModel.session_id.in_(list(session_ids)))
            .order_by(AgentSessionModel.id)
        )
    ).all()
    return {segment.session_id: segment for segment in rows}


class SessionService:
    def __init__(self):
        self.tasks: dict[int, asyncio.Task] = {}
        self.locks: dict[int, asyncio.Lock] = {}
        # 控制面正在停止：后台任务被取消时不中止 Runner 上的回合（重启后对账接回）
        self.stopping = False

    async def row(self, db, session_id):
        row = await db.get(AgentSession, session_id)
        if not row:
            raise HTTPException(404, "会话不存在")
        return row

    def view(
        self,
        row,
        segment: AgentSessionModel | None = None,
        last_active: datetime | None = None,
        spaces: dict | None = None,
    ):
        meta = row.bundle_snapshot.get("meta", {})
        current = model_ref(segment, row)
        space_key = getattr(row, "space_id", None) or PUBLIC_SPACE_ID
        return {
            "id": row.id,
            "sessionId": row.id,
            "title": row.title,
            "scenarioId": row.scenario_id,
            "scenarioVersion": row.scenario_version,
            "scenarioName": meta.get("scenarioName", "场景"),
            "bundleHash": row.bundle_hash,
            "status": row.status,
            "tokensIn": row.tokens_in,
            "tokensOut": row.tokens_out,
            "cost": row.cost if row.cost_known else None,
            "createdAt": iso(row.created_at),
            # 最近活动：最后一条消息的时间，没有消息时为创建时间（侧栏「最近会话」按它排序）
            "lastActiveAt": iso(last_active or row.created_at),
            # 当前模型取最新分段（会话内可切换）；旧会话回退到创建时快照，缺失的配置 ID 为 None。
            "model": current.get("model", ""),
            "modelId": current.get("modelId"),
            "modelName": current.get("modelName", ""),
            "modelContextWindow": segment.context_window if segment else None,
            "isTest": meta.get("isTest", False),
            "codeProjects": list(row.code_projects or []),
            # 聊天临时选择的扩展能力（与场景绑定取并集）
            "capabilities": selection_of(row.capability_selection),
            # 所属空间：打开别的空间的会话链接时前端自动切换；「我的会话 · 全部空间」显示空间列
            "spaceId": space_key,
            "spaceInfo": (spaces or {}).get(space_key) or space_brief(None),
            "scenarioCapabilities": {
                "skills": [
                    {key: ref.get(key) for key in ("id", "title", "name", "version")}
                    for ref in meta.get("skills") or []
                ],
                "mcpServers": list(meta.get("mcpServers") or []),
                "webSearch": bool(meta.get("webSearch")),
            },
        }

    async def create(self, scenario_id, *, model_id=None, is_test=False, space_id=None):
        async with SessionFactory() as db:
            scenario = await scenario_service.row(db, scenario_id)
            # 会话所在空间：发起时的当前空间（场景须在本空间或公共）；否则跟随场景所在空间
            scenario_space = scenario.space_id or PUBLIC_SPACE_ID
            session_space = (
                space_id if space_id is not None and is_visible(scenario_space, space_id) else scenario_space
            )
            # 模型属于本次会话，与场景无关：显式选择优先，否则使用平台默认模型。
            config = await resolve_session_connection(db, model_id)
            chosen_version = (
                scenario.current_version
                if is_test
                else scenario.published_version or scenario.current_version
            )
            version = await scenario_service.version(db, scenario, chosen_version)
            payload = ScenarioPayload.model_validate(version.bundle_json["payload"])
            stored_bundle = version.bundle_json.get("bundle")
            # 执行策略按会话所在空间收紧：空间关闭的基础工具从 allowedTools 中去掉（只能收紧）
            current_policy = await effective_policy(db, session_space)
            if stored_bundle:
                # Scenario versions freeze requested capabilities; current governance remains a ceiling
                # for new sessions. Existing sessions keep their already-materialized Bundle snapshot.
                bundle = apply_current_policy(Bundle.from_dict(stored_bundle), current_policy)
            else:
                # 兼容早期版本；新场景发布后始终使用版本内的不可变能力快照。
                bundle = await scenario_service.assembler.compile(
                    db, payload, tenant_policy=current_policy, rendered_prompt=payload.prompt_template
                )
            await ensure_bindings_available(db, list(bundle.meta.get("pluginBindings", [])))
            bundle.meta.update(
                {
                    "model": config["model"],
                    "modelName": config["name"],
                    "modelConnectionId": config["id"],
                    "isTest": is_test,
                    "modelRevision": config.get("revision", ""),
                    "environmentRef": await environment_ref(db),
                    "inputPrice": config.get("inputPrice"),
                    "outputPrice": config.get("outputPrice"),
                    "scenarioDescription": payload.description,
                    "scenarioIcon": payload.icon,
                }
            )
            row = AgentSession(
                tenant_id="sandbox",
                space_id=session_space,
                user_id=settings.admin_username,
                scenario_id=scenario.id,
                scenario_version=chosen_version,
                bundle_hash=bundle.bundle_hash,
                bundle_snapshot=asdict(bundle),
                status="idle",
            )
            db.add(row)
            await db.flush()
            # 首个模型分段冻结执行连接。密钥仅存加密值，不进入可导出的 Bundle。
            segment = segment_from_connection(row.id, config)
            db.add(segment)
            await db.commit()
            await db.refresh(row)
            return self.view(row, segment, spaces=await space_map(db))

    async def list(self, *, include_tests=False, include_archived=False, space_id=None):
        """会话列表；传入 space_id 时只列这个空间的会话（会话不显示公共空间的）。"""
        async with SessionFactory() as db:
            query = select(AgentSession).order_by(AgentSession.id.desc()).limit(150)
            if not include_archived:
                query = query.where(AgentSession.status != "archived")
            if space_id is not None:
                query = query.where(AgentSession.space_id == space_id)
            rows = (await db.scalars(query)).all()
            ids = [row.id for row in rows]
            segments = await current_segments(db, ids)
            last_active = {}
            if ids:
                latest = await db.execute(
                    select(SessionMessage.session_id, func.max(SessionMessage.created_at))
                    .where(SessionMessage.session_id.in_(ids))
                    .group_by(SessionMessage.session_id)
                )
                last_active = dict(latest.all())
            spaces = await space_map(db)
            return [
                self.view(row, segments.get(row.id), last_active.get(row.id), spaces)
                for row in rows
                if include_tests or not row.bundle_snapshot.get("meta", {}).get("isTest")
            ]

    async def status(self, session_id):
        async with SessionFactory() as db:
            return (await self.row(db, session_id)).status

    async def detail(self, session_id):
        async with SessionFactory() as db:
            row = await self.row(db, session_id)
            messages = (
                await db.scalars(
                    select(SessionMessage)
                    .where(SessionMessage.session_id == session_id)
                    .order_by(SessionMessage.id)
                )
            ).all()
            approvals = (
                await db.scalars(
                    select(ApprovalTicket).where(
                        ApprovalTicket.session_id == session_id, ApprovalTicket.status == "pending"
                    )
                )
            ).all()
            cursor = (
                await db.scalar(
                    select(func.max(SessionEventIndex.seq)).where(SessionEventIndex.session_id == session_id)
                )
                or 0
            )
            segments = (
                await db.scalars(
                    select(AgentSessionModel)
                    .where(AgentSessionModel.session_id == session_id)
                    .order_by(AgentSessionModel.id)
                )
            ).all()
            # 底层轨迹事件数：聊天页只显示数量，完整内容在执行轨迹页查看
            trajectory_count = await db.scalar(
                select(func.count())
                .select_from(SessionEventIndex)
                .where(SessionEventIndex.session_id == session_id, SessionEventIndex.kind == "trajectory")
            )
            # 最近一次模型请求的输入 tokens ≈ 当前上下文规模，用于切换到较小窗口模型前的提醒。
            last_usage = await db.scalar(
                select(SessionEventIndex.attrs)
                .where(SessionEventIndex.session_id == session_id, SessionEventIndex.kind == "cost_tick")
                .order_by(SessionEventIndex.seq.desc())
                .limit(1)
            )
            return {
                **self.view(row, segments[-1] if segments else None, spaces=await space_map(db)),
                "bundle": row.bundle_snapshot,
                "lastEventSeq": cursor,
                "trajectoryEventCount": trajectory_count or 0,
                "models": [segment_view(segment) for segment in segments],
                "contextTokens": (last_usage or {}).get("tokensIn", 0),
                "messages": [
                    {
                        "id": message.id,
                        "role": message.role,
                        "content": message.content,
                        "meta": message.meta,
                        "createdAt": iso(message.created_at),
                    }
                    for message in messages
                ],
                "pendingApprovals": [
                    {
                        "ticketId": ticket.id,
                        "tool": ticket.tool,
                        "arguments": ticket.decision_payload.get("arguments", ticket.args_digest),
                        "status": ticket.status,
                    }
                    for ticket in approvals
                ],
            }

    async def _current_segment(self, db, row) -> AgentSessionModel | None:
        """当前模型分段；第二期之前创建的旧会话按原快照补建第一段（仅首次）。"""
        segment = await db.scalar(
            select(AgentSessionModel)
            .where(AgentSessionModel.session_id == row.id)
            .order_by(AgentSessionModel.id.desc())
            .limit(1)
        )
        if segment:
            return segment
        saved = await db.get(PlatformSetting, f"session-model:{row.id}")
        if not saved or not saved.value.get("baseUrl") or not saved.value.get("model"):
            return None
        meta = row.bundle_snapshot.get("meta", {})
        segment = AgentSessionModel(
            session_id=row.id,
            connection_id=saved.value.get("connectionId", meta.get("modelConnectionId")),
            name=saved.value.get("name") or meta.get("modelName") or saved.value["model"],
            model=saved.value["model"],
            base_url=saved.value["baseUrl"],
            context_window=saved.value.get("contextWindow") or 64000,
            credential=saved.value.get("credential", ""),
            input_price=meta.get("inputPrice"),
            output_price=meta.get("outputPrice"),
        )
        db.add(segment)
        await db.flush()
        return segment

    async def start(
        self,
        session_id,
        message,
        *,
        model_id=None,
        code_projects=None,
        capabilities: CapabilityChoice | None = None,
    ):
        if not message.strip():
            raise HTTPException(422, "任务内容不能为空")
        lock = self.locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            # 执行中不能提交新一轮，也就不能切换模型：模型只在两轮之间变化。
            if session_id in self.tasks and not self.tasks[session_id].done():
                raise HTTPException(409, "本会话正在执行，请等待或中止后再提交")
            async with SessionFactory() as db:
                row = await self.row(db, session_id)
                if row.status == "archived":
                    raise HTTPException(409, "此会话已归档")
                previous = await self._current_segment(db, row)
                if not previous:
                    raise HTTPException(409, "此会话没有完整的模型快照，请新建会话")
                # 本轮随消息提交的关联代码（不传则沿用会话已保存的选择）；先校验，失败时不留下任何记录
                if code_projects is not None:
                    selected = normalize_code_projects(code_projects)
                    await ensure_code_projects_exist(selected, list(row.code_projects or []))
                    row.code_projects = selected
                code = list(row.code_projects or [])
                # 本轮随消息提交的临时能力（不传沿用已保存的选择）
                if capabilities is not None:
                    # 聊天中加入的 Skill / MCP 只能来自会话所在空间和公共空间
                    row.capability_selection = await capability_service.validate_choice(
                        db, capabilities, selection_of(row.capability_selection), space_id=row.space_id
                    )
                selection = selection_of(row.capability_selection)
                runtime_caps, active_caps = await capability_service.resolve(
                    db, row.bundle_snapshot.get("meta", {}), selection
                )
                segment = previous
                if model_id is not None and model_id != previous.connection_id:
                    # 切换目标必须存在且已启用（404 / 409）；沿用当前模型则不受其后启停影响。
                    config = await resolve_session_connection(db, model_id)
                    segment = segment_from_connection(session_id, config)
                runtime = runtime_config(segment)
                if row.runner_session_id:
                    # Runner 重启后按会话快照重新装配，从磁盘会话日志接续完整上下文（dsh session/resume）
                    async def ensure(caps):
                        return await ensure_session(
                            runner_client,
                            row.runner_session_id,
                            row.bundle_snapshot,
                            runtime,
                            code,
                            caps,
                        )

                    try:
                        try:
                            restored = await ensure(runtime_caps)
                        except SkillContentRequired as missing:
                            # 重启后的 Runner 没有 Skill 缓存：补发全文后重试恢复
                            restored = await ensure(
                                await capability_service.expand_skills(db, runtime_caps, missing.snapshots)
                            )
                        if restored:
                            # 恢复后的会话已持有全部内容，本轮执行只需快照引用
                            runtime_caps = capability_service.as_refs(runtime_caps)
                    except HTTPException as error:
                        if error.status_code in (404, 410):
                            raise HTTPException(
                                409,
                                f"执行上下文无法恢复（{error.detail}），请新建会话；历史消息、轨迹和本地产物仍可查看",
                            ) from error
                        raise
                else:

                    async def create(caps):
                        return await runner_client.create_session(row.bundle_snapshot, runtime, code, caps)

                    try:
                        handle = await create(runtime_caps)
                    except SkillContentRequired as missing:
                        # Runner 没有部分 Skill 快照（重启或缓存淘汰）：补发这些 Skill 的全文，重试一次
                        handle = await create(
                            await capability_service.expand_skills(db, runtime_caps, missing.snapshots)
                        )
                    # 新建的 Runner 会话已持有全部内容，本轮执行只需快照引用
                    runtime_caps = capability_service.as_refs(runtime_caps)
                    row.runner_session_id, row.runner_id = handle["sessionId"], "local-runner"
                    row.workspace_uri = "session://" + handle["sessionId"]
                cursor = (
                    await db.scalar(
                        select(func.max(SessionEventIndex.seq)).where(
                            SessionEventIndex.session_id == session_id
                        )
                    )
                    or 0
                )
                user = SessionMessage(session_id=session_id, role="user", content=message)
                db.add(user)
                await db.flush()
                switch = None
                if segment is not previous:
                    segment.from_message_id = user.id
                    db.add(segment)
                    await db.flush()
                    switch = {
                        "messageId": user.id,
                        "from": {
                            "id": previous.connection_id,
                            "name": previous.name,
                            "model": previous.model,
                        },
                        "to": {"id": segment.connection_id, "name": segment.name, "model": segment.model},
                    }
                # 用户消息记录本轮模型；切换轮额外记录来源，供聊天页渲染切换分隔线。
                user.meta = {
                    **model_ref(segment),
                    **({"modelSwitch": switch} if switch else {}),
                    # 本轮可读取的代码项目，供历史消息回溯
                    **({"codeProjects": code} if code else {}),
                    # 本轮生效的扩展能力摘要（不含正文与凭据），供历史消息回溯；
                    # 全部未生效时也要记录，聊天页据此在「能力」面板标记未生效项
                    **(
                        {"capabilities": active_caps}
                        if not capability_service.summary_is_empty(active_caps)
                        or active_caps.get("unavailable")
                        else {}
                    ),
                }
                pump_cursor = cursor
                if switch:
                    pump_cursor += 1
                    db.add(
                        SessionEventIndex(
                            session_id=session_id,
                            seq=pump_cursor,
                            source="system",
                            kind="model_switched",
                            attrs={**switch, "contextWindow": segment.context_window},
                        )
                    )
                if row.title == "新会话":
                    row.title = message.strip().split("\n")[0][:50]
                row.status = "running"
                await db.commit()
                await db.refresh(user)
                runner_id = row.runner_session_id
                turn = {"segmentId": segment.id, "ref": model_ref(segment), "messageId": user.id}
                current = segment_view(segment)
            self._spawn(
                session_id,
                self.pump(session_id, runner_id, message, pump_cursor, runtime, turn, code, runtime_caps),
            )
            # 返回切换事件之前的游标，客户端订阅时会收到 model_switched。
            return {
                "sessionId": session_id,
                "messageId": user.id,
                "cursor": cursor,
                "messageMeta": user.meta,
                "model": current,
                "codeProjects": code,
                "capabilities": selection,
                "activeCapabilities": active_caps,
            }

    @staticmethod
    async def runner_events(runner_id, message, runtime, code_projects, capabilities, since=None):
        """提交一轮并转发 Runner 事件。Skill 通常只带快照引用；Runner 缺少内容时（提交即返回 409，
        尚未产生任何事件）补发这些 Skill 的全文并重试一次。since 见 RunnerClient.events。"""
        try:
            async for event in runner_client.events(
                runner_id, message, runtime, code_projects, capabilities, since=since
            ):
                yield event
            return
        except SkillContentRequired as missing:
            async with SessionFactory() as db:
                capabilities = await capability_service.expand_skills(db, capabilities, missing.snapshots)
        async for event in runner_client.events(
            runner_id, message, runtime, code_projects, capabilities, since=since
        ):
            yield event

    async def pump(
        self, session_id, runner_id, message, cursor, runtime, turn, code_projects=None, capabilities=None
    ):
        """提交一轮并把事件落库。turn 为本轮模型分段：回复署名与计费都以它为准。"""
        # 轮前文件快照：本轮结束时与之对比得到改动记录（旧会话先补一次同步，避免把已有文件算作新增）。
        baseline = None
        try:
            async with SessionFactory() as db:
                await file_service.ensure_synced(await self.row(db, session_id), runner_client)
            baseline = await file_service.snapshot(session_id)
        except Exception:  # 文件记录失败不影响执行
            log.warning("会话 %s 的轮前文件快照失败", session_id, exc_info=True)
        async with SessionFactory() as db:
            since = (await self.row(db, session_id)).runner_event_seq or 0

        def events():
            # 每轮下发完整的关联代码列表（空列表表示不关联），Runner 与数据库始终一致
            return self.runner_events(
                runner_id,
                message,
                runtime,
                list(code_projects or []),
                capabilities or {"skills": [], "mcp": [], "web": None},
                since,
            )

        await self._consume(session_id, runner_id, cursor, turn, events, baseline=baseline, announce=True)

    async def reattach(self, session_id, runner_id, cursor, turn, after, lost_message, turn_id=None):
        """接回控制面重启前的回合：从已落库的位置续读 Runner 执行日志。

        回合仍在执行时继续跟随到结束；已结束则补齐未落库的事件（回复、用量、审批记录）；
        Runner 也重启过、回合没有结束标记时，补齐已有事件后以 lost_message 标记中断。
        """
        await self._consume(
            session_id,
            runner_id,
            cursor,
            turn,
            lambda: runner_client.follow(runner_id, after, turn_id=turn_id),
            baseline=None,
            announce=False,
            lost_message=lost_message,
        )

    async def _consume(
        self,
        session_id,
        runner_id,
        cursor,
        turn,
        events,
        *,
        baseline,
        announce,
        lost_message="执行内核事件流提前结束，任务未正常完成",
    ):
        """转发一轮执行事件并落库：按 Runner 序号去重，结束后回执，Runner 据此清理执行日志。

        流式片段（transient）与 Runner 一致不落库，只经 live_hub 推送给正在查看的页面；
        持久事件提交后同样经 live_hub 按顺序推送。
        """
        failed, got_done, detached, partial, partial_reasoning = False, False, False, "", ""
        async with SessionFactory() as db:
            seen = (await self.row(db, session_id)).runner_event_seq or 0

        async def persist(kind, payload, source="system", runner_seq=None):
            nonlocal cursor
            cursor += 1
            seq = cursor
            async with SessionFactory() as db:
                row = await self.row(db, session_id)
                # 与事件同一事务记录续读位置：落库与位置要么都成功、要么都不生效
                if runner_seq is not None and runner_seq > (row.runner_event_seq or 0):
                    row.runner_event_seq = runner_seq
                if kind == "approval_required":
                    ticket = ApprovalTicket(
                        session_id=session_id,
                        tool_call_id=payload["ticketId"],
                        tool=payload["tool"],
                        args_digest=str(payload.get("arguments", {}))[:4096],
                        status="pending",
                        decision_payload={
                            "runnerTicketId": payload["ticketId"],
                            "arguments": payload.get("arguments", {}),
                        },
                    )
                    db.add(ticket)
                    await db.flush()
                    payload = {**payload, "ticketId": ticket.id}
                elif kind == "approval_resolved":
                    ticket = await db.scalar(
                        select(ApprovalTicket).where(
                            ApprovalTicket.session_id == session_id,
                            ApprovalTicket.tool_call_id == str(payload.get("ticketId", "")),
                        )
                    )
                    if ticket:
                        ticket.status = {
                            "approve": "approved",
                            "deny": "denied",
                            "timeout": "timeout",
                            "cancelled": "cancelled",
                        }.get(payload.get("action"), "denied")
                        ticket.decided_at = datetime.now(timezone.utc)
                        payload = {**payload, "ticketId": ticket.id}
                elif kind == "tool_result":
                    db.add(
                        SessionMessage(
                            session_id=session_id,
                            role="tool",
                            content=payload.get("result", ""),
                            meta=payload,
                        )
                    )
                elif kind == "message":
                    db.add(
                        SessionMessage(
                            session_id=session_id,
                            role="assistant",
                            content=payload.get("text", ""),
                            meta={
                                "runtimeMessageId": payload.get("runtimeMessageId"),
                                "partial": payload.get("partial", False),
                                # 每条回复记录生成它的模型（会话内可切换，需逐条追溯）。
                                **turn["ref"],
                                **({"reasoning": payload["reasoning"]} if payload.get("reasoning") else {}),
                            },
                        )
                    )
                elif kind == "cost_tick":
                    tokens_in, tokens_out = payload.get("tokensIn", 0), payload.get("tokensOut", 0)
                    had_usage = row.tokens_in + row.tokens_out > 0
                    row.tokens_in += tokens_in
                    row.tokens_out += tokens_out
                    # 按本轮模型分段的单价计费：切换模型后新单价只作用于之后的用量。
                    segment = await db.get(AgentSessionModel, turn["segmentId"])
                    segment.tokens_in += tokens_in
                    segment.tokens_out += tokens_out
                    if tokens_in or tokens_out:
                        if segment.input_price is not None and segment.output_price is not None:
                            amount = (
                                tokens_in * segment.input_price + tokens_out * segment.output_price
                            ) / 1000000
                            segment.cost += amount
                            row.cost += amount
                            # 只有全部用量都有单价时，会话费用才是完整的。
                            row.cost_known = row.cost_known or not had_usage
                        else:
                            row.cost_known = False
                    payload = {
                        **payload,
                        "totalTokensIn": row.tokens_in,
                        "totalTokensOut": row.tokens_out,
                        "cost": row.cost if row.cost_known else None,
                    }
                elif kind == "done":
                    row.status = "error" if failed or payload.get("status") == "error" else "idle"
                    row.ended_at = datetime.now(timezone.utc)
                db.add(
                    SessionEventIndex(session_id=session_id, seq=seq, source=source, kind=kind, attrs=payload)
                )
                await db.commit()
            live_hub.publish(
                session_id,
                {
                    "seq": seq,
                    "source": source,
                    "kind": kind,
                    "payload": payload,
                    "ts": iso(datetime.now(timezone.utc)),
                },
            )

        live_hub.begin(session_id, cursor)
        try:
            if announce:
                await persist("session", {"sessionId": session_id, "workspaceUri": "session://" + runner_id})
            async for event in events():
                kind, payload = event["kind"], event.get("payload") or {}
                if kind == JOURNAL_RESET:
                    seen = int(payload.get("after") or 0)
                    log.warning("会话 %s 的 Runner 执行日志已重置，续读位置退回 %s", session_id, seen)
                    async with SessionFactory() as db:
                        (await self.row(db, session_id)).runner_event_seq = seen
                        await db.commit()
                    continue
                seq = journal_seq(event)
                if seq is not None:
                    if seq <= seen:
                        continue  # 断线续读或对账时重复收到的事件：已落库
                    seen = seq
                if kind == "files":
                    # 先同步再发布事件：客户端收到事件后刷新清单时即可看到新文件
                    try:
                        await file_service.sync(session_id, runner_id, runner_client)
                    except Exception:
                        log.warning("会话 %s 的文件同步失败", session_id, exc_info=True)
                if kind in TRANSIENT_KINDS:
                    # 流式片段只累计（中断时保留为部分输出）并推送，不落库
                    text = str(payload.get("text") or "")
                    if kind == "message_delta":
                        partial += text
                    else:
                        partial_reasoning += text
                    live_hub.delta(session_id, kind, text, event.get("source", "llm"))
                    continue
                if kind == "error":
                    failed = True
                elif kind == "message":
                    partial = ""
                    partial_reasoning = ""
                elif kind == "done":
                    got_done = True
                    failed = failed or payload.get("status") == "error"
                    continue  # 所有消息/审批落库后，再发布最终状态。
                await persist(kind, payload, event.get("source", "system"), seq)
            if not got_done:
                failed = True
                await persist("error", {"message": lost_message})
        except asyncio.CancelledError:
            if self.stopping:
                # 控制面停止：回合归 Runner 所有，继续执行到底；重启后对账从已落库的位置补齐，这里什么都不结算
                detached = True
                raise
            failed = True
            try:
                await runner_client.call("POST", f"/v1/sessions/{runner_id}/interrupt")
            except Exception:
                pass
            await persist("error", {"message": "任务已中止"})
        except Exception as error:
            failed = True
            if isinstance(error, RunnerEventsUnavailable):
                text = lost_message
            else:
                text = error.detail if isinstance(error, HTTPException) else str(error)
            await persist("error", {"message": text[:600] or "执行连接中断，请稍后重试"})
        finally:
            try:
                if not detached:
                    await self._finish_turn(
                        session_id,
                        runner_id,
                        turn,
                        baseline,
                        failed,
                        partial,
                        partial_reasoning,
                        persist,
                        seen,
                    )
                    await runner_client.ack(runner_id, seen)
            finally:
                live_hub.end(session_id)

    async def _finish_turn(
        self, session_id, runner_id, turn, baseline, failed, partial, partial_reasoning, persist, seen
    ):
        """结算一轮：保留未结算的部分输出、取消遗留审批、记录文件改动，最后发布 done。

        seen 为本轮处理到的 Runner 序号（含 Runner 的 done）：随最终状态一起记录。
        """
        if partial or partial_reasoning:
            meta = {"partial": True, **turn["ref"]}
            if partial_reasoning:
                meta["reasoning"] = partial_reasoning
            async with SessionFactory() as db:
                db.add(SessionMessage(session_id=session_id, role="assistant", content=partial, meta=meta))
                await db.commit()
        async with SessionFactory() as db:
            pending = (
                await db.scalars(
                    select(ApprovalTicket.tool_call_id).where(
                        ApprovalTicket.session_id == session_id, ApprovalTicket.status == "pending"
                    )
                )
            ).all()
        for ticket_id in pending:
            await persist("approval_resolved", {"ticketId": ticket_id, "action": "cancelled"}, "tools")
        if turn.get("messageId"):
            try:
                if baseline is not None:
                    summary = await file_service.finish_turn(
                        session_id, runner_id, turn["messageId"], baseline, runner_client
                    )
                    if summary:
                        await persist("workspace_changes", summary, "tools")
                else:
                    # 接回的回合没有轮前快照：只同步文件清单
                    await file_service.sync(session_id, runner_id, runner_client)
            except Exception:
                log.warning("会话 %s 的本轮文件改动记录失败", session_id, exc_info=True)
        await persist("done", {"status": "error" if failed else "idle"}, runner_seq=seen)

    async def events(self, session_id, after=0, source=None, limit=1000, kinds=None):
        """按序号读取已落库的事件；kinds 只读取这些类型（聊天页不需要底层轨迹与旧版落库的流式片段）。"""
        async with SessionFactory() as db:
            await self.row(db, session_id)
            query = select(SessionEventIndex).where(
                SessionEventIndex.session_id == session_id, SessionEventIndex.seq > after
            )
            if source:
                query = query.where(SessionEventIndex.source == source)
            if kinds:
                query = query.where(SessionEventIndex.kind.in_(kinds))
            rows = (await db.scalars(query.order_by(SessionEventIndex.seq).limit(limit))).all()
            return [
                {
                    "seq": row.seq,
                    "source": row.source,
                    "kind": row.kind,
                    "payload": row.attrs,
                    "ts": iso(row.created_at),
                }
                for row in rows
            ]

    async def all_events(self, session_id):
        result, cursor = [], 0
        while True:
            page = await self.events(session_id, cursor, limit=2000)
            if not page:
                return result
            result.extend(page)
            cursor = page[-1]["seq"]

    async def interrupt(self, session_id):
        async with SessionFactory() as db:
            row = await self.row(db, session_id)
            if row.runner_session_id:
                try:
                    await runner_client.call("POST", f"/v1/sessions/{row.runner_session_id}/interrupt")
                except HTTPException as error:
                    if error.status_code != 404:
                        raise
        task = self.tasks.get(session_id)
        if task and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), 5)
            except TimeoutError:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def archive(self, session_id):
        if session_id in self.tasks and not self.tasks[session_id].done():
            raise HTTPException(409, "请先中止运行中的会话")
        async with SessionFactory() as db:
            row = await self.row(db, session_id)
            if row.runner_session_id:
                try:
                    await runner_client.call("DELETE", f"/v1/sessions/{row.runner_session_id}")
                except HTTPException as error:
                    if error.status_code != 404:
                        raise
            row.status = "archived"
            await db.commit()

    async def test_scenario(self, scenario_id):
        created = await self.create(scenario_id, is_test=True)
        session_id, failure_message = created["id"], ""
        try:
            await self.start(session_id, "请用一小段话说明你在此场景中如何帮助用户。不需要调用工具。")
            task = self.tasks.get(session_id)
            if task:
                await task
        except HTTPException as error:
            failure_message = str(error.detail)
        detail = await self.detail(session_id)
        ok = (
            not failure_message
            and detail["status"] == "idle"
            and any(
                message["role"] == "assistant" and message["content"].strip()
                for message in detail["messages"]
            )
        )
        async with SessionFactory() as db:
            key = f"scenario-test:{scenario_id}:{created['scenarioVersion']}"
            record = await db.get(PlatformSetting, key)
            value = {
                "ok": ok,
                "sessionId": session_id,
                "at": datetime.now(timezone.utc).isoformat(),
                "environmentRef": detail["bundle"]["meta"]["environmentRef"],
            }
            if record:
                record.value = value
            else:
                db.add(PlatformSetting(key=key, value=value))
            await db.commit()
        await self.archive(session_id)
        return {
            "ok": ok,
            "sessionId": session_id,
            "summary": "当前版本已通过模型试运行"
            if ok
            else failure_message or "模型试运行失败，请查看该次执行轨迹",
        }

    def _spawn(self, session_id, coroutine):
        """登记会话的后台执行任务：同一会话同时只有一个，结束后自动移除。"""
        task = asyncio.create_task(coroutine)
        self.tasks[session_id] = task
        task.add_done_callback(
            lambda done: self.tasks.pop(session_id, None) if self.tasks.get(session_id) is done else None
        )
        return task

    async def reconcile(self):
        """控制面启动对账：回合归 Runner 所有，先问 Runner 再决定怎么处理上次停止时未结束的会话。

        - Runner 上仍在执行：从已落库的位置接回，继续跟随到结束；
        - 已在 Runner 上结束（或 Runner 也重启过）：补录执行日志里未落库的回复、用量与审批记录后结算；
        - Runner 不可达或没有快照：取消遗留审批、标记中断（下次提问时从已落库的位置补齐）。
        """
        lost = "控制面重启，未完成的任务已标记中断；可继续发送消息，上下文会保留"
        async with SessionFactory() as db:
            active = (await db.scalars(select(AgentSession).where(AgentSession.status == "running"))).all()
            resumed: set[int] = set()
            for row in active:
                if not row.runner_session_id:
                    continue
                try:
                    state = await runner_client.session_state(row.runner_session_id)
                except HTTPException:
                    continue  # Runner 不可达
                segment = await self._current_segment(db, row)
                message = await db.scalar(
                    select(SessionMessage)
                    .where(SessionMessage.session_id == row.id, SessionMessage.role == "user")
                    .order_by(SessionMessage.id.desc())
                    .limit(1)
                )
                if not segment or not message:
                    continue
                cursor = (
                    await db.scalar(
                        select(func.max(SessionEventIndex.seq)).where(SessionEventIndex.session_id == row.id)
                    )
                    or 0
                )
                turn = {"segmentId": segment.id, "ref": model_ref(segment), "messageId": message.id}
                running = bool(state and state.get("turnActive"))
                self._spawn(
                    row.id,
                    self.reattach(
                        row.id,
                        row.runner_session_id,
                        cursor,
                        turn,
                        row.runner_event_seq or 0,
                        lost,
                        turn_id=state.get("turnId") if running else None,
                    ),
                )
                resumed.add(row.id)
                log.info(
                    "会话 %s %s", row.id, "已接回 Runner 上执行中的回合" if running else "正在补录执行日志"
                )
            await self._interrupt_leftovers(
                db, [row for row in active if row.id not in resumed], resumed, lost
            )

    async def _interrupt_leftovers(self, db, rows, resumed, message):
        """无法接回的会话：取消遗留审批并留下明确的中断记录。"""
        pending = (await db.scalars(select(ApprovalTicket).where(ApprovalTicket.status == "pending"))).all()
        pending = [ticket for ticket in pending if ticket.session_id not in resumed]
        affected = {row.id for row in rows} | {ticket.session_id for ticket in pending}
        now = datetime.now(timezone.utc)
        for session_id in affected:
            cursor = (
                await db.scalar(
                    select(func.max(SessionEventIndex.seq)).where(SessionEventIndex.session_id == session_id)
                )
                or 0
            )

            def append(kind, payload, source="system", session_id=session_id):
                nonlocal cursor
                cursor += 1
                db.add(
                    SessionEventIndex(
                        session_id=session_id, seq=cursor, kind=kind, source=source, attrs=payload
                    )
                )

            for ticket in (ticket for ticket in pending if ticket.session_id == session_id):
                ticket.status, ticket.decided_at = "cancelled", now
                append(
                    "approval_resolved",
                    {"ticketId": ticket.id, "action": "cancelled", "reason": "控制面重启"},
                    "tools",
                )
            for row in (row for row in rows if row.id == session_id):
                row.status, row.ended_at = "interrupted", now
                append("error", {"message": message})
                append("done", {"status": "error", "reason": "control-plane-restart"})
        await db.commit()

    async def shutdown(self):
        self.stopping = True
        active = [task for task in self.tasks.values() if not task.done()]
        for task in active:
            task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)


session_service = SessionService()
