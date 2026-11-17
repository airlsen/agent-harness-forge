"""ScenarioAssembler：Scenario → Bundle 的唯一编译器（ADR-2）。

继承旧 `_build_options_input()` 的职责，但输出从"SDK Options"变为"不可变 Bundle 快照"：
  profile_patch（含 prompt 四分区）+ plugin_mounts + skill_files + mcp + model_route + policy_ref。
bundle_hash = sha256(canonical_json(bundle))，写进会话与审计，回放/复现的锚点。
"""

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from ..schemas.agent_scenario import ScenarioPayload

PLATFORM_IDENTITY = "你是 AgentHarness Forge 平台上的企业智能体…"  # TODO(M1): prompts 模块细化


@dataclass
class Bundle:
    profile_patch: dict[str, Any]
    plugin_mounts: list[str]               # 仅允许 plugin_registry 白名单内（验签在 Runner）
    skill_files: dict[str, str]            # 文件名 -> 内容（物化到沙箱工作区）
    mcp: list[dict[str, Any]]              # 认证走 auth_ref，密钥不内联
    model_route: dict[str, Any]            # primary + fallbacks（标签，网关解析）
    policy_ref: str                        # 治理策略快照 id（policy 插件本地判定用）
    input_schema: dict[str, Any] | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def bundle_hash(self) -> str:
        canonical = json.dumps(self.__dict__, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(canonical.encode()).hexdigest()


class ScenarioAssembler:
    """控制面侧唯一装配入口。"""

    def compile(
        self,
        scenario: ScenarioPayload,
        *,
        tenant_policy: dict[str, Any],
        rendered_prompt: str,
    ) -> Bundle:
        caps = scenario.capabilities
        return Bundle(
            profile_patch={
                "mode": scenario.execution_mode,  # standard | ptc（dsh 运行模式）
                "systemPrompt": {
                    "identity": PLATFORM_IDENTITY,
                    "domain": rendered_prompt,            # {{变量}} 已渲染
                    "safety": tenant_policy.get("safety_rules", []),
                    "workspace": tenant_policy.get("workspace_rules", []),
                },
            },
            plugin_mounts=self._resolve_plugins(caps.plugin_names),
            skill_files=self._materialize_skills(caps.skill_ids),      # TODO(M1): 查 skill 表
            mcp=self._resolve_mcp(caps.mcp_server_ids),                # TODO(M1): auth_ref 化
            model_route={"primary": scenario.model, "fallbacks": tenant_policy.get("fallbacks", [])},
            policy_ref=tenant_policy.get("policy_snapshot_id", ""),
            input_schema=scenario.input_schema,
            meta={"builtin_tools": caps.builtin_tool_names, "projects": caps.project_ids},
        )

    def _resolve_plugins(self, names: list[str]) -> list[str]:
        # TODO(M1): 校验 plugin_registry 白名单 + 版本 pin；未登记直接拒绝（企业安全红线）
        return names

    def _materialize_skills(self, skill_ids: list[int]) -> dict[str, str]:
        return {}  # TODO(M1): 沿袭旧 skill_materializer 逻辑

    def _resolve_mcp(self, mcp_ids: list[int]) -> list[dict[str, Any]]:
        return []  # TODO(M1): 查 mcp_server 表 → auth_ref（短期令牌由 runner 侧插件注入）
