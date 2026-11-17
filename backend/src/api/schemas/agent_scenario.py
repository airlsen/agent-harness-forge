"""场景相关请求/响应契约（与 frontend/src/types/agent.ts 对齐）。"""

from typing import Any

from pydantic import BaseModel, Field


class CapabilitySelection(BaseModel):
    """能力声明：场景勾选的能力组合（解析后的 id 形态）。"""

    plugin_names: list[str] = []
    skill_ids: list[int] = []
    mcp_server_ids: list[int] = []
    builtin_tool_names: list[str] = []
    project_ids: list[str] = []


class ScenarioPayload(BaseModel):
    """场景装配单（请求与 AI 生成草稿同构，同旧 ClaudeScenarioPayload 思想）。"""

    name: str = Field(max_length=128)
    description: str = ""
    icon: str = "ri-robot-line"
    prompt_template: str = ""  # 支持 {{变量}}
    capabilities: CapabilitySelection = CapabilitySelection()
    model: str = "deepseek-chat"  # 路由标签，实际走模型网关策略
    execution_mode: str = "standard"  # standard | ptc
    input_schema: dict[str, Any] | None = None


class CreateScenarioRequest(ScenarioPayload):
    pass


class UpdateScenarioRequest(ScenarioPayload):
    change_log: str = ""


class GenerateScenarioRequest(BaseModel):
    description: str = Field(min_length=4, max_length=2000)


class ScenarioResponse(BaseModel):
    id: int
    space: str
    owner_id: str
    status: str
    current_version: int
    payload: ScenarioPayload

    model_config = {"from_attributes": True}
