"""会话内提问（ask_user_question）：question_required / resolved 落 kind=question 的工单，回执转发 Runner。

复用会话切换测试的内存数据库与假 Runner（pytest 默认 prepend 导入模式下可直接引用）。
"""

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from types import SimpleNamespace

from src.api.models.approval_ticket import ApprovalTicket
from src.api.routes import question as question_routes
from src.api.services import session_service as session_module

from test_session_switch import FakeRunner, env, fake_crypto, turn  # noqa: F401

QUESTIONS = [
    {"id": "q1", "question": "统计哪个季度的数据？", "options": [{"label": "Q1"}, {"label": "Q2"}]},
    {"id": "q2", "question": "输出语言？"},
]


class QuestionRunner(FakeRunner):
    """回合回放里插入一次提问；可选是否随回合自动回答，并记录回执转发。"""

    def __init__(self, settle: bool):
        super().__init__()
        self.settle = settle
        self.question_resolves: list[tuple[str, dict]] = []

    async def events(
        self, runner_id, message, model_config=None, code_projects=None, capabilities=None, *, since=None
    ):
        yield {
            "kind": "question_required",
            "source": "tools",
            "payload": {"ticketId": "question-ticket-1", "questions": QUESTIONS, "timeoutSeconds": 300},
        }
        if self.settle:
            yield {
                "kind": "question_resolved",
                "source": "tools",
                "payload": {
                    "ticketId": "question-ticket-1",
                    "action": "answered",
                    "answers": [
                        {"id": "q1", "selected": ["Q1"]},
                        {"id": "q2", "selected": [], "custom": "中文"},
                    ],
                },
            }
        async for event in super().events(
            runner_id, message, model_config, code_projects, capabilities, since=since
        ):
            yield event

    async def call(self, method, path, body=None):
        self.question_resolves.append((method, path, body))
        return {"ok": True}


async def _session_question_ticket(env, monkeypatch, runner):  # noqa: F811
    monkeypatch.setattr(session_module, "runner_client", runner)
    service = session_module.SessionService()
    session = await service.create(
        env["scenario"]["id"], user_id="admin", model_id=env["models"]["chat"]["id"]
    )
    await turn(service, session["id"], "做一份报表")
    async with env["sessions"]() as db:
        ticket = await db.scalar(select(ApprovalTicket).where(ApprovalTicket.session_id == session["id"]))
        return session, ticket


@pytest.mark.asyncio
async def test_question_events_settle_a_question_ticket(env, monkeypatch):  # noqa: F811
    runner = QuestionRunner(settle=True)
    session, ticket = await _session_question_ticket(env, monkeypatch, runner)
    assert ticket is not None
    assert ticket.kind == "question" and ticket.tool == "ask_user_question"
    assert ticket.status == "answered"
    assert ticket.decision_payload["runnerTicketId"] == "question-ticket-1"
    assert ticket.decision_payload["questions"][0]["id"] == "q1"
    assert ticket.decision_payload["answers"][0] == {"id": "q1", "selected": ["Q1"]}
    detail = await session_module.SessionService().detail(session["id"])
    assert detail["pendingApprovals"] == []
    assert detail["pendingQuestions"] == []


@pytest.mark.asyncio
async def test_pending_question_surfaces_in_detail_and_resolve_forwards_to_runner(env, monkeypatch):  # noqa: F811
    """回合中挂起的提问进入待办；回执转发 Runner 并更新工单；重复回执 409。"""
    runner = QuestionRunner(settle=False)
    monkeypatch.setattr(question_routes.runner_client, "call", runner.call)
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], user_id="admin", model_id=env["models"]["chat"]["id"])
    async with env["sessions"]() as db:
        row = await service.owned_row(db, session["id"], "admin")
        # Runner 执行会话在首轮才创建；回执转发只需要 runner_session_id 存在
        row.runner_session_id = "runner-1"
        db.add(
            ApprovalTicket(
                session_id=session["id"],
                tool_call_id="question-ticket-1",
                tool="ask_user_question",
                kind="question",
                status="pending",
                decision_payload={"runnerTicketId": "question-ticket-1", "questions": QUESTIONS},
            )
        )
        await db.commit()

    detail = await service.detail(session["id"])
    assert detail["pendingApprovals"] == []
    assert [q["ticketId"] for q in detail["pendingQuestions"]][0] > 0
    ticket_id = detail["pendingQuestions"][0]["ticketId"]
    assert detail["pendingQuestions"][0]["questions"][0]["id"] == "q1"

    request = SimpleNamespace(state=SimpleNamespace(user=SimpleNamespace(id="admin")))
    decision = question_routes.QuestionDecision(
        answers=[{"id": "q1", "selected": ["Q1"]}, {"id": "q2", "custom": "中文"}]
    )
    async with env["sessions"]() as db:
        response = await question_routes.resolve(ticket_id, decision, request, db)
    assert response.data["status"] == "answered"
    assert runner.question_resolves == [
        (
            "POST",
            "/v1/sessions/runner-1/questions/question-ticket-1/resolve",
            {"answers": [{"id": "q1", "selected": ["Q1"]}, {"id": "q2", "selected": [], "custom": "中文"}]},
        )
    ]
    # 已回答的提问不再出现在待办里；重复回执返回 409
    detail = await service.detail(session["id"])
    assert detail["pendingQuestions"] == []
    async with env["sessions"]() as db:
        with pytest.raises(HTTPException) as conflict:
            await question_routes.resolve(ticket_id, question_routes.QuestionDecision(action="cancel"), request, db)
    assert conflict.value.status_code == 409


@pytest.mark.asyncio
async def test_turn_end_cancels_a_question_left_pending(env, monkeypatch):  # noqa: F811
    """Runner 没有结算的挂起提问随回合结束取消，且发的是 question_resolved（不是 approval_resolved）。"""
    runner = QuestionRunner(settle=False)
    monkeypatch.setattr(session_module, "runner_client", runner)
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], user_id="admin", model_id=env["models"]["chat"]["id"])
    await turn(service, session["id"], "做一份报表")
    async with env["sessions"]() as db:
        ticket = await db.scalar(select(ApprovalTicket).where(ApprovalTicket.session_id == session["id"]))
        assert ticket.kind == "question"
        assert ticket.status == "cancelled"
    detail = await service.detail(session["id"])
    assert detail["pendingQuestions"] == []
    assert detail["pendingApprovals"] == []
