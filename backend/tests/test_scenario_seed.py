"""预置场景：通用助手默认绑定联网搜索（新环境创建、已部署环境启动时补齐）。"""

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.models.agent_scenario import AgentScenario, AgentScenarioVersion
from src.api.services.scenario_assembler import Bundle
from src.api.services.scenario_service import (
    GENERAL_ASSISTANT,
    WEB_SEARCH_HINT,
    ensure_general_assistant_web,
    seed_scenarios,
)


async def _memory_db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _versions(db, name):
    scenario = await db.scalar(select(AgentScenario).where(AgentScenario.name == name))
    return (
        await db.scalars(select(AgentScenarioVersion).where(AgentScenarioVersion.scenario_id == scenario.id))
    ).all()


def _assert_web_bound(version):
    payload, bundle = version.bundle_json["payload"], version.bundle_json["bundle"]
    assert payload["capabilities"]["web_search"] is True
    assert bundle["meta"]["webSearch"] is True
    assert payload["prompt_template"].count(WEB_SEARCH_HINT) == 1
    assert bundle["profile_patch"]["systemPrompt"]["domain"].count(WEB_SEARCH_HINT) == 1
    # 摘要与内容一致
    assert version.bundle_hash == Bundle(**bundle).bundle_hash


@pytest.mark.asyncio
async def test_fresh_install_binds_web_search_only_for_general_assistant():
    engine, sessions = await _memory_db()
    try:
        async with sessions() as db:
            await seed_scenarios(db)
            [general] = await _versions(db, GENERAL_ASSISTANT)
            _assert_web_bound(general)
            for name in ("代码与研发", "文档与报告", "分析与决策"):
                [version] = await _versions(db, name)
                assert version.bundle_json["payload"]["capabilities"]["web_search"] is False
                assert version.bundle_json["bundle"]["meta"]["webSearch"] is False
                assert WEB_SEARCH_HINT not in version.bundle_json["payload"]["prompt_template"]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_existing_install_is_patched_once_on_startup():
    engine, sessions = await _memory_db()
    try:
        async with sessions() as db:
            await seed_scenarios(db)
            # 模拟旧环境：通用助手未绑定联网、提示词没有联网说明
            [general] = await _versions(db, GENERAL_ASSISTANT)
            data = general.bundle_json
            prompt = data["payload"]["prompt_template"].replace(WEB_SEARCH_HINT, "")
            bundle = data["bundle"]
            bundle["meta"]["webSearch"] = False
            bundle["profile_patch"]["systemPrompt"]["domain"] = prompt
            general.bundle_json = {
                "payload": {
                    **data["payload"],
                    "prompt_template": prompt,
                    "capabilities": {**data["payload"]["capabilities"], "web_search": False},
                },
                "bundle": bundle,
            }
            general.bundle_hash = Bundle(**bundle).bundle_hash
            await db.commit()

            # 再次启动：库非空，只做补齐，不重复创建预置场景
            await seed_scenarios(db)
            assert len((await db.scalars(select(AgentScenario))).all()) == 4
            [general] = await _versions(db, GENERAL_ASSISTANT)
            _assert_web_bound(general)
            patched = general.bundle_json

            # 幂等：多次执行结果不变
            await ensure_general_assistant_web(db)
            [general] = await _versions(db, GENERAL_ASSISTANT)
            assert general.bundle_json == patched
            [other] = await _versions(db, "代码与研发")
            assert other.bundle_json["payload"]["capabilities"]["web_search"] is False
    finally:
        await engine.dispose()
