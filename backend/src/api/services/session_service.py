"""业务会话：不可变场景/策略/模型快照、后台执行、持久化消息与可重连事件。"""

import asyncio
from dataclasses import asdict
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy import select, func
from ..core.config import settings
from ..core.database import SessionFactory
from ..core.security import encrypt, decrypt
from ..models.agent_session import AgentSession, SessionEventIndex
from ..models.platform import PlatformSetting, SessionMessage
from ..models.approval_ticket import ApprovalTicket
from ..schemas.agent_scenario import ScenarioPayload
from .runner_client import runner_client
from .scenario_service import scenario_service, iso
from .scenario_assembler import Bundle
from .plugin_service import ensure_bindings_available
from .settings_service import get_connection, get_policy, environment_ref


class SessionService:
    def __init__(self):
        self.tasks: dict[int, asyncio.Task] = {}
        self.locks: dict[int, asyncio.Lock] = {}

    async def row(self, db, session_id):
        row = await db.get(AgentSession, session_id)
        if not row:
            raise HTTPException(404, "会话不存在")
        return row

    def view(self, row):
        meta = row.bundle_snapshot.get("meta", {})
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
            "model": meta.get("model", ""),
            "isTest": meta.get("isTest", False),
        }

    async def create(self, scenario_id, *, is_test=False):
        async with SessionFactory() as db:
            scenario = await scenario_service.row(db, scenario_id)
            config = await get_connection(db, secret=True)
            if not config["configured"]:
                raise HTTPException(409, "没有已启用的模型配置，请先到模型管理启用至少一个模型")
            version = await scenario_service.version(db, scenario)
            payload = ScenarioPayload.model_validate(version.bundle_json["payload"])
            stored_bundle = version.bundle_json.get("bundle")
            if stored_bundle:
                bundle = Bundle(**stored_bundle)
            else:
                # 兼容早期版本；新场景发布后始终使用版本内的不可变装配快照。
                bundle = await scenario_service.assembler.compile(
                    db, payload, tenant_policy=await get_policy(db), rendered_prompt=payload.prompt_template
                )
            await ensure_bindings_available(db, list(bundle.meta.get("pluginBindings", [])))
            bundle.meta.update(
                {
                    "model": config["model"],
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
                user_id=settings.admin_username,
                scenario_id=scenario.id,
                scenario_version=scenario.current_version,
                bundle_hash=bundle.bundle_hash,
                bundle_snapshot=asdict(bundle),
                status="idle",
            )
            db.add(row)
            await db.flush()
            # 执行连接同样锁定。密钥仅存独立加密记录，不进入可导出的 Bundle。
            snapshot = {key: config[key] for key in ("baseUrl", "model", "contextWindow")}
            snapshot["credential"] = encrypt(config.get("apiKey", ""))
            db.add(PlatformSetting(key=f"session-model:{row.id}", value=snapshot))
            await db.commit()
            await db.refresh(row)
            return self.view(row)

    async def list(self, *, include_tests=False, include_archived=False):
        async with SessionFactory() as db:
            query = select(AgentSession).order_by(AgentSession.id.desc()).limit(150)
            if not include_archived:
                query = query.where(AgentSession.status != "archived")
            rows = (await db.scalars(query)).all()
            return [
                self.view(row)
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
            return {
                **self.view(row),
                "bundle": row.bundle_snapshot,
                "lastEventSeq": cursor,
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

    async def start(self, session_id, message):
        if not message.strip():
            raise HTTPException(422, "任务内容不能为空")
        lock = self.locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            if session_id in self.tasks and not self.tasks[session_id].done():
                raise HTTPException(409, "本会话正在执行，请等待或中止后再提交")
            async with SessionFactory() as db:
                row = await self.row(db, session_id)
                if row.status == "archived":
                    raise HTTPException(409, "此会话已归档")
                saved = await db.get(PlatformSetting, f"session-model:{session_id}")
                if not saved:
                    raise HTTPException(409, "此会话没有完整的模型快照，请新建会话")
                config = {key: value for key, value in saved.value.items() if key != "credential"}
                config["apiKey"] = decrypt(saved.value.get("credential", ""))
                if row.runner_session_id:
                    try:
                        await runner_client.call("GET", f"/v1/sessions/{row.runner_session_id}")
                    except HTTPException as error:
                        if error.status_code == 404:
                            raise HTTPException(
                                409, "执行内核已重启，请新建会话；历史消息、轨迹和本地产物仍可查看"
                            ) from error
                        raise
                else:
                    handle = await runner_client.create_session(
                        row.bundle_snapshot,
                        {
                            "tenantId": "sandbox",
                            "userId": settings.admin_username,
                            "roles": ["workspace-admin"],
                        },
                        config,
                    )
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
                if row.title == "新会话":
                    row.title = message.strip().split("\n")[0][:50]
                row.status = "running"
                await db.commit()
                await db.refresh(user)
                runner_id = row.runner_session_id
            task = asyncio.create_task(self.pump(session_id, runner_id, message, cursor))
            self.tasks[session_id] = task
            task.add_done_callback(
                lambda done: self.tasks.pop(session_id, None) if self.tasks.get(session_id) is done else None
            )
            return {"sessionId": session_id, "messageId": user.id, "cursor": cursor}

    async def pump(self, session_id, runner_id, message, cursor):
        failed, got_done, partial = False, False, ""

        async def persist(kind, payload, source="system"):
            nonlocal cursor
            cursor += 1
            async with SessionFactory() as db:
                row = await self.row(db, session_id)
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
                            content=payload["text"],
                            meta={
                                "runtimeMessageId": payload.get("runtimeMessageId"),
                                "partial": payload.get("partial", False),
                            },
                        )
                    )
                elif kind == "cost_tick":
                    row.tokens_in += payload.get("tokensIn", 0)
                    row.tokens_out += payload.get("tokensOut", 0)
                    meta = row.bundle_snapshot.get("meta", {})
                    if meta.get("inputPrice") is not None and meta.get("outputPrice") is not None:
                        row.cost_known = True
                        row.cost += (
                            payload.get("tokensIn", 0) * meta["inputPrice"]
                            + payload.get("tokensOut", 0) * meta["outputPrice"]
                        ) / 1000000
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
                    SessionEventIndex(
                        session_id=session_id, seq=cursor, source=source, kind=kind, attrs=payload
                    )
                )
                await db.commit()

        try:
            await persist("session", {"sessionId": session_id, "workspaceUri": "session://" + runner_id})
            async for event in runner_client.events(runner_id, message):
                kind, payload = event["kind"], event.get("payload") or {}
                if kind == "error":
                    failed = True
                elif kind == "message_delta":
                    partial += payload.get("text", "")
                elif kind == "message":
                    partial = ""
                elif kind == "done":
                    got_done = True
                    failed = failed or payload.get("status") == "error"
                    continue  # 所有消息/审批落库后，再发布最终状态。
                await persist(kind, payload, event.get("source", "system"))
            if not got_done:
                failed = True
                await persist("error", {"message": "执行内核事件流提前结束，任务未正常完成"})
        except asyncio.CancelledError:
            failed = True
            try:
                await runner_client.call("POST", f"/v1/sessions/{runner_id}/interrupt")
            except Exception:
                pass
            await persist("error", {"message": "控制面停止，任务已中止"})
        except Exception as error:
            failed = True
            text = error.detail if isinstance(error, HTTPException) else str(error)
            await persist("error", {"message": text[:600] or "执行连接中断，请稍后重试"})
        finally:
            if partial:
                async with SessionFactory() as db:
                    db.add(
                        SessionMessage(
                            session_id=session_id, role="assistant", content=partial, meta={"partial": True}
                        )
                    )
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
            await persist("done", {"status": "error" if failed else "idle"})

    async def events(self, session_id, after=0, source=None, limit=1000):
        async with SessionFactory() as db:
            await self.row(db, session_id)
            query = select(SessionEventIndex).where(
                SessionEventIndex.session_id == session_id, SessionEventIndex.seq > after
            )
            if source:
                query = query.where(SessionEventIndex.source == source)
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

    async def shutdown(self):
        active = [task for task in self.tasks.values() if not task.done()]
        for task in active:
            task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)


session_service = SessionService()
