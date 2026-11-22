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
    skill_snapshot_id,
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
    # 已知快照缓存按进程保存；各测试的内存数据库会复用修订编号，逐个测试清空
    caps_module.forget_snapshots()


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


def test_skill_snapshot_id_matches_runner_algorithm():
    # 与 runner/scripts/check-capabilities.mjs 的同一夹具保持一致：两端必须得到相同的快照目录名
    document = "---\nname: demo\n---\n\n# 演示\n"
    files = [{"path": "references/b.md", "content": "B"}, {"path": "assets/a.md", "content": "甲"}]
    assert skill_snapshot_id(7, document, files) == "7-805488fce25c"
    assert skill_snapshot_id(7, document, list(reversed(files))) == "7-805488fce25c"
    assert skill_snapshot_id(7, document + " ", files) != "7-805488fce25c"
    assert skill_snapshot_id(None, document, files).startswith("0-")


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
    # 首次使用：创建会话时下发全文；Runner 已持有内容，紧接着的第一轮只发快照引用
    assert runner.caps[0] == caps_module.as_refs(sent)
    assert all(
        set(skill) == {"name", "title", "description", "revisionId", "snapshot", "source"}
        for skill in runner.caps[0]["skills"]
    )
    assert [skill["name"] for skill in sent["skills"]] == ["weekly-report", f"weekly-report-{extra.id}"]
    assert sent["skills"][0]["content"] == SKILL_BODY
    # 完整原文与修订号一并下发：Runner 原样写成快照目录里的 SKILL.md
    async with env["sessions"]() as db:
        bound_revision = await db.get(SkillRevision, (await db.get(Skill, bound.id)).published_revision_id)
    assert sent["skills"][0]["document"] == bound_revision.content
    assert sent["skills"][0]["document"].startswith("---\nname: weekly-report\n")
    assert sent["skills"][0]["revisionId"] == bound_revision.id
    # 旧格式参考资料记录也按完整目录下发
    assert sent["skills"][0]["files"] == [{"path": "references/glossary.md", "content": "术语表"}]
    assert sent["skills"][0]["source"] == "scenario" and sent["skills"][1]["source"] == "chat"
    assert sent["mcp"] == [
        {
            "serverName": "tickets",
            "title": "tickets",
            "source": "chat",
            "tools": [
                # MCP 工具不再按标注逐次确认：未声明只读的工具同样直接执行
                {"name": "lookup", "permission": "read"},
                {"name": "create_ticket", "permission": "read"},
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
    # 摘要记录本轮实际装配的修订与快照目录名
    assert summary["skills"][0]["revisionId"] == bound_revision.id
    assert summary["skills"][0]["snapshot"] == skill_snapshot_id(
        bound_revision.id, bound_revision.content, sent["skills"][0]["files"]
    )
    assert summary["skills"][1]["snapshot"].startswith(f"{sent['skills'][1]['revisionId']}-")
    assert summary["mcp"][0]["approvalTools"] == 0
    assert summary["web"] == {"search": True, "fetch": True, "source": "scenario"}
    dumped = json.dumps(first["messageMeta"], ensure_ascii=False)
    for secret in ("mcp-secret", "web-secret", "server.js", "结论先行", "术语表"):
        assert secret not in dumped
    assert first["capabilities"] == {"skillIds": [extra.id], "mcpServerIds": [server.id], "webSearch": False}

    # 不传沿用；修改（换成远程 MCP、移除临时 Skill）随下一条消息提交并从这一轮生效，Runner 会话不重建
    await turn(service, session["id"], "继续")
    assert runner.caps[-1]["mcp"][0]["serverName"] == "tickets"
    assert [skill["snapshot"] for skill in runner.caps[-1]["skills"]] == [skill["snapshot"] for skill in sent["skills"]]
    assert "content" not in runner.caps[-1]["skills"][0]
    assert runner.missing_requests == []
    saved = await turn(
        service, session["id"], "查文档", capabilities=CapabilityChoice(mcpServerIds=[remote.id])
    )
    assert saved["capabilities"]["mcpServerIds"] == [remote.id]
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
async def test_skill_with_missing_file_is_skipped_with_reason_without_blocking_turn(env, tmp_path):  # noqa: F811
    runner = env["runner"]
    async with env["sessions"]() as db:
        broken = await add_skill(db, tmp_path, "周报助手", references=[("glossary.md", "术语表")])
        bare = await add_skill(db, tmp_path, "翻译")  # 只有 SKILL.md
        revision = await db.get(SkillRevision, broken.published_revision_id)
        (tmp_path / revision.reference_files[0]["path"]).unlink()
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    receipt = await turn(
        service, session["id"], "写周报", capabilities=CapabilityChoice(skillIds=[broken.id, bare.id])
    )
    # 只有残缺的 Skill 被跳过，其余照常装配；不会下发缺文件的 Skill（也就不会出现残缺的快照目录）
    sent = runner.created_caps[-1]["skills"]
    assert [item["title"] for item in sent] == ["翻译"]
    assert sent[0]["files"] == [] and sent[0]["document"].startswith("---\n")
    assert receipt["activeCapabilities"]["unavailable"] == [
        {"kind": "skill", "id": broken.id, "title": "周报助手", "reason": "缺少附加文件：references/glossary.md"}
    ]
    assert receipt["messageMeta"]["capabilities"]["unavailable"][0]["reason"].startswith("缺少附加文件")
    assert [item["title"] for item in receipt["activeCapabilities"]["skills"]] == ["翻译"]


@pytest.mark.asyncio
async def test_known_skill_snapshots_are_sent_as_refs_without_reading_files(env, tmp_path, monkeypatch):  # noqa: F811
    runner = env["runner"]
    async with env["sessions"]() as db:
        skill = await add_skill(db, tmp_path, "周报助手", references=[("glossary.md", "术语表")])
        revision = await db.get(SkillRevision, skill.published_revision_id)
    reads = []
    original = skill_service.read_entry
    monkeypatch.setattr(skill_service, "read_entry", lambda *args: reads.append(args) or original(*args))
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    choice = CapabilityChoice(skillIds=[skill.id])

    # 第一轮：首次使用该修订，读取文件并以全文创建 Runner 会话
    first = await turn(service, session["id"], "写周报", capabilities=choice)
    full = runner.created_caps[-1]["skills"][0]
    assert full["files"] == [{"path": "references/glossary.md", "content": "术语表"}]
    snapshot = first["messageMeta"]["capabilities"]["skills"][0]["snapshot"]
    assert full["snapshot"] == snapshot and snapshot.startswith(f"{revision.id}-")
    assert len(reads) == 1

    # 之后每轮：只发快照引用，不读文件内容、不传全文
    for message in ("继续", "再改改"):
        receipt = await turn(service, session["id"], message)
        assert runner.caps[-1]["skills"] == [caps_module.as_refs({"skills": [full]})["skills"][0]]
        assert receipt["messageMeta"]["capabilities"]["skills"][0]["snapshot"] == snapshot
    assert len(reads) == 1 and runner.missing_requests == []

    # Runner 缓存丢失（重启或淘汰）：返回缺少的快照，控制面补发全文并重试，本轮照常完成
    runner.known_snapshots.clear()
    receipt = await turn(service, session["id"], "Runner 忘了")
    assert runner.missing_requests == [[snapshot]]
    assert runner.caps[-1]["skills"][0]["files"] == full["files"]
    assert runner.caps[-1]["skills"][0]["document"] == revision.content
    detail = await service.detail(session["id"])
    assert detail["messages"][-1]["content"] == "re: Runner 忘了"
    assert len(reads) == 2

    # 已知快照的文件在两轮之间被删除：不读内容也能发现（只检查文件是否存在），只跳过这个 Skill
    (tmp_path / revision.reference_files[0]["path"]).unlink()
    receipt = await turn(service, session["id"], "继续写")
    assert runner.caps[-1]["skills"] == []
    assert receipt["activeCapabilities"]["unavailable"] == [
        {"kind": "skill", "id": skill.id, "title": "周报助手", "reason": "缺少附加文件：references/glossary.md"}
    ]


@pytest.mark.asyncio
async def test_runner_restart_restores_skills_by_backfilling_full_content(env, tmp_path):  # noqa: F811
    runner = env["runner"]
    async with env["sessions"]() as db:
        skill = await add_skill(db, tmp_path, "周报助手", references=[("glossary.md", "术语表")])
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    await turn(service, session["id"], "写周报", capabilities=CapabilityChoice(skillIds=[skill.id]))
    snapshot = runner.created_caps[0]["skills"][0]["snapshot"]

    # Runner 重启：内存会话与 Skill 缓存都没了。恢复请求先只带引用 → 缺内容 → 补发全文再恢复
    runner.alive = False
    runner.known_snapshots.clear()
    await turn(service, session["id"], "继续")
    assert runner.missing_requests == [[snapshot]]
    assert len(runner.restored) == 1
    restored_caps = runner.restored[0][4]
    assert restored_caps["skills"][0]["files"] == [{"path": "references/glossary.md", "content": "术语表"}]
    # 恢复后的这一轮只发引用
    assert "content" not in runner.caps[-1]["skills"][0]
    assert runner.caps[-1]["skills"][0]["snapshot"] == snapshot


@pytest.mark.asyncio
async def test_skill_files_are_sent_verbatim_and_oversized_files_are_not_truncated(env, tmp_path):  # noqa: F811
    runner = env["runner"]
    large = "汉" * 50_000  # 150 KB UTF-8：旧实现会按字符截断后下发
    async with env["sessions"]() as db:
        exact = await add_skill(db, tmp_path, "规范", references=[("rules.md", "第一行\r\n第二行 \n")])
        oversized = await add_skill(db, tmp_path, "超大", references=[("huge.md", large)])
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    receipt = await turn(
        service, session["id"], "hi", capabilities=CapabilityChoice(skillIds=[exact.id, oversized.id])
    )
    sent = runner.created_caps[-1]["skills"]
    assert [item["title"] for item in sent] == ["规范"]
    assert sent[0]["files"] == [{"path": "references/rules.md", "content": "第一行\r\n第二行 \n"}]
    assert receipt["activeCapabilities"]["unavailable"][0]["reason"] == "附加文件超过 120 KB：references/huge.md"


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


@pytest.mark.asyncio
async def test_unpublished_skill_stops_everywhere_and_can_be_deleted_after_removed_from_scenarios(
    env, tmp_path  # noqa: F811
):
    """下线：场景与聊天里从下一轮起跳过（摘要标记「已下线」）；被场景使用时不能删，移除后才能删。"""
    runner = env["runner"]
    async with env["sessions"]() as db:
        created = await skill_service.create_skill(db, "周报助手", "写周报", None, "admin")
        skill_id = created["id"]
        await skill_service.publish_skill(db, skill_id, "admin")
        chat_only = await skill_service.create_skill(db, "翻译", "翻译", None, "admin")
        await skill_service.publish_skill(db, chat_only["id"], "admin")
        # 上线中的不能删
        with pytest.raises(HTTPException) as error:
            await skill_service.delete_skill(db, skill_id)
        assert error.value.status_code == 409 and "先下线" in error.value.detail
        scenario = await scenario_service.create(
            db, "admin", ScenarioPayload(name="周报场景", capabilities=CapabilitySelection(skill_ids=[skill_id]))
        )
        row = await scenario_service.row(db, scenario["id"])
        row.status, row.published_version = "published", row.current_version
        await db.commit()
        usage = await skill_service.skill_usage(db, skill_id)
        assert usage == [
            {
                "id": scenario["id"],
                "name": "周报场景",
                "space": "personal",
                "spaceId": 1,
                "published": True,
                "draft": True,
            }
        ]

    service = session_module.SessionService()
    session = await service.create(scenario["id"], model_id=env["models"]["chat"]["id"])
    await turn(service, session["id"], "写周报", capabilities=CapabilityChoice(skillIds=[chat_only["id"]]))
    assert [skill["title"] for skill in runner.created_caps[-1]["skills"]] == ["周报助手", "翻译"]

    async with env["sessions"]() as db:
        offline = await skill_service.unpublish_skill(db, skill_id)
        assert offline["offline"] is True
        assert offline["publishedRevisionId"] is None and offline["publishedVersion"] is None
        assert offline["lastPublishedVersion"] == 1
        await skill_service.unpublish_skill(db, chat_only["id"])
        with pytest.raises(HTTPException) as error:
            await skill_service.unpublish_skill(db, skill_id)
        assert error.value.status_code == 409
        options = await caps_module.options(db)
        assert options["skills"] == []
        assert {item["title"] for item in options["offlineSkills"]} == {"周报助手", "翻译"}

    # 下一轮：场景绑定和临时选择的都跳过，摘要写明「已下线」，对话照常进行
    receipt = await turn(service, session["id"], "继续")
    assert runner.caps[-1]["skills"] == []
    assert receipt["activeCapabilities"]["unavailable"] == [
        {"kind": "skill", "id": skill_id, "title": "周报助手", "reason": "已下线"},
        {"kind": "skill", "id": chat_only["id"], "title": "翻译", "reason": "已下线"},
    ]
    with pytest.raises(HTTPException) as error:
        await service.start(session["id"], "再选", capabilities=CapabilityChoice(skillIds=[skill_id]))
    assert error.value.status_code == 422 and "周报助手（已下线）" in error.value.detail

    async with env["sessions"]() as db:
        # 场景仍在使用：不能删，并列出场景名称
        with pytest.raises(HTTPException) as error:
            await skill_service.delete_skill(db, skill_id)
        assert error.value.status_code == 409 and "「周报场景」" in error.value.detail
        # 场景仍勾着已下线的 Skill 时保存被拒绝，提示先移除
        with pytest.raises(HTTPException) as error:
            await scenario_service.update(
                db,
                "admin",
                scenario["id"],
                ScenarioPayload(name="周报场景", capabilities=CapabilitySelection(skill_ids=[skill_id])),
            )
        assert "周报助手（已下线）" in error.value.detail
        # 重新发布：版本号接着往下编
        republished = await skill_service.publish_skill(db, skill_id, "admin")
        assert republished["publishedVersion"] == 2 and republished["offline"] is False
        await skill_service.unpublish_skill(db, skill_id)
        # 从场景中移除并重新发布场景后才能删除
        await scenario_service.update(db, "admin", scenario["id"], ScenarioPayload(name="周报场景"))
        assert (await skill_service.skill_usage(db, skill_id))[0]["draft"] is False
        row = await scenario_service.row(db, scenario["id"])
        row.published_version = row.current_version
        await db.commit()
        assert await skill_service.skill_usage(db, skill_id) == []
        await skill_service.delete_skill(db, skill_id)
        assert await db.get(Skill, skill_id) is None

    # 删除后：仍挂在会话临时选择里的显示「已删除」
    receipt = await turn(service, session["id"], "最后一轮")
    assert {"kind": "skill", "id": skill_id, "title": "周报助手", "reason": "已删除"} in receipt[
        "activeCapabilities"
    ]["unavailable"]
