"""通用大模型调用接口：直接用模型中心的模型回答提示词，不带工具、不创建会话。"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..services import llm_service
from ..utils.response import ResponseUtil

router = APIRouter()


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    # 两种写法任选：直接给 prompt（可配 system），或给完整的多轮 messages
    prompt: str = Field(default="", max_length=60000)
    system: str = Field(default="", max_length=60000)
    messages: list[ChatMessage] | None = None
    # 不传则使用平台默认模型
    modelId: int | None = None
    temperature: float = Field(default=0.3, ge=0, le=2)
    maxTokens: int = Field(default=2048, ge=1, le=16000)
    # 为 True 时要求模型输出 JSON 对象，结果在 data 中返回
    json_output: bool = Field(default=False, alias="json")


@router.post("/chat")
async def chat(req: ChatRequest, db: AsyncSession = Depends(get_session)):
    messages = [item.model_dump() for item in req.messages or []]
    if req.system.strip():
        messages.insert(0, {"role": "system", "content": req.system})
    if req.prompt.strip():
        messages.append({"role": "user", "content": req.prompt})
    if not messages:
        raise HTTPException(422, "请提供 prompt 或 messages")
    options = {
        "model_id": req.modelId,
        "temperature": req.temperature,
        "max_tokens": req.maxTokens,
        "purpose": "api.chat",
    }
    if req.json_output:
        data, result = await llm_service.complete_json(db, messages=messages, **options)
        return ResponseUtil.ok({**result.view(), "data": data})
    result = await llm_service.complete(db, messages=messages, **options)
    return ResponseUtil.ok(result.view())
