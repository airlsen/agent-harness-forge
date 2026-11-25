"""会话清单（SessionManifest）：控制面交给执行内核的唯一装配输入，带版本号。

- 这里的 Pydantic 模型是清单结构的唯一来源：`contracts/session-manifest.schema.json` 由它导出，
  Runner 的 TypeScript 类型再由该 JSON Schema 生成（runner/scripts/gen-manifest-types.mjs）。
  修改字段后执行 `make contracts` 重新生成；两侧的检查会拦住忘记生成的情况。
- 清单只含执行需要的内容。会话记录里的业务事实（场景名、模型价格、是否测试会话、环境指纹……）
  留在控制面的 Bundle 快照中，不下发给 Runner。
- 结构不兼容的改动必须提升 MANIFEST_VERSION；Runner 拒绝不认识的版本，避免两侧静默错配。
"""

import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .config import ROOT

MANIFEST_VERSION = 1
SCHEMA_PATH = ROOT / "contracts" / "session-manifest.schema.json"
# 清单总是完整序列化：导出的 Schema 把有默认值的字段也标为必填，Runner 侧类型因此没有可选歧义
_SCHEMA_CONFIG = ConfigDict(json_schema_serialization_defaults_required=True)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", **_SCHEMA_CONFIG)


class SystemPrompt(_Strict):
    """系统提示的四个部分；平台运行说明由 Runner 按会话实际能力追加。"""

    identity: str
    domain: str = ""
    safety: list[str] = Field(default_factory=list)
    workspace: list[str] = Field(default_factory=list)


class ManifestTools(_Strict):
    builtin: list[str] = Field(
        default_factory=list, description="场景声明的 Forge 内置工具，Runner 以 policy.allowedTools 为上限"
    )
    plugin: list[str] = Field(default_factory=list, description="已按企业插件策略筛选的受管插件工具")


class PluginBinding(BaseModel):
    """受管插件绑定：审核冻结的版本、制品摘要与授权工具（工具定义原样透传）。"""

    model_config = ConfigDict(extra="allow", **_SCHEMA_CONFIG)

    package: str
    displayName: str
    version: str
    artifactHash: str
    runtime: str
    execution: dict[str, Any] = Field(default_factory=dict)
    tools: list[dict[str, Any]]


class RuntimePolicy(BaseModel):
    """执行策略：Runner 读取下列字段，其余企业策略字段原样保留供审计。"""

    model_config = ConfigDict(extra="allow", **_SCHEMA_CONFIG)

    allowedTools: list[str] | None = None
    maxOutputTokens: int | None = None
    requestTimeoutSeconds: int | None = None
    approvalTimeoutSeconds: int | None = None
    askTimeoutSeconds: int | None = None


class DraftFile(_Strict):
    path: str
    content: str


class DesignGuide(_Strict):
    name: str
    content: str


class SkillAuthoringDraft(_Strict):
    """Skill 编写会话的草稿上下文（仅 skill-authoring 插件使用）。"""

    skillId: int
    name: str
    description: str = ""
    revisionId: int
    content: str
    files: list[DraftFile] = Field(default_factory=list)
    guides: list[DesignGuide] = Field(default_factory=list)


class SessionManifest(_Strict):
    """一个执行会话的完整装配输入（随创建 / 恢复请求下发；模型与扩展能力按轮下发，不在此处）。"""

    version: Literal[1] = MANIFEST_VERSION
    systemPrompt: SystemPrompt
    plugins: list[str] = Field(description="挂载的 Forge 插件包，Runner 只接受白名单内的名称")
    tools: ManifestTools = Field(default_factory=ManifestTools)
    pluginBindings: list[PluginBinding] = Field(default_factory=list)
    policy: RuntimePolicy = Field(default_factory=RuntimePolicy)
    policyRef: str = Field(description="执行策略指纹：Runner 会话的指纹与控制面不一致时按新清单重新装配")
    skillAuthoring: SkillAuthoringDraft | None = None


def manifest_from_bundle(bundle: dict) -> dict:
    """从控制面 Bundle 快照（含早期版本的快照）投影出下发给 Runner 的清单，并按模型校验。"""
    meta = bundle.get("meta") or {}
    manifest = SessionManifest(
        systemPrompt=(bundle.get("profile_patch") or {}).get("systemPrompt") or {},
        plugins=list(bundle.get("plugin_mounts") or []),
        tools=ManifestTools(
            builtin=list(meta.get("builtin_tools") or []), plugin=list(meta.get("plugin_tools") or [])
        ),
        pluginBindings=list(meta.get("pluginBindings") or []),
        policy=meta.get("policy") or {},
        policyRef=str(bundle.get("policy_ref") or ""),
        skillAuthoring=meta.get("skillAuthoring"),
    )
    return manifest.model_dump(mode="json")


def manifest_schema() -> dict:
    schema = SessionManifest.model_json_schema(mode="serialization")
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://forge.local/contracts/session-manifest.schema.json",
        "$comment": "由 backend/src/api/core/manifest.py 生成，请勿手改；修改后执行 make contracts",
        **schema,
    }


def render_schema() -> str:
    return json.dumps(manifest_schema(), ensure_ascii=False, indent=2) + "\n"


if __name__ == "__main__":
    import sys

    if "--check" in sys.argv:
        if SCHEMA_PATH.read_text(encoding="utf-8") != render_schema():
            sys.exit(
                "FAIL contracts/session-manifest.schema.json 与 core/manifest.py 不一致：请执行 make contracts"
            )
        print("PASS session manifest schema is exported from the current model")
    else:
        SCHEMA_PATH.write_text(render_schema(), encoding="utf-8")
        print(f"已生成 {SCHEMA_PATH}")
