"""Scenario → 不变 Bundle；当前只允许已实现、可执行的能力。"""

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any
from fastapi import HTTPException
from ..schemas.agent_scenario import ScenarioPayload
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
    def compile(self, scenario: ScenarioPayload, *, tenant_policy: dict, rendered_prompt: str) -> Bundle:
        caps = scenario.capabilities
        if set(caps.plugin_names) - {"forge-runtime"}:
            raise HTTPException(422, "当前只能挂载已审核的 forge-runtime 业务插件")
        if set(caps.builtin_tool_names) - TOOL_NAMES:
            raise HTTPException(422, "包含尚未接入的工具")
        if caps.skill_ids or caps.mcp_server_ids or caps.project_ids:
            raise HTTPException(422, "当前部署尚未挂载 Skill/MCP/项目，不接受无效能力装配")
        if scenario.model not in ("default", ""):
            raise HTTPException(422, "当前请使用 default 模型路由，在模型中心设置实际模型")
        if scenario.input_schema is not None:
            raise HTTPException(422, "当前工作台仅支持文本任务输入，结构化输入表单尚未接入")
        policy_json = json.dumps(tenant_policy, sort_keys=True)
        return Bundle(
            profile_patch={
                "mode": "standard",
                "systemPrompt": {
                    "identity": "你是 AgentHarness Forge 工作空间的企业智能体。请诚实、准确地完成用户任务。",
                    "domain": rendered_prompt,
                    "safety": ["只使用已授权工具；不要编造工具结果、文件或网络访问。"],
                    "workspace": ["所有产物仅允许保存在当前会话的受限工作区。"],
                },
            },
            plugin_mounts=["forge-runtime"],
            skill_files={},
            mcp=[],
            model_route={"primary": "default", "fallbacks": []},
            policy_ref=hashlib.sha256(policy_json.encode()).hexdigest()[:16],
            input_schema=scenario.input_schema,
            meta={
                "builtin_tools": [
                    name
                    for name in dict.fromkeys(caps.builtin_tool_names)
                    if name in tenant_policy.get("allowedTools", [])
                ],
                "policy": tenant_policy,
                "scenarioName": scenario.name,
            },
        )
