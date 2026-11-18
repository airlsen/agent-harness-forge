"""Scenario → 不变 Bundle；只装配审核过、版本冻结的能力。"""

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..schemas.agent_scenario import ScenarioPayload
from .plugin_service import approved_bindings
from .settings_service import TOOL_NAMES


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


class ScenarioAssembler:
    async def compile(
        self,
        db: AsyncSession,
        scenario: ScenarioPayload,
        *,
        tenant_policy: dict,
        rendered_prompt: str,
    ) -> Bundle:
        caps = scenario.capabilities
        requested_plugins = list(dict.fromkeys(caps.plugin_names))
        if set(caps.builtin_tool_names) - TOOL_NAMES:
            raise HTTPException(422, "包含尚未接入的基础工具")
        if caps.skill_ids or caps.mcp_server_ids or caps.project_ids:
            raise HTTPException(422, "当前部署尚未挂载 Skill/MCP/项目，请先移除无效能力")
        if scenario.model not in ("default", ""):
            raise HTTPException(422, "当前请使用 default 模型路由，在模型中心设置实际模型")
        if scenario.input_schema is not None:
            raise HTTPException(422, "当前工作台仅支持文本任务输入，结构化输入表单尚未接入")
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
                        "插件工具的权限不高于场景和平台策略；写入或对外动作必须等待审批。",
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
                "policy": tenant_policy,
                "scenarioName": scenario.name,
            },
        )
