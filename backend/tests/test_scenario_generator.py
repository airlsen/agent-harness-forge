"""AI 生成场景：只采用请求的字段，能力只能来自候选清单并自动勾选，联网需平台开启。"""

import json

import pytest
from fastapi import HTTPException

from src.api.schemas.agent_scenario import GenerateScenarioRequest
from src.api.services import llm_service, scenario_generator
from src.api.services.llm_service import LlmResult
from src.api.services.scenario_generator import ICONS, _shortlist, apply_result


def catalog(web=True):
    return {
        "skills": [
            {
                "ref": "S3",
                "id": 3,
                "name": "发票核验",
                "desc": "检查发票",
                "tags": [],
                "_text": "发票核验 检查发票",
            },
            {"ref": "S4", "id": 4, "name": "周报写作", "desc": "写周报", "tags": [], "_text": "周报写作"},
        ],
        "mcp": [{"ref": "M7", "id": 7, "name": "财务系统", "desc": "", "tools": [], "_text": "财务系统"}],
        "plugins": [
            {
                "ref": "P1",
                "package": "crm",
                "name": "CRM",
                "desc": "客户",
                "demo": False,
                "tools": [{"name": "crm_search", "desc": ""}, {"name": "crm_update", "desc": ""}],
                "_text": "CRM 客户",
            }
        ],
        "web": {"available": web, "reason": "" if web else "平台未开启联网搜索"},
    }


def ai_output(**overrides):
    value = {
        "name": "报销审核助手",
        "description": "检查报销单与发票是否合规",
        "icon": "shield",
        "prompt": "## 角色\n财务审核员",
        "capabilities": {
            "skills": [
                {"ref": "S3", "reason": "核验发票"},
                {"ref": "S99", "reason": "编造的"},
                {"ref": "S3", "reason": "重复"},
            ],
            "mcp": [{"ref": "M7", "reason": "查报销单"}],
            "plugins": [{"ref": "P1", "tools": ["crm_search", "not_exist"], "reason": "查客户"}],
            "web_search": {"enabled": True, "reason": "查政策"},
        },
        "missing": [{"name": "OCR 识别", "reason": "发票是图片"}],
    }
    value.update(overrides)
    return value


def test_apply_result_auto_selects_only_catalog_capabilities():
    draft = {"capabilities": {"builtin_tool_names": ["bash"], "skill_ids": [4]}}
    out = apply_result(ai_output(), draft, catalog(), scenario_generator.GENERATE_FIELDS)
    result = out["draft"]
    assert result["name"] == "报销审核助手"
    assert result["icon"] == "shield"
    caps = result["capabilities"]
    # 编造的和重复的被丢弃；原有但 AI 未保留的 Skill 被替换
    assert caps["skill_ids"] == [3]
    assert caps["mcp_server_ids"] == [7]
    assert caps["plugin_names"] == ["forge-runtime", "crm"]
    assert caps["plugin_tools"] == {"crm": ["crm_search"]}
    assert caps["web_search"] is True
    # 基础工具不受 AI 影响
    assert caps["builtin_tool_names"] == ["bash"]
    assert out["reasons"] == {
        "skill:3": "核验发票",
        "mcp:7": "查报销单",
        "plugin:crm": "查客户",
        "web": "查政策",
    }
    assert out["missing"] == [{"name": "OCR 识别", "reason": "发票是图片"}]
    assert out["applied"] == ["name", "description", "icon", "prompt", "capabilities"]


def test_web_search_is_not_selected_when_platform_disabled():
    out = apply_result(ai_output(), {}, catalog(web=False), ["capabilities"])
    assert out["draft"]["capabilities"]["web_search"] is False
    assert "web" not in out["reasons"]
    assert any("联网" in notice for notice in out["notices"])


def test_only_requested_fields_are_applied():
    draft = {
        "name": "我的名字",
        "description": "旧介绍",
        "icon": "code",
        "prompt_template": "旧提示词",
        "capabilities": {"skill_ids": [4], "plugin_names": ["forge-runtime"]},
    }
    out = apply_result(ai_output(), draft, catalog(), ["description"])
    result = out["draft"]
    assert result["description"] == "检查报销单与发票是否合规"
    assert result["name"] == "我的名字"
    assert result["icon"] == "code"
    assert result["prompt_template"] == "旧提示词"
    assert result["capabilities"]["skill_ids"] == [4]
    assert out["applied"] == ["description"]
    assert out["missing"] == []


def test_invalid_icon_and_plugin_without_tools_fall_back_safely():
    output = ai_output(icon="rocket")
    output["capabilities"]["plugins"] = [{"ref": "P1", "reason": "全部工具"}]
    out = apply_result(output, {}, catalog(), scenario_generator.GENERATE_FIELDS)
    assert out["draft"]["icon"] == "sparkles"
    assert "icon" not in out["applied"]
    # 没写工具时用插件全部可用工具
    assert out["draft"]["capabilities"]["plugin_tools"] == {"crm": ["crm_search", "crm_update"]}


def test_empty_output_is_rejected_so_model_retries():
    with pytest.raises(ValueError):
        apply_result({"capabilities": "oops"}, {}, catalog(), ["name"])


def test_shortlist_keeps_selected_and_most_relevant():
    items = [{"ref": f"S{i}", "_text": "周报" if i == 5 else "其他内容"} for i in range(10)]
    picked = _shortlist(items, scenario_generator._grams("写周报"), 3, keep={"S9"})
    refs = [item["ref"] for item in picked]
    assert refs[0] == "S9"
    assert "S5" in refs
    assert len(refs) == 3


@pytest.mark.asyncio
async def test_generate_sends_catalog_and_draft_to_model(monkeypatch):
    async def fake_catalog(db, space_id):
        assert space_id == 2
        return catalog()

    sent = {}

    async def fake_complete(db, *, messages, **options):
        sent["messages"] = messages
        sent["options"] = options
        return LlmResult(text=json.dumps(ai_output(), ensure_ascii=False), model={"id": 1}, usage={})

    monkeypatch.setattr(scenario_generator, "build_catalog", fake_catalog)
    monkeypatch.setattr(llm_service, "complete", fake_complete)
    req = GenerateScenarioRequest(
        requirement="帮财务审核报销单",
        draft={"name": "", "capabilities": {"skill_ids": [4]}},
        fields=["name", "capabilities"],
    )
    out = await scenario_generator.generate(None, req, 2)
    system, user = sent["messages"][0]["content"], sent["messages"][1]["content"]
    assert "场景设计助手" in system
    assert "、".join(ICONS) in system
    assert "帮财务审核报销单" in user
    assert '"ref": "S3"' in user and '"ref": "M7"' in user and '"ref": "P1"' in user
    # 内部字段不发给模型
    assert "_text" not in user and '"package"' not in user
    assert "name（名称）" in user and "prompt（提示词）" not in user
    assert sent["options"]["json_mode"] is True
    assert sent["options"]["purpose"] == "scenario.generate"
    assert out["applied"] == ["name", "capabilities"]
    assert out["draft"]["capabilities"]["skill_ids"] == [3]
    assert out["draft"]["description"] == ""


@pytest.mark.asyncio
async def test_generate_requires_some_input():
    with pytest.raises(HTTPException) as error:
        await scenario_generator.generate(None, GenerateScenarioRequest(requirement="  "), None)
    assert error.value.status_code == 422


def test_apply_result_accepts_plain_boolean_web_search():
    data = {"capabilities": {"web_search": True}}
    out = apply_result(data, {}, catalog(web=False), ["capabilities"])
    assert out["draft"]["capabilities"]["web_search"] is False
    assert any("联网" in notice for notice in out["notices"])
    out = apply_result(data, {}, catalog(), ["capabilities"])
    assert out["draft"]["capabilities"]["web_search"] is True
