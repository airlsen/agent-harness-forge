"""平台策略：会话文件写入不再逐次确认，旧版本保存的审批开关被忽略。"""

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.models.platform import PlatformSetting
from src.api.services.settings_service import DEFAULT_POLICY, TOOLS, PolicyInput, get_policy


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        yield session
    await engine.dispose()


@pytest.mark.asyncio
async def test_legacy_write_approval_flag_is_dropped_but_other_settings_are_kept(db):
    db.add(
        PlatformSetting(
            key="policy",
            value={"requireWriteApproval": True, "maxOutputTokens": 2048, "fileRetentionDays": 7},
        )
    )
    await db.commit()
    policy = await get_policy(db)
    assert "requireWriteApproval" not in policy
    assert policy["maxOutputTokens"] == 2048
    assert policy["fileRetentionDays"] == 7
    assert policy["allowedTools"] == DEFAULT_POLICY["allowedTools"]


def test_saving_policy_from_an_old_client_ignores_the_retired_flag():
    payload = PolicyInput.model_validate({"requireWriteApproval": True, "allowedTools": ["workspace_write"]})
    assert "requireWriteApproval" not in payload.model_dump()


def test_workspace_write_is_a_direct_write_not_an_approval_tool():
    write = next(tool for tool in TOOLS if tool["name"] == "workspace_write")
    assert write["permission"] == "write"
    assert "requireWriteApproval" not in DEFAULT_POLICY


def test_default_limits_fit_long_agent_turns():
    # 默认输出上限 16384、模型请求超时 300 秒；上限分别放宽到 65536 与 600 秒
    assert DEFAULT_POLICY["maxOutputTokens"] == 16384
    assert DEFAULT_POLICY["requestTimeoutSeconds"] == 300
    payload = PolicyInput.model_validate({"maxOutputTokens": 65536, "requestTimeoutSeconds": 600})
    assert payload.maxOutputTokens == 65536 and payload.requestTimeoutSeconds == 600
    with pytest.raises(ValueError):
        PolicyInput.model_validate({"requestTimeoutSeconds": 601})
    with pytest.raises(ValueError):
        PolicyInput.model_validate({"maxOutputTokens": 65537})
