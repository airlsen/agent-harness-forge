"""通用大模型调用：默认模型、JSON 解析与重试、提示词任务登记。"""

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.services import llm_service, settings_service
from src.api.services.llm_prompts import PromptTask, get_task, register
from src.api.services.settings_service import ModelInput, create_connection, set_connection_availability


@pytest.fixture(autouse=True)
def isolated_model_credentials(monkeypatch):
    monkeypatch.setattr(llm_service, "_NO_RESPONSE_FORMAT", set())
    monkeypatch.setattr(settings_service, "encrypt", lambda value: f"encrypted:{value}")
    monkeypatch.setattr(settings_service, "decrypt", lambda value: value.removeprefix("encrypted:"))


async def _db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _fake_client(replies, requests):
    """按顺序返回预设回复的假 httpx 客户端；回复为 (状态码, 内容文本)。"""

    class FakeResponse:
        def __init__(self, status, content):
            self.status_code = status
            self.is_success = 200 <= status < 300
            self._content = content

        def json(self):
            return {
                "choices": [{"message": {"content": self._content}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            }

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def post(self, url, **kwargs):
            requests.append({"url": url, **kwargs})
            status, content = replies.pop(0)
            return FakeResponse(status, content)

    return FakeClient


def _model(name, model, key="secret"):
    return ModelInput(name=name, baseUrl="https://gateway.example.com/v1", model=model, apiKey=key)


@pytest.mark.asyncio
async def test_complete_uses_default_model_and_reports_usage(monkeypatch):
    engine, sessions = await _db()
    requests = []
    monkeypatch.setattr(llm_service.httpx, "AsyncClient", _fake_client([(200, "你好")], requests))
    try:
        async with sessions() as db:
            with pytest.raises(HTTPException) as missing:
                await llm_service.complete(db, messages=[{"role": "user", "content": "hi"}])
            assert missing.value.status_code == 409

            await create_connection(db, _model("Chat", "chat-v1", key="k1"))
            result = await llm_service.complete(
                db, messages=[{"role": "user", "content": "hi"}], max_tokens=64
            )
            assert result.text == "你好"
            assert result.model["model"] == "chat-v1"
            assert result.usage == {"promptTokens": 10, "completionTokens": 5}
            sent = requests[0]
            assert sent["url"] == "https://gateway.example.com/v1/chat/completions"
            assert sent["headers"]["Authorization"] == "Bearer k1"
            assert sent["json"]["max_tokens"] == 64
            assert "tools" not in sent["json"]
            # 返回给调用方的结果不含密钥
            assert "k1" not in str(result.view())
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_disabled_model_is_rejected(monkeypatch):
    engine, sessions = await _db()
    try:
        async with sessions() as db:
            row = await create_connection(db, _model("Chat", "chat-v1"))
            await set_connection_availability(db, row["id"], enabled=False)
            with pytest.raises(HTTPException) as error:
                await llm_service.complete(
                    db, messages=[{"role": "user", "content": "hi"}], model_id=row["id"]
                )
            assert error.value.status_code == 409
    finally:
        await engine.dispose()


def test_parse_json_accepts_fences_and_surrounding_text():
    assert llm_service.parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert llm_service.parse_json('好的，结果如下：{"a": {"b": 2}} 以上。') == {"a": {"b": 2}}
    with pytest.raises(ValueError):
        llm_service.parse_json("没有 JSON")
    with pytest.raises(ValueError):
        llm_service.parse_json("[1, 2]")


@pytest.mark.asyncio
async def test_complete_json_retries_once_and_falls_back_without_response_format(monkeypatch):
    engine, sessions = await _db()
    requests = []
    # 第一次：服务不支持 response_format（400）→ 去掉后重发，得到非 JSON → 带错误重试 → 合法 JSON
    replies = [(400, ""), (200, "抱歉我不会"), (200, '{"ok": true}')]
    monkeypatch.setattr(llm_service.httpx, "AsyncClient", _fake_client(replies, requests))
    try:
        async with sessions() as db:
            await create_connection(db, _model("Chat", "chat-v1"))
            data, result = await llm_service.complete_json(
                db, messages=[{"role": "user", "content": "给我 JSON"}]
            )
            assert data == {"ok": True}
            assert "response_format" in requests[0]["json"]
            assert "response_format" not in requests[1]["json"]
            # 记住该服务不支持 response_format，重试时直接不带
            assert "response_format" not in requests[2]["json"]
            retry_messages = requests[2]["json"]["messages"]
            assert retry_messages[-2] == {"role": "assistant", "content": "抱歉我不会"}
            assert "JSON" in retry_messages[-1]["content"]
            # 两次成功的模型调用用量累计
            assert result.usage == {"promptTokens": 20, "completionTokens": 10}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_complete_json_gives_up_after_retry(monkeypatch):
    engine, sessions = await _db()
    monkeypatch.setattr(
        llm_service.httpx, "AsyncClient", _fake_client([(200, "不是 JSON"), (200, "还不是")], [])
    )
    try:
        async with sessions() as db:
            await create_connection(db, _model("Chat", "chat-v1"))
            with pytest.raises(HTTPException) as error:
                await llm_service.complete_json(db, messages=[{"role": "user", "content": "x"}])
            assert error.value.status_code == 502
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_registered_task_renders_template_and_runs(monkeypatch):
    task = register(
        PromptTask(name="test.summary", system="你是$role。", user="总结：$text {不是变量}", max_tokens=99)
    )
    assert get_task("test.summary") is task
    messages = task.render({"role": "编辑", "text": "内容"})
    assert messages == [
        {"role": "system", "content": "你是编辑。"},
        {"role": "user", "content": "总结：内容 {不是变量}"},
    ]
    with pytest.raises(HTTPException):
        get_task("not.registered")

    engine, sessions = await _db()
    requests = []
    monkeypatch.setattr(llm_service.httpx, "AsyncClient", _fake_client([(200, "摘要")], requests))
    try:
        async with sessions() as db:
            await create_connection(db, _model("Chat", "chat-v1"))
            text, _ = await llm_service.run_task(db, "test.summary", {"role": "编辑", "text": "内容"})
            assert text == "摘要"
            assert requests[0]["json"]["max_tokens"] == 99
            assert "response_format" not in requests[0]["json"]
    finally:
        await engine.dispose()
