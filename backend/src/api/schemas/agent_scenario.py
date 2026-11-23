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


GENERATE_FIELDS = ["name", "description", "icon", "prompt", "capabilities"]


class GenerateScenarioRequest(BaseModel):
    """AI 生成场景：新建时按一句话需求生成整套配置；编辑时可只重新生成某几项。"""

    # 用户对场景的描述；编辑时可留空，按当前草稿补全或优化
    requirement: str = Field(default="", max_length=2000)
    # 当前编辑中的草稿（结构同 ScenarioPayload，允许尚未填写名称）
    draft: dict[str, Any] | None = None
    # 需要生成的字段；不传表示全部
    fields: list[Literal["name", "description", "icon", "prompt", "capabilities"]] | None = None
    # 编辑已有场景时传入，用于确定场景所在空间（只匹配该空间和公共空间的能力）
    scenarioId: int | None = None
    # 不传则使用平台默认模型
    modelId: int | None = None

    @field_validator("fields")
    @classmethod
    def nonempty_fields(cls, value):
        if value is not None and not value:
            raise ValueError("请至少选择一项要生成的内容")
        return value
