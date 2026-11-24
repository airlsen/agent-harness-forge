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


def test_saving_policy_from_an_old_client_ignores_the_retired_flag_and_renames_tools():
    payload = PolicyInput.model_validate(
        {"requireWriteApproval": True, "allowedTools": ["current_time", "workspace_read", "workspace_write"]}
    )
    assert "requireWriteApproval" not in payload.model_dump()
    assert payload.allowedTools == ["read", "write"]


def test_write_is_a_direct_write_not_an_approval_tool():
    write = next(tool for tool in TOOLS if tool["name"] == "write")
    assert write["permission"] == "write"
    assert "requireWriteApproval" not in DEFAULT_POLICY
    # 修改与交付随写入开放，不在策略里单独管控
    assert not {"edit", "present"} & {tool["name"] for tool in TOOLS}


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


@pytest.mark.asyncio
async def test_tool_rename_migration_rewrites_saved_names_once(db):
    """平台契约 v2：执行策略、空间开关、场景快照里的旧工具名一次性换成新名，current_time 去掉。"""
    from sqlalchemy import select

    from src.api.core.database import TOOL_RENAME_MARKER, migrate_tool_names
    from src.api.models.agent_scenario import AgentScenarioVersion
    from src.api.models.space import Space

    legacy = ["current_time", "workspace_list", "workspace_read", "workspace_write", "bash"]
    db.add(PlatformSetting(key="policy", value={"allowedTools": legacy, "maxOutputTokens": 2048}))
    db.add(Space(name="财务", disabled_tools=["workspace_write", "bash"]))
    db.add(
        AgentScenarioVersion(
            scenario_id=1,
            version=1,
            bundle_hash="old",
            created_by="system",
            bundle_json={
                "payload": {"capabilities": {"builtin_tool_names": legacy}},
                "bundle": {"meta": {"builtin_tools": legacy, "policy": {"allowedTools": legacy}}},
            },
        )
    )
    await db.commit()
    await migrate_tool_names(db)
    await db.commit()

    assert (await get_policy(db))["allowedTools"] == ["read", "write", "bash"]
    space = (await db.scalars(select(Space))).one()
    assert space.disabled_tools == ["write", "bash"]
    version = (await db.scalars(select(AgentScenarioVersion))).one()
    assert version.bundle_json["payload"]["capabilities"]["builtin_tool_names"] == ["read", "write", "bash"]
    assert version.bundle_json["bundle"]["meta"]["builtin_tools"] == ["read", "write", "bash"]
    assert version.bundle_json["bundle"]["meta"]["policy"]["allowedTools"] == ["read", "write", "bash"]
    marker = await db.get(PlatformSetting, TOOL_RENAME_MARKER)
    assert marker.value == {"policy": 1, "spaces": 1, "versions": 1}

    # 已迁移过：之后写入的数据不再被改动
    space.disabled_tools = ["workspace_write"]
    await db.commit()
    await migrate_tool_names(db)
    assert space.disabled_tools == ["workspace_write"]
