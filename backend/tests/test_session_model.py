"""第一期模型选择：平台默认模型、聊天可选模型列表、新会话按所选模型快照。"""

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.schemas.agent_scenario import ScenarioPayload
from src.api.services import session_service as session_module
from src.api.services import settings_service
from src.api.services.scenario_service import scenario_service
from src.api.services.settings_service import (
    ModelInput,
    create_connection,
    delete_connection,
    get_connection,
    list_connections,
    list_model_options,
    resolve_session_connection,
    set_connection_availability,
    set_default_connection,
)


@pytest.fixture(autouse=True)
def fake_crypto(monkeypatch):
    monkeypatch.setattr(settings_service, "encrypt", lambda value: f"encrypted:{value}")
    monkeypatch.setattr(settings_service, "decrypt", lambda value: value.removeprefix("encrypted:"))
    monkeypatch.setattr(session_module, "encrypt", lambda value: f"encrypted:{value}")


@pytest_asyncio.fixture
async def sessions():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


def model(name: str, model_id: str, **extra) -> ModelInput:
    return ModelInput(
        name=name,
        baseUrl="https://gateway.example.com/v1",
        model=model_id,
        apiKey=f"{model_id}-secret",
        contextWindow=64000,
        **extra,
    )


@pytest.mark.asyncio
async def test_default_model_drives_runtime_resolution_and_never_points_at_disabled(sessions):
    async with sessions() as db:
        first = await create_connection(db, model("Chat", "chat-v1"))
        second = await create_connection(db, model("Reasoner", "reasoner-v1"))
        assert not first["isDefault"] and not second["isDefault"]
        # 未设置默认时回退到最早的启用配置（兼容旧数据）
        assert (await get_connection(db))["id"] == first["id"]

        made = await set_default_connection(db, second["id"])
        assert made["isDefault"]
        assert (await get_connection(db))["id"] == second["id"]
        assert [row["isDefault"] for row in await list_connections(db)] == [False, True]

        # 全平台只有一个默认
        await set_default_connection(db, first["id"])
        assert [row["isDefault"] for row in await list_connections(db)] == [True, False]

        # 停用默认模型会清除默认标记，运行时回退到下一个启用配置
        await set_connection_availability(db, first["id"], enabled=False)
        assert not (await get_connection(db, connection_id=first["id"]))["isDefault"]
        assert (await get_connection(db))["id"] == second["id"]

        # 已停用的模型不能设为默认；不存在的模型返回 404
        with pytest.raises(HTTPException) as disabled:
            await set_default_connection(db, first["id"])
        assert disabled.value.status_code == 409
        with pytest.raises(HTTPException) as missing:
            await set_default_connection(db, 9999)
        assert missing.value.status_code == 404

        # 删除默认模型后同样回退
        await set_default_connection(db, second["id"])
        await set_connection_availability(db, first["id"], enabled=True)
        await delete_connection(db, second["id"])
        assert (await get_connection(db))["id"] == first["id"]


@pytest.mark.asyncio
async def test_model_options_hide_endpoints_and_secrets_and_only_list_enabled(sessions):
    async with sessions() as db:
        assert await list_model_options(db) == {"items": [], "defaultId": None}
        first = await create_connection(db, model("Chat", "chat-v1", inputPrice=1, outputPrice=2))
        second = await create_connection(db, model("Reasoner", "reasoner-v1"))
        third = await create_connection(db, model("Legacy", "legacy-v1"))
        await set_connection_availability(db, third["id"], enabled=False)
        await set_default_connection(db, second["id"])
        settings_row = await db.get(settings_service.ModelConnection, first["id"])
        settings_row.last_test = {"ok": True, "at": "2026-11-18T00:00:00Z"}
        await db.commit()

        options = await list_model_options(db)
        assert options["defaultId"] == second["id"]
        assert [item["id"] for item in options["items"]] == [first["id"], second["id"]]
        assert set(options["items"][0]) == {
            "id",
            "name",
            "model",
            "contextWindow",
            "inputPrice",
            "outputPrice",
            "isDefault",
            "status",
        }
        assert options["items"][0]["status"] == "ok"
        assert options["items"][1]["status"] == "untested"
        assert options["items"][0]["inputPrice"] == 1
        # 不返回服务地址与凭据
        serialized = repr(options)
        assert "gateway.example.com" not in serialized and "secret" not in serialized

        # 未设置显式默认时，defaultId 指向最早的启用配置
        await set_connection_availability(db, second["id"], enabled=False)
        assert (await list_model_options(db))["defaultId"] == first["id"]


@pytest.mark.asyncio
async def test_resolve_session_connection_validates_explicit_choice(sessions):
    async with sessions() as db:
        with pytest.raises(HTTPException) as empty:
            await resolve_session_connection(db)
        assert empty.value.status_code == 409

        first = await create_connection(db, model("Chat", "chat-v1"))
        second = await create_connection(db, model("Reasoner", "reasoner-v1"))
        assert (await resolve_session_connection(db))["id"] == first["id"]
        chosen = await resolve_session_connection(db, second["id"])
        assert chosen["id"] == second["id"] and chosen["apiKey"] == "reasoner-v1-secret"

        await set_connection_availability(db, second["id"], enabled=False)
        with pytest.raises(HTTPException) as disabled:
            await resolve_session_connection(db, second["id"])
        assert disabled.value.status_code == 409
        with pytest.raises(HTTPException) as missing:
            await resolve_session_connection(db, 9999)
        assert missing.value.status_code == 404


@pytest.mark.asyncio
async def test_new_session_snapshots_the_selected_model(sessions, monkeypatch):
    monkeypatch.setattr(session_module, "SessionFactory", sessions)
    async with sessions() as db:
        chat = await create_connection(db, model("企业 Chat", "chat-v1"))
        reasoner = await create_connection(
            db, model("企业 Reasoner", "reasoner-v1", inputPrice=4, outputPrice=16)
        )
        await set_default_connection(db, chat["id"])
        scenario = await scenario_service.create(
            db, "admin", ScenarioPayload(name="通用助手", prompt_template="帮助用户")
        )

    service = session_module.SessionService()
    chosen = await service.create(scenario["id"], model_id=reasoner["id"])
    assert chosen["modelId"] == reasoner["id"]
    assert chosen["model"] == "reasoner-v1"
    assert chosen["modelName"] == "企业 Reasoner"

    default = await service.create(scenario["id"])
    assert default["modelId"] == chat["id"] and default["modelName"] == "企业 Chat"

    async with sessions() as db:
        segments = await session_module.current_segments(db, [chosen["id"]])
        segment = segments[chosen["id"]]
        assert segment.connection_id == reasoner["id"]
        assert segment.model == "reasoner-v1"
        assert segment.from_message_id is None
        assert segment.credential == "encrypted:reasoner-v1-secret"
        # 计费单价取自所选模型
        assert segment.input_price == 4 and segment.output_price == 16
        assert session_module.model_ref(segment) == {
            "modelId": reasoner["id"],
            "model": "reasoner-v1",
            "modelName": "企业 Reasoner",
        }

    with pytest.raises(HTTPException) as missing:
        await service.create(scenario["id"], model_id=9999)
    assert missing.value.status_code == 404


def test_legacy_session_view_falls_back_to_model_id():
    class Row:
        id = 7
        title = "旧会话"
        scenario_id = 1
        scenario_version = 1
        bundle_hash = "h"
        status = "idle"
        tokens_in = tokens_out = 0
        cost = 0.0
        cost_known = False
        created_at = None
        bundle_snapshot = {"meta": {"model": "deepseek-chat"}}

    view = session_module.SessionService().view(Row())
    assert view["modelId"] is None
    assert view["modelName"] == "deepseek-chat"
    assert view["modelContextWindow"] is None
    assert session_module.model_ref(None, Row()) == {
        "modelId": None,
        "model": "deepseek-chat",
        "modelName": "deepseek-chat",
    }
