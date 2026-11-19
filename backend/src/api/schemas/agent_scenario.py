from typing import Any, Literal
from pydantic import BaseModel, Field, field_validator


class CapabilitySelection(BaseModel):
    plugin_names: list[str] = Field(default_factory=list)
    plugin_tools: dict[str, list[str]] = Field(default_factory=dict)
    skill_ids: list[int] = Field(default_factory=list)
    mcp_server_ids: list[int] = Field(default_factory=list)
    builtin_tool_names: list[str] = Field(default_factory=list)
    # 已废弃：关联代码改为聊天中按会话选择；保留字段以兼容旧场景数据，装配时忽略
    project_ids: list[str] = Field(default_factory=list)
    # 联网搜索（web_search / web_fetch）：需平台在治理中心开启并配置
    web_search: bool = False


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
