"""回合归属在 Runner：按执行日志序号续读、去重、回执，以及控制面重启后的对账（接回 / 补录 / 标记中断）。"""

import asyncio
import json

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select
from test_session_switch import FakeRunner, env, fake_crypto, turn  # noqa: F401

from src.api.models.agent_session import AgentSession, SessionEventIndex
from src.api.models.platform import SessionMessage
from src.api.services import runner_client as client_module
from src.api.services import session_service as session_module
from src.api.services.runner_client import RunnerClient, RunnerEventsUnavailable


def durable(seq, kind, payload, source="system", **extra):
    return {"seq": seq, "kind": kind, "payload": payload, "source": source, **extra}


class JournalRunner(FakeRunner):
    """按脚本回放带序号的事件；follow 用于控制面重启后的接回与补录。"""

    def __init__(self):
        super().__init__()
        self.script: list[dict] = []
        self.since: list[int | None] = []
        self.followed: list[tuple[str, int, str | None]] = []
        self.backlog: list[dict] | Exception = []
        self.state: dict | None | Exception = None
        self.interrupted: list[str] = []

    async def call(self, method, path, _body=None):
        if path.endswith("/interrupt"):
            self.interrupted.append(path)
            return {"ok": True}
        return await super().call(method, path, _body)

    async def events(
        self, runner_id, message, model_config=None, code_projects=None, capabilities=None, *, since=None
    ):
        self.since.append(since)
        self.turns.append((runner_id, message, model_config))
        for event in self.script:
            yield event

    async def session_state(self, runner_id):
        if isinstance(self.state, Exception):
            raise self.state
        return self.state

    async def follow(self, runner_id, after=0, turn_id=None):
        self.followed.append((runner_id, after, turn_id))
        if isinstance(self.backlog, Exception):
            raise self.backlog
        for event in self.backlog:
            if event.get("seq", 0) > after or event.get("transient"):
                yield event


@pytest.fixture
def runner(env, monkeypatch):  # noqa: F811
    fake = JournalRunner()
    monkeypatch.setattr(session_module, "runner_client", fake)
    return fake


async def kinds(sessions, session_id):
    async with sessions() as db:
        rows = await db.scalars(
            select(SessionEventIndex)
            .where(SessionEventIndex.session_id == session_id)
            .order_by(SessionEventIndex.seq)
        )
        return [row.kind for row in rows]


async def session_row(sessions, session_id):
    async with sessions() as db:
        return await db.get(AgentSession, session_id)


@pytest.mark.asyncio
async def test_events_are_persisted_once_by_runner_seq_and_acknowledged(env, runner):  # noqa: F811
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    message = durable(1, "message", {"text": "答复", "runtimeMessageId": "m"}, "llm")
    runner.script = [
        {"seq": 0, "kind": "message_delta", "payload": {"text": "答"}, "transient": True},
        message,
        dict(message),  # 断线续读重复收到的持久事件
        durable(2, "cost_tick", {"tokensIn": 10, "tokensOut": 2}, "llm"),
        durable(3, "done", {"status": "idle", "turnId": "t1"}),
    ]
    await turn(service, session["id"], "第一轮")

    # 流式片段与 Runner 一致不落库（只经实时通道推送）
    assert await kinds(env["sessions"], session["id"]) == [
        "session",
        "message",
        "cost_tick",
        "done",
    ]
    async with env["sessions"]() as db:
        replies = (
            await db.scalars(
                select(SessionMessage).where(
                    SessionMessage.session_id == session["id"], SessionMessage.role == "assistant"
                )
            )
        ).all()
    assert [reply.content for reply in replies] == ["答复"]
    row = await session_row(env["sessions"], session["id"])
    assert row.runner_event_seq == 3 and row.tokens_in == 10 and row.status == "idle"
    assert runner.acks == [(row.runner_session_id, 3)]

    # 下一轮把已落库的位置交给 Runner：漏掉的事件会先被补齐
    runner.script = [durable(4, "done", {"status": "idle", "turnId": "t2"})]
    await turn(service, session["id"], "第二轮")
    assert runner.since == [0, 3]


@pytest.mark.asyncio
async def test_journal_reset_moves_the_position_back_instead_of_dropping_new_events(env, runner):  # noqa: F811
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    async with env["sessions"]() as db:
        row = await db.get(AgentSession, session["id"])
        row.runner_event_seq = 50
        await db.commit()
    runner.script = [
        {"kind": client_module.JOURNAL_RESET, "payload": {"after": 0}},
        durable(1, "message", {"text": "新事件", "runtimeMessageId": "m"}, "llm"),
        durable(2, "done", {"status": "idle"}),
    ]
    await turn(service, session["id"], "继续")
    assert "message" in await kinds(env["sessions"], session["id"])
    assert (await session_row(env["sessions"], session["id"])).runner_event_seq == 2


@pytest.mark.asyncio
async def test_control_plane_shutdown_leaves_the_runner_turn_running(env, runner):  # noqa: F811
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    started = asyncio.Event()

    async def hold(*_args, **_kwargs):
        yield durable(1, "message", {"text": "进行中", "runtimeMessageId": "m"}, "llm")
        started.set()
        await asyncio.Event().wait()

    runner.events = hold
    await service.start(session["id"], "长任务")
    await started.wait()
    await asyncio.sleep(0)
    await service.shutdown()

    row = await session_row(env["sessions"], session["id"])
    # 不中止 Runner、不结算：保持运行中，并记住已落库的位置，重启后从这里接回
    assert runner.interrupted == [] and runner.acks == []
    assert row.status == "running" and row.runner_event_seq == 1
    assert "done" not in await kinds(env["sessions"], session["id"])


async def interrupted_session(env, service, runner):  # noqa: F811
    """一个停在执行中的会话：已落库到 seq 1，状态仍是 running（模拟控制面在回合中途停止）。"""
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    runner.script = [durable(1, "message", {"text": "前半", "runtimeMessageId": "m1"}, "llm")]
    await turn(service, session["id"], "任务")
    async with env["sessions"]() as db:
        row = await db.get(AgentSession, session["id"])
        row.status, row.runner_event_seq = "running", 1
        await db.commit()
    return session["id"], row.runner_session_id


@pytest.mark.asyncio
async def test_reconcile_reattaches_a_turn_still_running_on_the_runner(env, runner):  # noqa: F811
    service = session_module.SessionService()
    session_id, runner_id = await interrupted_session(env, service, runner)
    runner.state = {"exists": True, "turnActive": True, "turnId": "t9", "lastSeq": 1}
    runner.backlog = [
        durable(1, "message", {"text": "前半", "runtimeMessageId": "m1"}, "llm"),
        durable(2, "message", {"text": "后半", "runtimeMessageId": "m2"}, "llm"),
        durable(3, "cost_tick", {"tokensIn": 5, "tokensOut": 1}, "llm"),
        durable(4, "done", {"status": "idle", "turnId": "t9"}),
    ]
    await service.reconcile()
    await service.tasks[session_id]

    assert runner.followed == [(runner_id, 1, "t9")]
    row = await session_row(env["sessions"], session_id)
    assert row.status == "idle" and row.runner_event_seq == 4
    async with env["sessions"]() as db:
        texts = (
            await db.scalars(
                select(SessionMessage.content).where(
                    SessionMessage.session_id == session_id, SessionMessage.role == "assistant"
                )
            )
        ).all()
    assert texts.count("后半") == 1 and texts.count("前半") == 1


@pytest.mark.asyncio
async def test_reconcile_backfills_and_marks_a_turn_lost_with_the_runner(env, runner):  # noqa: F811
    service = session_module.SessionService()
    session_id, _ = await interrupted_session(env, service, runner)
    # Runner 也重启过：会话不在内存中，执行日志里只有崩溃前的事件，没有结束标记
    runner.state = None
    runner.backlog = [durable(2, "cost_tick", {"tokensIn": 7, "tokensOut": 3}, "llm")]
    await service.reconcile()
    await service.tasks[session_id]

    row = await session_row(env["sessions"], session_id)
    assert row.status == "error" and row.tokens_in >= 7
    events = await kinds(env["sessions"], session_id)
    assert events[-3:] == ["cost_tick", "error", "done"]


@pytest.mark.asyncio
async def test_reconcile_without_a_journal_or_runner_marks_the_session_interrupted(env, runner):  # noqa: F811
    service = session_module.SessionService()
    first, _ = await interrupted_session(env, service, runner)
    runner.state = None
    runner.backlog = RunnerEventsUnavailable(404, "执行日志不存在")
    await service.reconcile()
    await service.tasks[first]
    assert (await session_row(env["sessions"], first)).status == "error"

    second, _ = await interrupted_session(env, service, runner)
    runner.state = HTTPException(503, "执行内核暂不可用")
    await service.reconcile()
    row = await session_row(env["sessions"], second)
    assert row.status == "interrupted" and second not in service.tasks
    assert (await kinds(env["sessions"], second))[-2:] == ["error", "done"]


def sse(*events):
    return "".join(f"data: {json.dumps(event)}\n\n" for event in events)


@pytest.mark.asyncio
async def test_follow_resumes_after_a_dropped_connection_without_duplicates(monkeypatch):
    requests = []

    class Dropping(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield sse(durable(1, "message", {"text": "a"})).encode()
            raise httpx.ReadError("connection dropped")

    def handler(request: httpx.Request):
        after = int(request.url.params["after"])
        requests.append(after)
        if len(requests) == 1:
            return httpx.Response(200, stream=Dropping())
        return httpx.Response(
            200,
            text=": ping\n\n"
            + sse(
                durable(2, "done", {"status": "idle", "turnId": "old"}),
                durable(3, "message", {"text": "b"}),
                {"seq": 3, "kind": "message_delta", "payload": {"text": "c"}, "transient": True},
                durable(4, "done", {"status": "idle", "turnId": "t1"}),
            ),
        )

    client = RunnerClient()
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        client, "client", lambda **_: httpx.AsyncClient(base_url="http://runner", transport=transport)
    )
    monkeypatch.setattr(client_module, "retry_delay", lambda _attempt: 0)
    events = [event async for event in client.follow("s1", 0, turn_id="t1")]

    assert requests == [0, 1]
    # 上一轮的结束标记不转发；增量原样转发；只在本轮的 done 处结束
    assert [(event["seq"], event["kind"]) for event in events] == [
        (1, "message"),
        (3, "message"),
        (3, "message_delta"),
        (4, "done"),
    ]


@pytest.mark.asyncio
async def test_follow_gives_up_after_repeated_failures(monkeypatch):
    def handler(_request):
        raise httpx.ConnectError("runner down")

    client = RunnerClient()
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        client, "client", lambda **_: httpx.AsyncClient(base_url="http://runner", transport=transport)
    )
    monkeypatch.setattr(client_module, "retry_delay", lambda _attempt: 0)
    with pytest.raises(RuntimeError, match="多次重连失败"):
        [event async for event in client.follow("s1", 0)]
