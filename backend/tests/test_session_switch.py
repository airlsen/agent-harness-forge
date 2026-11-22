"""第二期：会话内切换模型（按轮生效、按段计价、旧会话迁移与 Runner 配置下发）。"""

import asyncio
from datetime import datetime

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.models.agent_session import AgentSession, AgentSessionModel
from src.api.models.platform import PlatformSetting, SessionMessage
from src.api.routes.agent_scenario import publish
from src.api.schemas.agent_scenario import ScenarioPayload
from src.api.services import session_service as session_module
from src.api.services.runner_client import SkillContentRequired
from src.api.services import settings_service
from src.api.services.scenario_service import scenario_service
from src.api.services.settings_service import ModelInput, create_connection, set_connection_availability


class FakeRunner:
    """记录每轮下发的模型配置，并回放一条回复与一次用量。"""

    def __init__(self):
        self.created: list[dict] = []
        self.turns: list[tuple[str, str, dict | None]] = []
        self.code: list[list[str] | None] = []
        self.created_code: list[list[str] | None] = []
        self.created_caps: list[dict | None] = []
        self.caps: list[dict | None] = []
        self.projects = ["alpha", "beta"]
        self.usage = (1000, 100)
        # alive=False 模拟 Runner 重启（内存会话丢失）；restore_error 模拟会话日志缺失或损坏
        self.alive = True
        self.restore_error: HTTPException | None = None
        self.restored: list[tuple] = []
        # 模拟 Runner 的 Skill 内容缓存：收到过全文的快照才能只发引用；缺少时记录并按 409 拒绝
        self.known_snapshots: set[str] = set()
        self.missing_requests: list[list[str]] = []

    def check_skills(self, capabilities):
        skills = (capabilities or {}).get("skills") or []
        missing = [
            skill["snapshot"]
            for skill in skills
            if "content" not in skill and skill.get("snapshot") not in self.known_snapshots
        ]
        if missing:
            self.missing_requests.append(missing)
            raise SkillContentRequired(missing)
        self.known_snapshots.update(skill["snapshot"] for skill in skills if skill.get("snapshot"))

    async def create_session(self, _bundle, _user, config, code_projects=None, capabilities=None):
        self.check_skills(capabilities)
        self.created.append(config)
        self.created_code.append(code_projects)
        self.created_caps.append(capabilities)
        return {"sessionId": f"runner-{len(self.created)}"}

    async def code_projects(self):
        return {
            "root": "/usr/data/git",
            "available": True,
            "projects": [{"name": name, "path": f"/usr/data/git/{name}"} for name in self.projects],
        }

    async def call(self, _method, _path, _body=None):
        if not self.alive:
            raise HTTPException(404, "执行会话不存在，Runner 可能已重启")
        return {"exists": True, "busy": False}

    async def restore_session(self, runner_id, bundle, _user, config, code_projects=None, capabilities=None):
        if self.restore_error:
            raise self.restore_error
        self.check_skills(capabilities)
        self.restored.append((runner_id, bundle, config, code_projects, capabilities))
        self.alive = True
        return {"sessionId": runner_id}

    async def events(self, runner_id, message, model_config=None, code_projects=None, capabilities=None):
        self.check_skills(capabilities)
        self.turns.append((runner_id, message, model_config))
        self.code.append(code_projects)
        self.caps.append(capabilities)
        yield {
            "kind": "message",
            "source": "llm",
            "payload": {"text": f"re: {message}", "runtimeMessageId": "m"},
        }
        tokens_in, tokens_out = self.usage
        yield {
            "kind": "cost_tick",
            "source": "llm",
            "payload": {"tokensIn": tokens_in, "tokensOut": tokens_out},
        }
        yield {"kind": "done", "payload": {"status": "idle"}}


@pytest.fixture(autouse=True)
def fake_crypto(monkeypatch):
    monkeypatch.setattr(settings_service, "encrypt", lambda value: f"encrypted:{value}")
    monkeypatch.setattr(settings_service, "decrypt", lambda value: value.removeprefix("encrypted:"))
    monkeypatch.setattr(session_module, "encrypt", lambda value: f"encrypted:{value}")
    monkeypatch.setattr(session_module, "decrypt", lambda value: value.removeprefix("encrypted:"))


@pytest_asyncio.fixture
async def env(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    runner = FakeRunner()
    monkeypatch.setattr(session_module, "SessionFactory", sessions)
    monkeypatch.setattr(session_module, "runner_client", runner)
    monkeypatch.setattr(session_module.file_service, "sessions", sessions)
    async with sessions() as db:
        models = {
            "chat": await create_connection(db, model("Chat", "chat-v1", inputPrice=1, outputPrice=2)),
            "reasoner": await create_connection(
                db, model("Reasoner", "reasoner-v1", inputPrice=4, outputPrice=16, contextWindow=32000)
            ),
            "free": await create_connection(db, model("Unpriced", "free-v1")),
            "retired": await create_connection(db, model("Retired", "retired-v1")),
        }
        await set_connection_availability(db, models["retired"]["id"], enabled=False)
        scenario = await scenario_service.create(
            db, "admin", ScenarioPayload(name="通用助手", prompt_template="帮助用户")
        )
    yield {"sessions": sessions, "runner": runner, "models": models, "scenario": scenario}
    await engine.dispose()


def model(name: str, model_id: str, **extra) -> ModelInput:
    extra.setdefault("contextWindow", 64000)
    return ModelInput(
        name=name,
        baseUrl=f"https://{model_id}.example.com/v1",
        model=model_id,
        apiKey=f"{model_id}-secret",
        **extra,
    )


async def turn(service, session_id, message, **kwargs):
    receipt = await service.start(session_id, message, **kwargs)
    task = service.tasks.get(session_id)
    if task:
        await task
    return receipt


@pytest.mark.asyncio
async def test_new_scenario_revision_does_not_replace_published_sessions_before_release(env):
    scenario_id = env["scenario"]["id"]
    model_id = env["models"]["chat"]["id"]
    async with env["sessions"]() as db:
        row = await scenario_service.row(db, scenario_id)
        row.status = "published"
        row.published_version = 1
        await db.commit()
        revised = await scenario_service.update(
            db, "admin", scenario_id, ScenarioPayload(name="新版助手", prompt_template="新版规范")
        )
        assert revised["status"] == "published"
        assert revised["current_version"] == 2 and revised["published_version"] == 1
        assert revised["payload"]["name"] == "新版助手"
        assert revised["published_payload"]["name"] == "通用助手"

    service = session_module.SessionService()
    live = await service.create(scenario_id, model_id=model_id)
    trial = await service.create(scenario_id, model_id=model_id, is_test=True)
    assert live["scenarioVersion"] == 1
    assert trial["scenarioVersion"] == 2

    async with env["sessions"]() as db:
        with pytest.raises(HTTPException) as blocked:
            await publish(scenario_id, db)
        assert blocked.value.status_code == 409
        db.add(
            PlatformSetting(
                key=f"scenario-test:{scenario_id}:2",
                value={"ok": True, "environmentRef": await settings_service.environment_ref(db)},
            )
        )
        await db.commit()
        await publish(scenario_id, db)
        updated = await scenario_service.view(db, await scenario_service.row(db, scenario_id))
        assert updated["published_version"] == 2
        assert updated["publishedAt"] is not None
        first_published_at = updated["publishedAt"]
        await publish(scenario_id, db)
        after_repeat = await scenario_service.view(db, await scenario_service.row(db, scenario_id))
        assert after_repeat["publishedAt"] == first_published_at
        draft = await scenario_service.update(
            db, "admin", scenario_id, ScenarioPayload(name="新草稿", prompt_template="尚未发布")
        )
        assert draft["publishedAt"] == first_published_at
        assert draft["published_payload"]["name"] == "新版助手"

    latest = await service.create(scenario_id, model_id=model_id)
    assert latest["scenarioVersion"] == 2


@pytest.mark.asyncio
async def test_scenario_release_time_advances_only_for_a_new_published_version(env):
    scenario_id = env["scenario"]["id"]
    async with env["sessions"]() as db:
        row = await scenario_service.row(db, scenario_id)
        row.status = "published"
        row.published_version = row.current_version
        row.published_at = None  # A migrated historical release has no trustworthy timestamp.
        db.add(
            PlatformSetting(
                key=f"scenario-test:{scenario_id}:1",
                value={"ok": True, "environmentRef": await settings_service.environment_ref(db)},
            )
        )
        await db.commit()
        await db.refresh(row)
        await publish(scenario_id, db)
        assert (await scenario_service.view(db, row))["publishedAt"] is None
        row.published_at = datetime(2020, 1, 1)
        await db.commit()
        await db.refresh(row)
        updated = await scenario_service.update(
            db, "admin", scenario_id, ScenarioPayload(name="新版本", prompt_template="新版本内容")
        )
        assert updated["publishedAt"] == "2020-01-01T00:00:00+00:00"
        db.add(
            PlatformSetting(
                key=f"scenario-test:{scenario_id}:2",
                value={"ok": True, "environmentRef": await settings_service.environment_ref(db)},
            )
        )
        await db.commit()
        await publish(scenario_id, db)
        result = await scenario_service.view(db, row)
        assert result["publishedAt"] != updated["publishedAt"]
        assert result["published_version"] == 2


@pytest.mark.asyncio
async def test_switch_applies_from_the_next_turn_and_prices_each_segment(env):
    service = session_module.SessionService()
    chat, reasoner = env["models"]["chat"], env["models"]["reasoner"]
    session = await service.create(env["scenario"]["id"], model_id=chat["id"])

    first = await turn(service, session["id"], "第一轮")
    assert "modelSwitch" not in first["messageMeta"]
    assert env["runner"].created[0]["model"] == "chat-v1"
    assert env["runner"].turns[0][2] == {
        "baseUrl": "https://chat-v1.example.com/v1",
        "model": "chat-v1",
        "contextWindow": 64000,
        "apiKey": "chat-v1-secret",
    }

    second = await turn(service, session["id"], "第二轮", model_id=reasoner["id"])
    switch = second["messageMeta"]["modelSwitch"]
    assert switch["from"] == {"id": chat["id"], "name": "Chat", "model": "chat-v1"}
    assert switch["to"] == {"id": reasoner["id"], "name": "Reasoner", "model": "reasoner-v1"}
    assert second["model"]["id"] == reasoner["id"] and second["model"]["contextWindow"] == 32000
    # Runner 会话只创建一次；切换通过本轮配置下发，由 Runner 比对指纹后重启接续。
    assert len(env["runner"].created) == 1
    assert env["runner"].turns[1][2]["model"] == "reasoner-v1"
    assert env["runner"].turns[1][2]["apiKey"] == "reasoner-v1-secret"

    detail = await service.detail(session["id"])
    assert detail["modelId"] == reasoner["id"] and detail["modelName"] == "Reasoner"
    assert detail["modelContextWindow"] == 32000
    assert detail["contextTokens"] == 1000
    assert [(item["id"], item["fromMessageId"]) for item in detail["models"]] == [
        (chat["id"], None),
        (reasoner["id"], second["messageId"]),
    ]
    # 按段计价：(1000×1 + 100×2)/1e6 与 (1000×4 + 100×16)/1e6
    assert detail["models"][0]["cost"] == pytest.approx(0.0012)
    assert detail["models"][1]["cost"] == pytest.approx(0.0056)
    assert detail["cost"] == pytest.approx(0.0068)
    assert detail["tokensIn"] == 2000

    assistants = [m for m in detail["messages"] if m["role"] == "assistant"]
    assert [m["meta"]["modelName"] for m in assistants] == ["Chat", "Reasoner"]
    users = [m for m in detail["messages"] if m["role"] == "user"]
    assert users[0]["meta"]["modelName"] == "Chat" and "modelSwitch" not in users[0]["meta"]
    assert users[1]["meta"]["modelSwitch"]["to"]["name"] == "Reasoner"

    # 切换事件紧跟在返回游标之后，客户端订阅时可以收到。
    events = await service.events(session["id"], after=second["cursor"])
    assert events[0]["kind"] == "model_switched"
    assert events[0]["payload"]["to"]["model"] == "reasoner-v1"
    assert events[1]["kind"] == "session"

    # 指定与当前相同的模型不算切换。
    third = await turn(service, session["id"], "第三轮", model_id=reasoner["id"])
    assert "modelSwitch" not in third["messageMeta"]
    assert len((await service.detail(session["id"]))["models"]) == 2


@pytest.mark.asyncio
async def test_invalid_switch_targets_and_running_sessions_are_rejected_without_side_effects(env):
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    await turn(service, session["id"], "第一轮")

    async def counts():
        async with env["sessions"]() as db:
            messages = await db.scalar(select(func.count()).select_from(SessionMessage))
            segments = await db.scalar(select(func.count()).select_from(AgentSessionModel))
            return messages, segments

    before = await counts()
    with pytest.raises(HTTPException) as retired:
        await service.start(session["id"], "换到停用模型", model_id=env["models"]["retired"]["id"])
    assert retired.value.status_code == 409
    with pytest.raises(HTTPException) as missing:
        await service.start(session["id"], "换到不存在的模型", model_id=9999)
    assert missing.value.status_code == 404

    blocker = asyncio.get_running_loop().create_future()
    service.tasks[session["id"]] = blocker
    with pytest.raises(HTTPException) as running:
        await service.start(session["id"], "执行中切换", model_id=env["models"]["reasoner"]["id"])
    assert running.value.status_code == 409
    blocker.cancel()
    service.tasks.pop(session["id"])
    assert await counts() == before


@pytest.mark.asyncio
async def test_current_model_keeps_working_after_disable_and_unpriced_usage_marks_cost_unknown(env):
    service = session_module.SessionService()
    chat, free = env["models"]["chat"], env["models"]["free"]
    session = await service.create(env["scenario"]["id"], model_id=chat["id"])
    await turn(service, session["id"], "第一轮")
    assert (await service.detail(session["id"]))["cost"] == pytest.approx(0.0012)

    # 当前模型被停用后，沿用冻结的分段继续本会话；只是不能再切换回它。
    async with env["sessions"]() as db:
        await set_connection_availability(db, chat["id"], enabled=False)
    await turn(service, session["id"], "继续")
    assert env["runner"].turns[-1][2]["model"] == "chat-v1"

    await turn(service, session["id"], "换到未定价模型", model_id=free["id"])
    detail = await service.detail(session["id"])
    assert detail["cost"] is None  # 存在未定价用量，费用不再完整
    assert detail["models"][-1]["cost"] is None
    assert detail["models"][0]["cost"] == pytest.approx(0.0024)


@pytest.mark.asyncio
async def test_legacy_session_snapshot_is_migrated_into_the_first_segment(env):
    service = session_module.SessionService()
    async with env["sessions"]() as db:
        row = AgentSession(
            scenario_id=env["scenario"]["id"],
            bundle_hash="legacy",
            bundle_snapshot={
                "meta": {"model": "legacy-v1", "modelName": "Legacy", "inputPrice": 2, "outputPrice": 3}
            },
        )
        db.add(row)
        await db.flush()
        db.add(
            PlatformSetting(
                key=f"session-model:{row.id}",
                value={
                    "baseUrl": "https://legacy.example.com/v1",
                    "model": "legacy-v1",
                    "contextWindow": 128000,
                    "credential": "encrypted:legacy-secret",
                },
            )
        )
        await db.commit()
        legacy_id = row.id

    assert (await service.detail(legacy_id))["models"] == []
    await turn(service, legacy_id, "旧会话继续")
    assert env["runner"].created[-1] == {
        "baseUrl": "https://legacy.example.com/v1",
        "model": "legacy-v1",
        "contextWindow": 128000,
        "apiKey": "legacy-secret",
    }
    detail = await service.detail(legacy_id)
    assert [(item["name"], item["id"]) for item in detail["models"]] == [("Legacy", None)]
    assert detail["cost"] == pytest.approx((1000 * 2 + 100 * 3) / 1000000)

    switched = await turn(service, legacy_id, "旧会话切换", model_id=env["models"]["chat"]["id"])
    assert switched["messageMeta"]["modelSwitch"]["from"] == {
        "id": None,
        "name": "Legacy",
        "model": "legacy-v1",
    }
    listed = next(item for item in await service.list() if item["id"] == legacy_id)
    assert listed["modelId"] == env["models"]["chat"]["id"] and listed["modelName"] == "Chat"


class FileRunner(FakeRunner):
    """第一轮执行中写入两个文件、第二轮修改其中一个，验证本轮改动记录。"""

    def __init__(self):
        super().__init__()
        self.files: dict[str, bytes] = {}

    async def call(self, method, path, _body=None):
        from hashlib import sha256

        if method == "GET" and path.endswith("/files"):
            return {
                "items": [
                    {
                        "path": name,
                        "bytes": len(data),
                        "mime": "text/plain",
                        "sha256": sha256(data).hexdigest(),
                    }
                    for name, data in self.files.items()
                ]
            }
        return await super().call(method, path, _body)

    async def raw(self, path):
        from urllib.parse import unquote

        return self.files[unquote(path.split("path=", 1)[1])], "text/plain"

    async def events(self, runner_id, message, model_config=None, code_projects=None, capabilities=None):
        if message == "第一轮":
            self.files = {"report.md": b"# v1\n", "notes.txt": b"a\n"}
        else:
            self.files["report.md"] = b"# v2\nmore\n"
        yield {"kind": "files", "source": "tools", "payload": {"paths": sorted(self.files)}}
        async for event in super().events(runner_id, message, model_config, code_projects):
            yield event


@pytest.mark.asyncio
async def test_each_turn_records_its_workspace_changes(env, tmp_path, monkeypatch):
    from src.api.services.file_store import FileStore

    runner = FileRunner()
    monkeypatch.setattr(session_module, "runner_client", runner)
    monkeypatch.setattr(session_module.file_service, "store", FileStore(tmp_path))
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])

    first = await turn(service, session["id"], "第一轮")
    second = await turn(service, session["id"], "第二轮")
    async with env["sessions"]() as db:
        one = (await db.get(SessionMessage, first["messageId"])).meta["workspaceChanges"]
        two = (await db.get(SessionMessage, second["messageId"])).meta["workspaceChanges"]
    assert (one["added"], one["modified"], one["total"]) == (2, 0, 2)
    assert [(f["path"], f["action"]) for f in two["files"]] == [("report.md", "modified")]
    assert (two["files"][0]["linesAdded"], two["files"][0]["linesRemoved"]) == (2, 1)
    events = await service.events(session["id"])
    kinds = [event["kind"] for event in events]
    assert kinds.count("workspace_changes") == 2
    # 改动事件在本轮 done 之前发布，客户端收到 done 时已能展示
    assert kinds.index("workspace_changes") < kinds.index("done")
    detail = await service.detail(session["id"])
    assert any(m.get("meta", {}).get("workspaceChanges") for m in detail["messages"])


@pytest.mark.asyncio
async def test_runner_restart_restores_the_same_execution_session_from_its_log(env):
    service = session_module.SessionService()
    runner, chat, reasoner = env["runner"], env["models"]["chat"], env["models"]["reasoner"]
    session = await service.create(env["scenario"]["id"], model_id=chat["id"])
    await turn(service, session["id"], "第一轮")

    runner.alive = False  # Runner 进程重启
    await turn(service, session["id"], "第二轮", model_id=reasoner["id"])
    # 按原 id 与数据库快照恢复，不新建执行会话；本轮切换后的模型一并下发
    assert len(runner.created) == 1
    assert [item[0] for item in runner.restored] == ["runner-1"]
    runner_id, bundle, config, code, caps = runner.restored[0]
    async with env["sessions"]() as db:
        row = await db.get(AgentSession, session["id"])
        assert bundle == row.bundle_snapshot
    assert config["model"] == "reasoner-v1"
    assert code == [] and caps == runner.created_caps[0]
    assert [item[0] for item in runner.turns] == ["runner-1", "runner-1"]
    detail = await service.detail(session["id"])
    assert [m["content"] for m in detail["messages"] if m["role"] == "user"] == ["第一轮", "第二轮"]

    # Runner 仍在：不重复恢复
    await turn(service, session["id"], "第三轮")
    assert len(runner.restored) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [404, 410])
async def test_unrecoverable_runner_log_is_rejected_without_recording_the_turn(env, status):
    service = session_module.SessionService()
    runner = env["runner"]
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    await turn(service, session["id"], "第一轮")
    runner.alive = False
    runner.restore_error = HTTPException(status, "会话日志不存在，无法接续执行上下文")
    with pytest.raises(HTTPException) as error:
        await turn(service, session["id"], "第二轮")
    assert error.value.status_code == 409
    assert "执行上下文无法恢复" in error.value.detail and "会话日志不存在" in error.value.detail
    detail = await service.detail(session["id"])
    assert [m["content"] for m in detail["messages"] if m["role"] == "user"] == ["第一轮"]
