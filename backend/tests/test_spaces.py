"""空间：列表过滤（本空间 + 公共）、引用校验、移动、基础工具开关、删除转移。"""

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from src.api.core import security
from src.api.models.agent_session import AgentSession
from src.api.models.registry import McpServer, PluginRegistry
from src.api.models.skill import Skill
from src.api.models.space import PUBLIC_SPACE_ID, Space
from src.api.schemas.agent_scenario import CapabilitySelection, ScenarioPayload
from src.api.services import capability_service, plugin_service, skill_service, space_service
from src.api.services import session_service as session_module
from src.api.services.capability_service import CapabilityChoice
from src.api.services.mcp_service import import_servers
from src.api.services.scenario_service import scenario_service
from src.api.models.platform import PlatformSetting
from src.api.services.settings_service import PolicyInput
from src.api.services.space_service import SpaceInput

# 复用会话切换测试的内存数据库、假 Runner 与加密替身
from test_session_switch import env, fake_crypto  # noqa: F401


@pytest.fixture(autouse=True)
def fake_security(monkeypatch, tmp_path):
    monkeypatch.setattr(security, "encrypt", lambda value: f"encrypted:{value}")
    monkeypatch.setattr(security, "decrypt", lambda value: value.removeprefix("encrypted:"))
    monkeypatch.setattr(skill_service.settings, "data_dir", tmp_path)
    capability_service.forget_snapshots()


async def make_space(db, name, **extra):
    return await space_service.create_space(db, SpaceInput(name=name, **extra))


async def published_skill(db, name, space_id=None):
    created = await skill_service.create_skill(db, name, f"{name}说明", None, "admin", space_id)
    await skill_service.publish_skill(db, created["id"], "admin")
    return created["id"]


async def runnable_mcp(db, name, space_id):
    row = McpServer(
        name=name,
        url="https://mcp.example.test/mcp",
        transport="streamable-http",
        enabled=True,
        status="connected",
        tools_json=[{"name": "lookup", "description": "查询"}],
        space_id=space_id,
    )
    db.add(row)
    await db.commit()
    return row.id


def approved_plugin(plugin_id, space_id, tool):
    return PluginRegistry(
        package=plugin_id,
        plugin_id=plugin_id,
        version="0.1.0",
        display_name=plugin_id,
        artifact_hash="sha256-test",
        runtime="forge-bridge",
        tools_json=[{"name": tool, "permission": "read"}],
        audit_status="approved",
        enabled=True,
        is_default=True,
        space_id=space_id,
    )


def scenario(name, **caps):
    return ScenarioPayload(name=name, prompt_template="帮助用户", capabilities=CapabilitySelection(**caps))


# —— 空间增删改 ——


@pytest.mark.asyncio
async def test_public_space_is_built_in_and_protected(env):
    async with env["sessions"]() as db:
        items = await space_service.list_spaces(db)
        assert [item["name"] for item in items] == ["公共"]
        public = items[0]
        assert public["id"] == PUBLIC_SPACE_ID and public["isPublic"] and public["color"] == "gray"
        # 已有内容（测试夹具里的场景）都在公共空间
        assert public["counts"]["scenarios"] == 1
        with pytest.raises(HTTPException) as error:
            await space_service.update_space(db, PUBLIC_SPACE_ID, SpaceInput(name="改名"))
        assert error.value.status_code == 409
        # 公共空间只能改说明
        updated = await space_service.update_space(
            db, PUBLIC_SPACE_ID, SpaceInput(name="公共", description="全公司共用")
        )
        assert updated["description"] == "全公司共用" and updated["name"] == "公共"
        with pytest.raises(HTTPException) as error:
            await space_service.delete_space(db, PUBLIC_SPACE_ID, None)
        assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_space_name_rules_and_auto_color(env):
    async with env["sessions"]() as db:
        finance = await make_space(db, "财务", description="财务部")
        rd = await make_space(db, "研发")
        # 自动挑没用过的颜色
        assert finance["color"] != rd["color"]
        assert finance["color"] in space_service.SPACE_COLORS
        for bad, status in (("", 422), ("一" * 21, 422), ("财务", 409), ("公共", 409)):
            with pytest.raises(HTTPException) as error:
                await make_space(db, bad)
            assert error.value.status_code == status, bad
        with pytest.raises(HTTPException) as error:
            await make_space(db, "市场", color="black")
        assert error.value.status_code == 422
        with pytest.raises(HTTPException):
            await make_space(db, "市场", description="说" * 101)
        renamed = await space_service.update_space(db, rd["id"], SpaceInput(name="研发中心", color="pink"))
        assert renamed["name"] == "研发中心" and renamed["color"] == "pink"
        with pytest.raises(HTTPException) as error:
            await space_service.update_space(db, rd["id"], SpaceInput(name="财务"))
        assert error.value.status_code == 409
        # 列表：公共在最前，其余按名称
        names = [item["name"] for item in await space_service.list_spaces(db)]
        assert names[0] == "公共" and set(names[1:]) == {"财务", "研发中心"}


@pytest.mark.asyncio
async def test_current_space_header_resolution(env):
    async with env["sessions"]() as db:
        finance = await make_space(db, "财务")
        assert await space_service.resolve_space_id(db, None) is None
        assert await space_service.resolve_space_id(db, "") is None
        assert await space_service.resolve_space_id(db, str(finance["id"])) == finance["id"]
        # 已删除或无效的空间回到公共空间
        assert await space_service.resolve_space_id(db, "999") == PUBLIC_SPACE_ID
        assert await space_service.resolve_space_id(db, "abc") == PUBLIC_SPACE_ID


# —— 列表过滤 ——


@pytest.mark.asyncio
async def test_lists_show_current_space_plus_public(env):
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        public_skill = await published_skill(db, "公共周报")
        finance_skill = await published_skill(db, "报销规范", finance)
        rd_skill = await published_skill(db, "代码评审", rd)
        await runnable_mcp(db, "finance-erp", finance)
        await runnable_mcp(db, "rd-git", rd)
        await runnable_mcp(db, "shared-search", PUBLIC_SPACE_ID)
        db.add_all(
            [
                approved_plugin("finance-plugin", finance, "finance_tool"),
                approved_plugin("rd-plugin", rd, "rd_tool"),
            ]
        )
        await db.commit()
        await scenario_service.create(db, "admin", scenario("报销助手"), space_id=finance)
        await scenario_service.create(db, "admin", scenario("研发助手"), space_id=rd)

        def names(items):
            return {item["payload"]["name"] if "payload" in item else item["name"] for item in items}

        # 场景
        assert names(await scenario_service.list_mine(db, "admin", finance)) == {"通用助手", "报销助手"}
        assert names(await scenario_service.list_mine(db, "admin", rd)) == {"通用助手", "研发助手"}
        assert names(await scenario_service.list_mine(db, "admin", PUBLIC_SPACE_ID)) == {"通用助手"}
        # 不带空间（旧客户端）看到全部
        assert len(await scenario_service.list_mine(db, "admin")) == 3
        # Skill（管理列表、已发布列表、能力选项）
        assert {item["id"] for item in await skill_service.list_skills(db, finance)} == {
            public_skill,
            finance_skill,
        }
        assert {item["id"] for item in await skill_service.list_published_skills(db, rd)} == {
            public_skill,
            rd_skill,
        }
        options = await capability_service.options(db, finance)
        assert {item["id"] for item in options["skills"]} == {public_skill, finance_skill}
        assert names(options["mcpServers"]) == {"finance-erp", "shared-search"}
        # 公共内容带标记
        assert {item["id"]: item["isPublic"] for item in options["skills"]} == {
            public_skill: True,
            finance_skill: False,
        }
        # 插件
        items, _ = await plugin_service.list_plugins(db, finance)
        packages = {item["package"] for item in items}
        assert "finance-plugin" in packages and "rd-plugin" not in packages
        # 场景视图带空间信息
        finance_view = next(
            item
            for item in await scenario_service.list_mine(db, "admin", finance)
            if item["payload"]["name"] == "报销助手"
        )
        assert finance_view["spaceId"] == finance and finance_view["spaceInfo"]["name"] == "财务"


@pytest.mark.asyncio
async def test_sessions_follow_space_and_list_by_space(env):
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        finance_scenario = await scenario_service.create(db, "admin", scenario("报销助手"), space_id=finance)
    service = session_module.SessionService()
    model_id = env["models"]["chat"]["id"]
    # 公共场景在财务空间发起：会话属于财务空间
    in_finance = await service.create(env["scenario"]["id"], model_id=model_id, space_id=finance)
    assert in_finance["spaceId"] == finance and in_finance["spaceInfo"]["name"] == "财务"
    # 财务场景只能在财务空间；在研发空间发起时跟随场景所在空间
    odd = await service.create(finance_scenario["id"], model_id=model_id, space_id=rd)
    assert odd["spaceId"] == finance
    in_public = await service.create(env["scenario"]["id"], model_id=model_id)
    assert in_public["spaceId"] == PUBLIC_SPACE_ID
    # 最近会话只看本空间；全部空间看到所有
    assert {item["id"] for item in await service.list(space_id=finance)} == {in_finance["id"], odd["id"]}
    assert {item["id"] for item in await service.list(space_id=rd)} == set()
    assert {item["id"] for item in await service.list(space_id=PUBLIC_SPACE_ID)} == {in_public["id"]}
    assert len(await service.list()) == 3
    detail = await service.detail(in_finance["id"])
    assert detail["spaceId"] == finance


# —— 引用校验 ——


@pytest.mark.asyncio
async def test_scenario_can_only_use_own_space_and_public(env):
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        public_skill = await published_skill(db, "公共周报")
        rd_skill = await published_skill(db, "代码评审", rd)
        rd_mcp = await runnable_mcp(db, "rd-git", rd)
        db.add(approved_plugin("rd-plugin", rd, "rd_tool"))
        await db.commit()
        ok = await scenario_service.create(
            db, "admin", scenario("报销助手", skill_ids=[public_skill]), space_id=finance
        )
        assert ok["spaceId"] == finance
        for caps in (
            {"skill_ids": [rd_skill]},
            {"mcp_server_ids": [rd_mcp]},
            {"plugin_names": ["rd-plugin"], "plugin_tools": {"rd-plugin": ["rd_tool"]}},
        ):
            with pytest.raises(HTTPException) as error:
                await scenario_service.create(db, "admin", scenario("越界", **caps), space_id=finance)
            assert error.value.status_code == 422 and "研发" in error.value.detail
        # 更新时同样检查
        with pytest.raises(HTTPException) as error:
            await scenario_service.update(db, "admin", ok["id"], scenario("报销助手", skill_ids=[rd_skill]))
        assert error.value.status_code == 422
        # 研发空间自己可以用
        await scenario_service.create(db, "admin", scenario("评审", skill_ids=[rd_skill]), space_id=rd)


@pytest.mark.asyncio
async def test_chat_capabilities_limited_to_session_space(env):
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        public_skill = await published_skill(db, "公共周报")
        rd_skill = await published_skill(db, "代码评审", rd)
        rd_mcp = await runnable_mcp(db, "rd-git", rd)
        chosen = await capability_service.validate_choice(
            db, CapabilityChoice(skillIds=[public_skill]), space_id=finance
        )
        assert chosen["skillIds"] == [public_skill]
        for choice in (CapabilityChoice(skillIds=[rd_skill]), CapabilityChoice(mcpServerIds=[rd_mcp])):
            with pytest.raises(HTTPException) as error:
                await capability_service.validate_choice(db, choice, space_id=finance)
            assert error.value.status_code == 422
        # 已在选择里的不重复检查（例如会话开始后才被移动）
        kept = await capability_service.validate_choice(
            db,
            CapabilityChoice(skillIds=[rd_skill]),
            {"skillIds": [rd_skill], "mcpServerIds": [], "webSearch": False},
            space_id=finance,
        )
        assert kept["skillIds"] == [rd_skill]


@pytest.mark.asyncio
async def test_skill_names_cannot_clash_with_public(env):
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        await published_skill(db, "周报")
        with pytest.raises(HTTPException) as error:
            await skill_service.create_skill(db, "周报", "说明", None, "admin", finance)
        assert error.value.status_code == 409 and "公共" in error.value.detail
        await db.rollback()
        # 不同的普通空间之间可以同名
        await skill_service.create_skill(db, "预算", "说明", None, "admin", finance)
        await skill_service.create_skill(db, "预算", "说明", None, "admin", rd)
        # 放进公共空间时，不能和任何空间的 Skill 重名
        with pytest.raises(HTTPException) as error:
            await skill_service.create_skill(db, "预算", "说明", None, "admin", PUBLIC_SPACE_ID)
        assert error.value.status_code == 409
        await db.rollback()
        # 改名（修改 title）同样检查
        own = await skill_service.create_skill(db, "差旅", "说明", None, "admin", finance)
        content = own["content"].replace("---\n\n", "title: 周报\n---\n\n", 1)
        with pytest.raises(HTTPException) as error:
            await skill_service.update_draft(db, own["id"], content, "改名", "admin")
        assert error.value.status_code == 409
        await db.rollback()
        assert (await db.get(Skill, own["id"])).name == "差旅"


@pytest.mark.asyncio
async def test_mcp_names_are_global_and_import_into_current_space(env, monkeypatch):
    from test_plugin_registry import public_dns

    monkeypatch.setattr("socket.getaddrinfo", public_dns)
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        config = {"mcpServers": {"erp": {"type": "http", "url": "https://erp.example.com/mcp"}}}
        [row] = await import_servers(db, config, finance)
        assert row.space_id == finance
        # 研发空间看不到财务的 erp，不能覆盖
        with pytest.raises(HTTPException) as error:
            await import_servers(db, config, rd)
        assert error.value.status_code == 409 and "财务" in error.value.detail
        # 财务空间可以更新自己的
        [again] = await import_servers(db, config, finance)
        assert again.id == row.id and again.space_id == finance


@pytest.mark.asyncio
async def test_plugin_upload_belongs_to_current_space(env, monkeypatch, tmp_path):
    from test_plugin_registry import public_dns, remote_archive, remote_manifest

    monkeypatch.setattr("socket.getaddrinfo", public_dns)
    monkeypatch.setattr(plugin_service, "ARTIFACT_ROOT", tmp_path / "artifacts")
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        uploaded = await plugin_service.import_archive(
            db, "acme.zip", remote_archive(remote_manifest()), finance
        )
        assert uploaded["spaceId"] == finance
        _, finance_submissions = await plugin_service.list_plugins(db, finance)
        _, rd_submissions = await plugin_service.list_plugins(db, rd)
        assert [item["package"] for item in finance_submissions] == ["acme-contacts"]
        assert rd_submissions == []
        # 新版本跟随插件所在空间；其他空间不能上传同一插件
        newer = {**remote_manifest(), "version": "1.2.4"}
        with pytest.raises(HTTPException) as error:
            await plugin_service.import_archive(db, "acme2.zip", remote_archive(newer), rd)
        assert error.value.status_code == 409
        second = await plugin_service.import_archive(db, "acme2.zip", remote_archive(newer), finance)
        assert second["spaceId"] == finance
        # 移动插件：所有版本一起移动
        await space_service.move_resource(db, "plugin", "acme-contacts", rd)
        rows = (
            await db.scalars(select(PluginRegistry).where(PluginRegistry.plugin_id == "acme-contacts"))
        ).all()
        assert {row.space_id for row in rows} == {rd}


# —— 移动 ——


@pytest.mark.asyncio
async def test_move_blocked_when_used_by_other_space(env):
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        skill_id = await published_skill(db, "报销规范", finance)
        used = await scenario_service.create(
            db, "admin", scenario("报销助手", skill_ids=[skill_id]), space_id=finance
        )
        # 财务的场景在用：不能移到研发
        check = await space_service.move_check(db, "skill", str(skill_id), rd)
        assert [item["name"] for item in check["blockers"]] == ["报销助手"]
        with pytest.raises(HTTPException) as error:
            await space_service.move_resource(db, "skill", str(skill_id), rd)
        assert error.value.status_code == 409 and "报销助手" in error.value.detail
        # 移入公共空间总是可以
        await space_service.move_resource(db, "skill", str(skill_id), PUBLIC_SPACE_ID)
        assert (await db.get(Skill, skill_id)).space_id == PUBLIC_SPACE_ID
        # 公共 → 研发：财务的场景还在用，不行
        with pytest.raises(HTTPException):
            await space_service.move_resource(db, "skill", str(skill_id), rd)
        # 公共 → 财务：使用它的场景就在财务，可以
        await space_service.move_resource(db, "skill", str(skill_id), finance)
        # 场景移到研发：依赖的 Skill 在研发不可用，列出来
        check = await space_service.move_check(db, "scenario", str(used["id"]), rd)
        assert [item["name"] for item in check["blockers"]] == ["报销规范"]
        with pytest.raises(HTTPException):
            await space_service.move_resource(db, "scenario", str(used["id"]), rd)


@pytest.mark.asyncio
async def test_move_keeps_existing_sessions_in_place(env):
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        created = await scenario_service.create(db, "admin", scenario("报销助手"), space_id=finance)
    service = session_module.SessionService()
    session = await service.create(created["id"], model_id=env["models"]["chat"]["id"], space_id=finance)
    async with env["sessions"]() as db:
        await space_service.move_resource(db, "scenario", str(created["id"]), rd)
        assert (await scenario_service.row(db, created["id"])).space_id == rd
        assert (await db.get(AgentSession, session["id"])).space_id == finance


@pytest.mark.asyncio
async def test_move_skill_name_conflict(env):
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        await skill_service.create_skill(db, "预算", "说明", None, "admin", finance)
        rd_skill = await skill_service.create_skill(db, "预算", "说明", None, "admin", rd)
        # 移进公共后两个空间都会看到同名 Skill
        check = await space_service.move_check(db, "skill", str(rd_skill["id"]), PUBLIC_SPACE_ID)
        assert check["conflicts"] and check["conflicts"][0]["conflictSpace"] == "财务"
        with pytest.raises(HTTPException) as error:
            await space_service.move_resource(db, "skill", str(rd_skill["id"]), PUBLIC_SPACE_ID)
        assert error.value.status_code == 409


# —— 基础工具开关 ——


@pytest.mark.asyncio
async def test_space_tool_switch_only_narrows_policy(env):
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        tools = ["todo_write", "bash"]
        finance_scenario = await scenario_service.create(
            db, "admin", scenario("报销助手", builtin_tool_names=tools), space_id=finance
        )
        rd_scenario = await scenario_service.create(
            db, "admin", scenario("研发助手", builtin_tool_names=tools), space_id=rd
        )
        # 关闭前列出本空间用到它的场景
        usage = await space_service.tool_usage(db, finance, "bash")
        assert [item["name"] for item in usage] == ["报销助手"]
        states = await space_service.set_tool_enabled(db, finance, "bash", False)
        bash = next(item for item in states if item["name"] == "bash")
        assert bash["spaceEnabled"] is False and bash["available"] is False and bash["policyAllowed"]
        # 研发不受影响
        rd_bash = next(item for item in await space_service.tool_states(db, rd) if item["name"] == "bash")
        assert rd_bash["available"] is True
    service = session_module.SessionService()
    model_id = env["models"]["chat"]["id"]
    finance_session = await service.detail(
        (await service.create(finance_scenario["id"], model_id=model_id, space_id=finance))["id"]
    )
    rd_session = await service.detail(
        (await service.create(rd_scenario["id"], model_id=model_id, space_id=rd))["id"]
    )
    assert finance_session["bundle"]["meta"]["builtin_tools"] == ["todo_write"]
    assert rd_session["bundle"]["meta"]["builtin_tools"] == tools
    # Runner 以 policy.allowedTools 为基础能力上限：空间关闭的工具不在上限里，不会被默认补回
    assert "bash" not in finance_session["bundle"]["meta"]["policy"]["allowedTools"]
    assert "bash" in rd_session["bundle"]["meta"]["policy"]["allowedTools"]
    async with env["sessions"]() as db:
        # 执行策略不允许的工具，任何空间都不能开启
        db.add(PlatformSetting(key="policy", value=PolicyInput(allowedTools=["todo_write"]).model_dump()))
        await db.commit()
        with pytest.raises(HTTPException) as error:
            await space_service.set_tool_enabled(db, finance, "bash", True)
        assert error.value.status_code == 409
        rd_bash = next(item for item in await space_service.tool_states(db, rd) if item["name"] == "bash")
        assert rd_bash["spaceEnabled"] is True and rd_bash["available"] is False
        with pytest.raises(HTTPException) as error:
            await space_service.set_tool_enabled(db, finance, "no_such_tool", False)
        assert error.value.status_code == 404


# —— 删除转移 ——


@pytest.mark.asyncio
async def test_delete_space_transfers_everything(env):
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        empty = (await make_space(db, "临时"))["id"]
        check = await space_service.delete_check(db, empty, None)
        assert check["empty"] is True
        await space_service.delete_space(db, empty, None)
        assert await db.get(Space, empty) is None

        skill_id = await published_skill(db, "报销规范", finance)
        mcp_id = await runnable_mcp(db, "finance-erp", finance)
        db.add(approved_plugin("finance-plugin", finance, "finance_tool"))
        await db.commit()
        created = await scenario_service.create(
            db, "admin", scenario("报销助手", skill_ids=[skill_id], mcp_server_ids=[mcp_id]), space_id=finance
        )
        await space_service.set_tool_enabled(db, finance, "bash", False)
    service = session_module.SessionService()
    session = await service.create(created["id"], model_id=env["models"]["chat"]["id"], space_id=finance)
    async with env["sessions"]() as db:
        check = await space_service.delete_check(db, finance, rd)
        assert check["empty"] is False
        assert check["space"]["counts"] == {
            "scenarios": 1,
            "skills": 1,
            "mcp": 1,
            "plugins": 1,
            "sessions": 1,
        }
        with pytest.raises(HTTPException) as error:
            await space_service.delete_check(db, finance, finance)
        assert error.value.status_code == 422
        result = await space_service.delete_space(db, finance, rd)
        assert result["movedTo"]["name"] == "研发"
        assert await db.get(Space, finance) is None
        assert (await scenario_service.row(db, created["id"])).space_id == rd
        assert (await db.get(Skill, skill_id)).space_id == rd
        assert (await db.get(McpServer, mcp_id)).space_id == rd
        assert (await db.get(AgentSession, session["id"])).space_id == rd
        plugin = await db.scalar(select(PluginRegistry).where(PluginRegistry.plugin_id == "finance-plugin"))
        assert plugin.space_id == rd
        # 工具开关随空间删除，不带到目标空间
        assert all(item["spaceEnabled"] for item in await space_service.tool_states(db, rd))


@pytest.mark.asyncio
async def test_delete_space_defaults_to_public_and_blocks_on_skill_conflicts(env):
    async with env["sessions"]() as db:
        finance = (await make_space(db, "财务"))["id"]
        rd = (await make_space(db, "研发"))["id"]
        await skill_service.create_skill(db, "预算", "说明", None, "admin", finance)
        await skill_service.create_skill(db, "预算", "说明", None, "admin", rd)
        check = await space_service.delete_check(db, finance, PUBLIC_SPACE_ID)
        assert [item["name"] for item in check["conflicts"]] == ["预算"]
        with pytest.raises(HTTPException) as error:
            await space_service.delete_space(db, finance, None)
        assert error.value.status_code == 409 and "预算" in error.value.detail
        assert await db.get(Space, finance) is not None
        # 转移到研发也冲突（研发已有同名）
        assert (await space_service.delete_check(db, finance, rd))["conflicts"]
        # 换一个空的目标空间就可以
        market = (await make_space(db, "市场"))["id"]
        assert not (await space_service.delete_check(db, finance, market))["conflicts"]
        await space_service.delete_space(db, finance, market)
        assert await db.get(Space, finance) is None
