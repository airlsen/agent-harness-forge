from typing import Literal

from pydantic import BaseModel, Field


class SkillCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=512)
    content: str | None = Field(default=None, max_length=64000)


class SkillDraftUpdate(BaseModel):
    content: str = Field(min_length=1, max_length=64000)
    change_summary: str = Field(default="手动编辑草稿", max_length=500)


class SkillFileWrite(BaseModel):
    path: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=120000)
    change_summary: str = Field(default="", max_length=500)


class SkillTurn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    # 从本轮起使用的模型；不传沿用对话当前模型（与工作台一致）
    modelId: int | None = Field(default=None, gt=0)


class SkillAuthoringSessionCreate(BaseModel):
    # 新对话使用的模型；不传则跟随平台默认模型
    modelId: int | None = Field(default=None, gt=0)


class SkillApprovalDecision(BaseModel):
    action: Literal["approve", "deny"]
