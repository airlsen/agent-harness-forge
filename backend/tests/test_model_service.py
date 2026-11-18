import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.models.platform import ModelConnection
from src.api.services import settings_service
from src.api.services.settings_service import (
    ModelInput,
    create_connection,
    delete_connection,
    get_connection,
    list_connections,
    save_connection,
    set_connection_availability,
)


@pytest.fixture(autouse=True)
def isolated_model_credentials(monkeypatch):
    monkeypatch.setattr(settings_service, "encrypt", lambda value: f"encrypted:{value}")
    monkeypatch.setattr(settings_service, "decrypt", lambda value: value.removeprefix("encrypted:"))


def model_payload(name: str, model: str, *, key: str = "secret") -> ModelInput:
    return ModelInput(
        name=name,
        baseUrl="https://gateway.example.com/v1",
        model=model,
        apiKey=key,
        contextWindow=64000,
    )


@pytest.mark.asyncio
async def test_model_connections_are_independent_safe_and_only_enabled_at_runtime(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async with sessions() as db:
        first = await create_connection(db, model_payload("Chat", "chat-v1", key="first-secret"))
        second = await create_connection(db, model_payload("Reasoner", "reasoner-v1", key="second-secret"))
        listed = await list_connections(db)
        assert [row["name"] for row in listed] == ["Chat", "Reasoner"]
        assert all("apiKey" not in row for row in listed)
        assert all(row["apiKeyConfigured"] for row in listed)
        assert all(row["enabled"] for row in listed)

        updated = await save_connection(db, model_payload("Reasoner 2", "reasoner-v2"), connection_id=second["id"])
        assert updated["id"] == second["id"]
        assert updated["name"] == "Reasoner 2"
        assert (await get_connection(db, secret=True, connection_id=second["id"]))["apiKey"] == "secret"

        # The compatibility runtime only considers enabled configurations; it never exposes a product default.
        assert (await get_connection(db))["id"] == first["id"]
        disabled = await set_connection_availability(db, first["id"], enabled=False)
        assert not disabled["enabled"]
        assert (await get_connection(db))["id"] == second["id"]
        await set_connection_availability(db, second["id"], enabled=False)
        assert not (await get_connection(db))["configured"]
        assert (await get_connection(db, connection_id=first["id"]))["configured"]
        await set_connection_availability(db, first["id"], enabled=True)

        requests = []

        class FakeResponse:
            status_code = 200
            is_success = True

            @staticmethod
            def json():
                return {"choices": [{"message": {"content": "OK"}}]}

        class FakeClient:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def post(self, *args, **kwargs):
                requests.append({"args": args, "kwargs": kwargs})
                return FakeResponse()

        monkeypatch.setattr(settings_service.httpx, "AsyncClient", FakeClient)
        tested = await settings_service.test_connection(db, connection_id=first["id"])
        assert tested["ok"]
        assert tested["latencyMs"] >= 0
        assert requests[0]["kwargs"]["json"]["max_tokens"] == 8
        assert (await get_connection(db, connection_id=first["id"]))["lastTest"] == tested

        await delete_connection(db, first["id"])
        assert not (await get_connection(db))["configured"]

    await engine.dispose()


@pytest.mark.asyncio
async def test_legacy_single_connection_save_still_creates_a_connection():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async with sessions() as db:
        saved = await save_connection(db, model_payload("Legacy", "legacy-chat"))
        row = await db.get(ModelConnection, saved["id"])
        assert row is not None
        assert saved["configured"]
        assert saved["enabled"]
        assert isinstance(saved["id"], int)

    await engine.dispose()
