from typing import Any, Literal
from pydantic import BaseModel, Field, field_validator


class CapabilitySelection(BaseModel):
    plugin_names: list[str] = Field(default_factory=list)
    skill_ids: list[int] = Field(default_factory=list)
    mcp_server_ids: list[int] = Field(default_factory=list)
    builtin_tool_names: list[str] = Field(default_factory=list)
    project_ids: list[str] = Field(default_factory=list)


class ScenarioPayload(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=512)
    icon: str = Field(default="sparkles", max_length=64)
    prompt_template: str = Field(default="", max_length=16000)
    capabilities: CapabilitySelection = Field(default_factory=CapabilitySelection)
    model: str = Field(default="default", max_length=128)
    execution_mode: Literal["standard"] = "standard"
    input_schema: dict[str, Any] | None = None

    @field_validator("name")
    @classmethod
    def nonempty_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("场景名称不能为空")
        return value


class CreateScenarioRequest(ScenarioPayload):
    pass


class UpdateScenarioRequest(ScenarioPayload):
    change_log: str = ""


class GenerateScenarioRequest(BaseModel):
    description: str = Field(min_length=4, max_length=2000)
