"""流式片段不落库、只经实时通道推送：订阅快照、按到达顺序推送、页面中途打开时的补齐与结束。"""

import asyncio
import json

import pytest
from sqlalchemy import select
from test_session_journal import durable, runner  # noqa: F401
from test_session_switch import env, fake_crypto  # noqa: F401

from src.api.models.agent_session import SessionEventIndex
from src.api.models.platform import SessionMessage
from src.api.routes import agent_session as routes
from src.api.services import live_stream
from src.api.services import session_service as session_module
from src.api.services.live_stream import END, LiveHub, coalesce


def delta(text, kind="message_delta"):
    return {"seq": 0, "kind": kind, "payload": {"text": text}, "transient": True}


def test_hub_snapshot_order_and_end():
    hub = LiveHub()
    assert hub.subscribe(1) is None  # 没有进行中的回合：调用方回退为读库
    hub.begin(1, 5)
    hub.delta(1, "reasoning_delta", "想")
    hub.delta(1, "message_delta", "答")
    early = hub.subscribe(1)
    assert (early.text, early.reasoning, early.seq) == ("答", "想", 5)
    hub.delta(1, "message_delta", "复")
    hub.publish(1, {"seq": 6, "kind": "message", "source": "llm", "payload": {"text": "答复"}})
    late = hub.subscribe(1)
    # 回复结算后尚未结算的正文与思考清空，快照位置推进到该回复
    assert (late.text, late.reasoning, late.seq) == ("", "", 6)
    hub.end(1)
    items = early.drain()
    assert [item if item is END else item["kind"] for item in items] == ["message_delta", "message", END]
    assert late.drain() == [END]
    assert hub.subscribe(1) is None


def test_slow_reader_is_marked_lagged_instead_of_buffering_forever(monkeypatch):
    monkeypatch.setattr(live_stream, "SUBSCRIBER_BUFFER", 2)
    hub = LiveHub()
    hub.begin(1, 0)
    reader = hub.subscribe(1)
    for text in "一二三":
        hub.delta(1, "message_delta", text)
    assert reader.lagged and reader.queue.qsize() == 2


def test_coalesce_merges_adjacent_fragments_of_the_same_kind_only():
    message = {"seq": 3, "kind": "message", "payload": {"text": "ab"}}
    items = [
        {"kind": "message_delta", "payload": {"text": "a"}},
        {"kind": "message_delta", "payload": {"text": "b"}},
        {"kind": "reasoning_delta", "payload": {"text": "x"}},
        message,
        {"kind": "message_delta", "payload": {"text": "c"}},
        END,
    ]
    assert [item if item is END else item["payload"]["text"] for item in coalesce(items)] == [
        "ab",
        "x",
        "ab",
        "c",
        END,
    ]


@pytest.mark.asyncio
async def test_turn_relays_fragments_live_without_persisting_them(env, runner):  # noqa: F811
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    captured = {}

    def script():
        yield delta("先想", "reasoning_delta")
        captured["live"] = session_module.live_hub.subscribe(session["id"])
        yield delta("答")
        yield delta("复")
        yield durable(1, "message", {"text": "答复", "runtimeMessageId": "m"}, "llm")
        yield delta("未结算")
        yield durable(2, "done", {"status": "idle", "turnId": "t1"})

    runner.script = script()
    receipt = await service.start(session["id"], "问")
    await service.tasks[session["id"]]

    live = captured["live"]
    assert (live.text, live.reasoning) == ("", "先想")
    items = live.drain()
    assert items[-1] is END
    relayed = [(item["kind"], item.get("seq"), item["payload"].get("text")) for item in items[:-1]]
    assert relayed[:4] == [
        ("message_delta", None, "答"),
        ("message_delta", None, "复"),
        ("message", receipt["cursor"] + 2, "答复"),
        ("message_delta", None, "未结算"),
    ]
    assert relayed[-1][0] == "done"
    async with env["sessions"]() as db:
        stored = (
            await db.scalars(
                select(SessionEventIndex.kind).where(SessionEventIndex.session_id == session["id"])
            )
        ).all()
        replies = (
            await db.scalars(
                select(SessionMessage.content).where(
                    SessionMessage.session_id == session["id"], SessionMessage.role == "assistant"
                )
            )
        ).all()
    assert "message_delta" not in stored and "reasoning_delta" not in stored
    # 中途未结算的片段仍保留为部分输出
    assert replies == ["答复", "未结算"]
    assert session_module.live_hub.subscribe(session["id"]) is None


class FakeRequest:
    def __init__(self):
        self.headers = {}

    async def is_disconnected(self):
        return False


def parse(chunk: str) -> dict | str | None:
    lines = dict(line.split(": ", 1) for line in chunk.strip().split("\n") if ": " in line)
    if lines.get("event") == "settled":
        return "settled"
    return json.loads(lines["data"]) if lines.get("event") == "kernel" else None


@pytest.mark.asyncio
async def test_event_stream_backfills_then_snapshots_then_follows_live(env, runner, monkeypatch):  # noqa: F811
    service = session_module.session_service
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    paused, release = asyncio.Event(), asyncio.Event()

    async def events(*_args, **_kwargs):
        yield delta("先想", "reasoning_delta")
        yield durable(1, "tool_use_start", {"toolCallId": "c1", "tool": "glob"}, "tools")
        yield delta("已经输出")
        paused.set()
        await release.wait()
        yield delta("答")
        yield delta("复")
        yield durable(2, "message", {"text": "已经输出答复", "runtimeMessageId": "m"}, "llm")
        yield durable(3, "done", {"status": "idle", "turnId": "t1"})

    monkeypatch.setattr(runner, "events", events)
    await service.start(session["id"], "问")
    await asyncio.wait_for(paused.wait(), 5)

    # 页面在回合中途打开：先补齐已落库的事件，再收到尚未结算的正文与思考
    response = await routes.events(session["id"], FakeRequest(), after=0)
    stream = response.body_iterator
    received = []
    while not received or received[-1]["kind"] != "live_snapshot":
        if (event := parse(await asyncio.wait_for(anext(stream), 5))) is not None:
            received.append(event)
    assert [event["kind"] for event in received] == ["session", "tool_use_start", "live_snapshot"]
    assert received[-1]["payload"] == {"text": "已经输出", "reasoning": "先想"}

    release.set()
    rest = []
    while not rest or rest[-1] != "settled":
        if (event := parse(await asyncio.wait_for(anext(stream), 5))) is not None:
            rest.append(event)
    if task := service.tasks.get(session["id"]):
        await task
    kinds = [event if event == "settled" else event["kind"] for event in rest]
    assert kinds[-2:] == ["done", "settled"]
    assert (
        "".join(event["payload"]["text"] for event in rest[:-1] if event["kind"] == "message_delta") == "答复"
    )
    assert kinds.index("message") > max(i for i, kind in enumerate(kinds) if kind == "message_delta")
    # 持久事件不重复、序号递增
    seqs = [event["seq"] for event in received + rest[:-1] if "seq" in event]
    assert seqs == sorted(set(seqs))
