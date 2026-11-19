"""扩展能力：场景绑定 ∪ 聊天临时选择，每轮解析为 Runner 配置（Skill 正文/资料、MCP 凭据、联网密钥）。"""

import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from src.api.core import security
from src.api.models.registry import McpServer
from src.api.models.skill import Skill, SkillRevision
from src.api.schemas.agent_scenario import CapabilitySelection, ScenarioPayload
from src.api.services import capability_service as caps_module
from src.api.services import session_service as session_module
from src.api.services import skill_service
from src.api.services.capability_service import (
    CapabilityChoice,
    WebSearchInput,
    parse_skill,
    runtime_skill_name,
    save_web_settings,
    web_settings_view,
)
from src.api.services.mcp_service import scrubbed_env
from src.api.services.scenario_service import scenario_service

# 复用会话切换测试的内存数据库、假 Runner 与加密替身
from test_session_switch import env, fake_crypto, turn  # noqa: F401

SKILL_BODY = "# 周报规范\n\n结论先行，详见 references/glossary.md。\n"


@pytest.fixture(autouse=True)
def fake_security(monkeypatch, tmp_path):
    monkeypatch.setattr(security, "encrypt", lambda value: f"encrypted:{value}")
    monkeypatch.setattr(security, "decrypt", lambda value: value.removeprefix("encrypted:"))
    monkeypatch.setattr(skill_service.settings, "data_dir", tmp_path)


async def add_skill(db, tmp_path, name, *, published=True, front_name=None, references=()):
    skill = Skill(name=name, description=f"{name} 描述", status="published" if published else "draft")
    db.add(skill)
    await db.flush()
    refs = []
    for filename, content in references:
        target = tmp_path / "skills" / str(skill.id) / "references" / f"abc-{filename}"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        refs.append({"filename": filename, "path": str(target.relative_to(tmp_path)), "bytes": len(content)})
    content = f'---\nname: {front_name or name}\ndescription: "{name} 的规范"\n---\n\n{SKILL_BODY}'
    revision = SkillRevision(
        skill_id=skill.id,
        revision=1,
        published_version=1 if published else None,
        content=content,
        content_hash="h",
        reference_files=refs,
    )
    db.add(revision)
    await db.flush()
    skill.current_revision_id = revision.id
    if published:
        skill.published_revision_id = revision.id
    await db.commit()
    return skill


async def add_mcp(db, name, transport="stdio", *, enabled=True, status="connected", tools=None):
    private = (
        {"headers": {}, "command": "node", "args": ["server.js"], "env": {"API_TOKEN": "mcp-secret"}}
        if transport == "stdio"
        else {"Authorization": "Bearer http-secret"}
    )
    row = McpServer(
        name=name,
        url="stdio://local-process" if transport == "stdio" else "https://mcp.example.test/mcp",
        transport=transport,
        headers_encrypted="encrypted:" + json.dumps(private),
        enabled=enabled,
        status=status,
        tools_json=tools
        if tools is not None
        else [
            {"name": "lookup", "annotations": {"readOnlyHint": True}},
            {"name": "create_ticket", "annotations": {}},
        ],
    )
    db.add(row)
    await db.commit()
    return row


def test_skill_front_matter_and_runtime_names():
    name, description, body = parse_skill(
        '---\nname: Weekly_Report.v2\ndescription: "写周报"\n---\n\n# 正文\n'
    )
    assert (name, description, body) == ("Weekly_Report.v2", "写周报", "# 正文\n")
    assert runtime_skill_name(name, 3) == "weekly-report-v2"
    assert runtime_skill_name("——", 9) == "skill-9"


def test_stdio_probe_environment_never_inherits_secrets(monkeypatch):
    monkeypatch.setenv("FORGE_RUNNER_TOKEN", "x")
    monkeypatch.setenv("OPENAI_API_KEY", "x")
    monkeypatch.setenv("FORGE_DATA_DIR", "/data")
    monkeypatch.setenv("HOME_PATH_HINT", "kept")
    child = scrubbed_env({"SERVICE_TOKEN": "configured"})
    assert (
        "FORGE_RUNNER_TOKEN" not in child and "OPENAI_API_KEY" not in child and "FORGE_DATA_DIR" not in child
    )
    assert child["HOME_PATH_HINT"] == "kept"
    # 管理员显式配置的变量照常传入
    assert child["SERVICE_TOKEN"] == "configured"


def test_choice_rejects_duplicates_and_oversized_lists():
    with pytest.raises(ValidationError):
        CapabilityChoice(skillIds=[1, 1])
    with pytest.raises(ValidationError):
        CapabilityChoice(mcpServerIds=list(range(11)))
    with pytest.raises(ValidationError):
        WebSearchInput(enabled=True, baseUrl="http://plain.example.test")


@pytest.mark.asyncio
async def test_scenario_freezes_published_skills_and_rejects_unusable_capabilities(env, tmp_path):  # noqa: F811
    async with env["sessions"]() as db:
        skill = await add_skill(db, tmp_path, "周报助手", front_name="weekly-report")
        draft = await add_skill(db, tmp_path, "草稿", published=False)
        server = await add_mcp(db, "tickets")
        sse = await add_mcp(db, "legacy", transport="sse")
        created = await scenario_service.create(
            db,
            "admin",
            ScenarioPayload(
                name="周报",
                capabilities=CapabilitySelection(
                    skill_ids=[skill.id], mcp_server_ids=[server.id], web_search=True, project_ids=["old"]
                ),
                model="legacy-model",  # 旧数据里的模型字段被忽略，不再报错
            ),
        )
        version = await scenario_service.version(db, await scenario_service.row(db, created["id"]))
        meta = version.bundle_json["bundle"]["meta"]
        assert meta["skills"] == [
            {
                "id": skill.id,
                "revisionId": skill.published_revision_id,
                "version": 1,
                "title": "周报助手",
                "name": "weekly-report",
                "description": "周报助手 的规范",
            }
        ]
        assert meta["mcpServers"] == [{"id": server.id, "name": "tickets"}]
        assert meta["webSearch"] is True
        # Bundle 不含任何 MCP 凭据
        assert "mcp-secret" not in json.dumps(version.bundle_json, ensure_ascii=False)
        for selection, message in [
            (CapabilitySelection(skill_ids=[draft.id]), "尚未发布"),
            (CapabilitySelection(mcp_server_ids=[sse.id]), "MCP 服务不可用"),
            (CapabilitySelection(skill_ids=[skill.id, skill.id]), "重复"),
        ]:
            with pytest.raises(HTTPException) as error:
                await scenario_service.create(db, "admin", ScenarioPayload(name="x", capabilities=selection))
            assert message in error.value.detail


@pytest.mark.asyncio
async def test_turns_send_scenario_and_chat_capabilities_and_changes_apply_next_turn(env, tmp_path):  # noqa: F811
    runner = env["runner"]
    async with env["sessions"]() as db:
        bound = await add_skill(
            db, tmp_path, "周报助手", front_name="weekly-report", references=[("glossary.md", "术语表")]
        )
        extra = await add_skill(db, tmp_path, "翻译", front_name="weekly-report")  # 名称冲突
        server = await add_mcp(db, "tickets")
        remote = await add_mcp(db, "docs-search", transport="streamable-http")
        await save_web_settings(db, WebSearchInput(enabled=True, apiKey="web-secret"))
        scenario = await scenario_service.create(
            db,
            "admin",
            ScenarioPayload(
                name="周报", capabilities=CapabilitySelection(skill_ids=[bound.id], web_search=True)
            ),
        )
    service = session_module.SessionService()
    session = await service.create(scenario["id"], model_id=env["models"]["chat"]["id"])
    assert session["scenarioCapabilities"]["skills"][0]["name"] == "weekly-report"
    assert session["capabilities"] == {"skillIds": [], "mcpServerIds": [], "webSearch": False}

    first = await turn(
        service,
        session["id"],
        "写周报",
        capabilities=CapabilityChoice(skillIds=[extra.id], mcpServerIds=[server.id]),
    )
    sent = runner.created_caps[0]
    assert sent == runner.caps[0]
    assert [skill["name"] for skill in sent["skills"]] == ["weekly-report", f"weekly-report-{extra.id}"]
    assert sent["skills"][0]["content"] == SKILL_BODY
    assert sent["skills"][0]["references"] == [{"filename": "glossary.md", "content": "术语表"}]
    assert sent["skills"][0]["source"] == "scenario" and sent["skills"][1]["source"] == "chat"
    assert sent["mcp"] == [
        {
            "serverName": "tickets",
            "title": "tickets",
            "source": "chat",
            "tools": [
                {"name": "lookup", "permission": "read"},
                {"name": "create_ticket", "permission": "approval"},
            ],
            "transport": "stdio",
            "command": "node",
            "args": ["server.js"],
            "env": {"API_TOKEN": "mcp-secret"},
        }
    ]
    assert sent["web"] == {
        "search": True,
        "fetch": True,
        "source": "scenario",
        "provider": "deepseek-official",
        "apiKey": "web-secret",
    }
    # 消息里只有摘要：没有正文、凭据与命令
    summary = first["messageMeta"]["capabilities"]
    assert [item["source"] for item in summary["skills"]] == ["scenario", "chat"]
    assert summary["mcp"][0]["approvalTools"] == 1
    assert summary["web"] == {"search": True, "fetch": True, "source": "scenario"}
    dumped = json.dumps(first["messageMeta"], ensure_ascii=False)
    for secret in ("mcp-secret", "web-secret", "server.js", "结论先行", "术语表"):
        assert secret not in dumped
    assert first["capabilities"] == {"skillIds": [extra.id], "mcpServerIds": [server.id], "webSearch": False}

    # 不传沿用；两轮之间修改（换成远程 MCP、移除临时 Skill）从下一轮生效，Runner 会话不重建
    await turn(service, session["id"], "继续")
    assert runner.caps[-1]["mcp"][0]["serverName"] == "tickets"
    saved = await service.set_capabilities(session["id"], CapabilityChoice(mcpServerIds=[remote.id]))
    assert saved["capabilities"]["mcpServerIds"] == [remote.id]
    await turn(service, session["id"], "查文档")
    latest = runner.caps[-1]
    assert [skill["name"] for skill in latest["skills"]] == ["weekly-report"]
    assert latest["mcp"][0]["transport"] == "streamable-http"
    assert latest["mcp"][0]["headers"] == {"Authorization": "Bearer http-secret"}
    assert len(runner.created) == 1

    # 管理员停用 MCP 后：下一轮不再下发，并在摘要中标记不可用（不阻断对话）
    async with env["sessions"]() as db:
        row = await db.get(McpServer, remote.id)
        row.enabled = False
        await db.commit()
    receipt = await turn(service, session["id"], "再查")
    assert runner.caps[-1]["mcp"] == []
    assert receipt["activeCapabilities"]["unavailable"] == [
        {"kind": "mcp", "id": remote.id, "title": "docs-search"}
    ]


@pytest.mark.asyncio
async def test_invalid_chat_selection_is_rejected_without_side_effects(env, tmp_path):  # noqa: F811
    async with env["sessions"]() as db:
        draft = await add_skill(db, tmp_path, "草稿", published=False)
        broken = await add_mcp(db, "broken", status="error")
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    for choice, status, message in [
        (CapabilityChoice(skillIds=[draft.id]), 422, "尚未发布"),
        (CapabilityChoice(mcpServerIds=[broken.id]), 422, "MCP 服务不可用"),
        (CapabilityChoice(webSearch=True), 409, "联网搜索未开启"),
    ]:
        with pytest.raises(HTTPException) as error:
            await service.start(session["id"], "hi", capabilities=choice)
        assert error.value.status_code == status and message in error.value.detail
        with pytest.raises(HTTPException):
            await service.set_capabilities(session["id"], choice)
    detail = await service.detail(session["id"])
    assert detail["messages"] == []
    assert detail["capabilities"] == {"skillIds": [], "mcpServerIds": [], "webSearch": False}
    assert env["runner"].created == []


@pytest.mark.asyncio
async def test_web_settings_hide_keys_and_fall_back_to_deepseek_model_key(env):  # noqa: F811
    from src.api.models.platform import ModelConnection

    async with env["sessions"]() as db:
        view = await web_settings_view(db)
        assert view["enabled"] is False and view["available"] is False
        assert view["keySource"] == "none"
        db.add(
            ModelConnection(
                name="DeepSeek",
                base_url="https://api.deepseek.com/v1",
                model="deepseek-chat",
                credential="encrypted:model-secret",
            )
        )
        await db.commit()
        view = await save_web_settings(db, WebSearchInput(enabled=True))
        assert view["keySource"] == "model" and view["searchReady"] is True
        assert "model-secret" not in json.dumps(view)
        assert (await caps_module._runtime_web(db, "chat"))["apiKey"] == "model-secret"
        view = await save_web_settings(db, WebSearchInput(enabled=True, apiKey="own-key"))
        assert view["keySource"] == "custom" and view["apiKeyConfigured"] is True
        assert (await caps_module._runtime_web(db, "chat"))["apiKey"] == "own-key"
        # 保存时不传密钥会保留原密钥；clearKey 才会清除
        view = await save_web_settings(db, WebSearchInput(enabled=True, fetchEnabled=False))
        assert view["apiKeyConfigured"] is True
        view = await save_web_settings(db, WebSearchInput(enabled=True, clearKey=True, fetchEnabled=False))
        assert view["keySource"] == "model"
        options = await caps_module.options(db)
        assert options["web"]["available"] is True and "apiKey" not in json.dumps(options)
