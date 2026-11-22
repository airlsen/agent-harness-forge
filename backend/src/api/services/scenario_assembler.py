"""Scenario → 不变 Bundle；只装配审核过、版本冻结的能力。"""

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..schemas.agent_scenario import ScenarioPayload
from .capability_service import freeze_scenario_mcp, freeze_scenario_skills
from .plugin_service import approved_bindings
from .settings_service import TOOL_NAMES
from .space_service import ensure_caps_visible


@dataclass
class Bundle:
    profile_patch: dict[str, Any]
    plugin_mounts: list[str]
    skill_files: dict[str, str]
    mcp: list[dict[str, Any]]
    model_route: dict[str, Any]
    policy_ref: str
    input_schema: dict | None
    meta: dict

    @property
    def bundle_hash(self) -> str:
        return hashlib.sha256(
            json.dumps(asdict(self), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()


def apply_current_policy(bundle: Bundle, tenant_policy: dict) -> Bundle:
    """Apply current tenant limits to a frozen scenario bundle for a new session.

    tenant_policy 已按会话所在空间收紧（space_service.effective_policy）：空间关闭的基础工具
    不在 allowedTools 里，Runner 以它为基础能力的上限。
    """
    allowed_tools = set(tenant_policy.get("allowedTools", []))
    allowed_plugin_tools = set(tenant_policy.get("allowedPluginTools", []))
    bundle.meta["builtin_tools"] = [
        name for name in bundle.meta.get("builtin_tools", []) if name in allowed_tools
    ]

    bindings = []
    for binding in bundle.meta.get("pluginBindings", []):
        tools = [
            tool
            for tool in binding.get("tools", [])
            if "*" in allowed_plugin_tools or tool.get("name") in allowed_plugin_tools
        ]
        if tools:
            bindings.append({**binding, "tools": tools})
    bundle.meta["pluginBindings"] = bindings
    bundle.meta["plugin_tools"] = [tool["name"] for binding in bindings for tool in binding["tools"]]

    bundle.plugin_mounts = [mount for mount in bundle.plugin_mounts if mount != "forge-plugin-bridge"]
    if bindings:
        bundle.plugin_mounts.append("forge-plugin-bridge")

    bundle.meta["policy"] = tenant_policy
    policy_json = json.dumps(tenant_policy, sort_keys=True)
    bundle.policy_ref = hashlib.sha256(policy_json.encode()).hexdigest()[:16]
    return bundle


class ScenarioAssembler:
    async def compile(
        self,
        db: AsyncSession,
        scenario: ScenarioPayload,
        *,
        tenant_policy: dict,
        rendered_prompt: str,
        space_id: int | None = None,
    ) -> Bundle:
        caps = scenario.capabilities
        requested_plugins = list(dict.fromkeys(caps.plugin_names))
        if set(caps.builtin_tool_names) - TOOL_NAMES:
            raise HTTPException(422, "包含尚未接入的基础工具")
        # project_ids（已由聊天「关联代码」取代）与 model（模型在聊天中选择）为兼容旧数据保留，装配时忽略。
        if len(set(caps.skill_ids)) != len(caps.skill_ids) or len(set(caps.mcp_server_ids)) != len(
            caps.mcp_server_ids
        ):
            raise HTTPException(422, "能力选择中有重复项")
        # Skill 冻结到当前已发布修订（修订不可变）；MCP 只记录服务引用，凭据与工具清单每轮实时解析。
        skills = await freeze_scenario_skills(db, list(caps.skill_ids))
        mcp_servers = await freeze_scenario_mcp(db, list(caps.mcp_server_ids))
        if scenario.input_schema is not None:
            raise HTTPException(422, "当前工作台仅支持文本任务输入，结构化输入表单尚未接入")
        if space_id is not None:
            # 场景只能使用本空间和公共空间的 Skill、MCP、插件
            await ensure_caps_visible(db, space_id, caps.skill_ids, caps.mcp_server_ids, requested_plugins)
        bindings = await approved_bindings(db, requested_plugins, caps.plugin_tools)
        builtin_tools = [
            name
            for name in dict.fromkeys(caps.builtin_tool_names)
            if name in tenant_policy.get("allowedTools", [])
        ]
        enterprise_plugin_allow = set(tenant_policy.get("allowedPluginTools", []))
        plugin_tools = [
            tool["name"]
            for binding in bindings
            for tool in binding["tools"]
            if "*" in enterprise_plugin_allow or tool["name"] in enterprise_plugin_allow
        ]
        rejected_by_enterprise = {tool["name"] for binding in bindings for tool in binding["tools"]} - set(
            plugin_tools
        )
        if rejected_by_enterprise:
            raise HTTPException(422, "企业策略未允许插件工具：" + "、".join(sorted(rejected_by_enterprise)))
        policy_json = json.dumps(tenant_policy, sort_keys=True)
        return Bundle(
            profile_patch={
                "mode": "standard",
                "systemPrompt": {
                    "identity": "你是 AgentHarness Forge 工作空间的企业智能体。请诚实、准确地完成用户任务。",
                    "domain": rendered_prompt,
                    "safety": [
                        "只使用当前场景已授权工具；不要编造工具结果、文件或网络访问。",
                        "插件工具的权限不高于场景和平台策略；需要确认的插件写入或对外动作必须等待审批。",
                    ],
                    "workspace": ["所有产物仅允许保存在当前会话的受限工作区。"],
                },
            },
            plugin_mounts=["forge-runtime", *(["forge-plugin-bridge"] if bindings else [])],
            skill_files={},
            mcp=[],
            model_route={"primary": "default", "fallbacks": []},
            policy_ref=hashlib.sha256(policy_json.encode()).hexdigest()[:16],
            input_schema=scenario.input_schema,
            meta={
                "builtin_tools": builtin_tools,
                "plugin_tools": plugin_tools,
                "pluginBindings": bindings,
                "skills": skills,
                "mcpServers": mcp_servers,
                "webSearch": caps.web_search,
                "policy": tenant_policy,
                "scenarioName": scenario.name,
            },
        )
