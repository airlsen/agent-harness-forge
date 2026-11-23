"""通用大模型调用：直接请求模型中心配置的模型（OpenAI 兼容 Chat Completions）。

不经过执行内核、不带工具、不创建会话，适合「提示词进、结果出」的辅助功能（如 AI 生成场景）。

用法：
- ``complete``：传入消息，返回模型文本；
- ``complete_json``：要求模型输出 JSON，自动解析，格式不对时带上错误重试一次；
- ``run_task``：按 ``llm_prompts`` 中登记的提示词任务调用。新功能要用 AI，只需登记一个任务
  （系统提示词 + 用户提示词模板），再调用 ``run_task``。

密钥只在服务端使用，不会返回给调用方；每次调用的模型、用量与耗时写入服务日志。
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

import httpx
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .settings_service import get_connection

log = logging.getLogger(__name__)

T = TypeVar("T")

# 模型返回非 JSON 时最多重试的次数（每次都会把解析错误告诉模型）
JSON_RETRIES = 1
MAX_MESSAGES = 50
MAX_MESSAGE_CHARS = 60000
# 不支持 response_format 的模型服务（地址 + 模型名）：记住后直接不带该参数，省去一次失败请求
_NO_RESPONSE_FORMAT: set[tuple[str, str]] = set()


@dataclass
class LlmResult:
    text: str
    model: dict
    usage: dict = field(default_factory=dict)
    latency_ms: int = 0

    def view(self) -> dict:
        return {"text": self.text, "model": self.model, "usage": self.usage, "latencyMs": self.latency_ms}


def _check_messages(messages: list[dict]) -> list[dict]:
    if not messages:
        raise HTTPException(422, "请提供提示词")
    if len(messages) > MAX_MESSAGES:
        raise HTTPException(422, f"消息不能超过 {MAX_MESSAGES} 条")
    clean = []
    for message in messages:
        role, content = message.get("role"), message.get("content")
        if role not in {"system", "user", "assistant"} or not isinstance(content, str):
            raise HTTPException(422, "消息格式不正确：role 只能是 system / user / assistant，content 为文本")
        if len(content) > MAX_MESSAGE_CHARS:
            raise HTTPException(422, f"单条消息不能超过 {MAX_MESSAGE_CHARS} 个字符")
        clean.append({"role": role, "content": content})
    if not any(item["role"] == "user" and item["content"].strip() for item in clean):
        raise HTTPException(422, "请提供提示词")
    return clean


async def _connection(db: AsyncSession, model_id: int | None) -> dict:
    config = await get_connection(db, secret=True, connection_id=model_id)
    if not config["configured"]:
        raise HTTPException(409, "尚未配置可用模型，请先在模型中心添加并启用模型")
    if not config["enabled"]:
        raise HTTPException(409, f"模型「{config['name']}」已停用，请换一个模型")
    return config


async def complete(
    db: AsyncSession,
    *,
    messages: list[dict],
    model_id: int | None = None,
    temperature: float = 0.3,
    max_tokens: int = 2048,
    json_mode: bool = False,
    purpose: str = "generic",
    timeout: float = 120,
) -> LlmResult:
    """调用一次模型并返回文本；未指定模型时使用平台默认模型。"""
    messages = _check_messages(messages)
    config = await _connection(db, model_id)
    headers = {
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/airlsen/agent-harness-forge",
        "X-Title": "AgentHarness Forge",
    }
    if config.get("apiKey"):
        headers["Authorization"] = "Bearer " + config["apiKey"]
    body: dict[str, Any] = {
        "model": config["model"],
        "messages": messages,
        "temperature": max(0.0, min(float(temperature), 2.0)),
        "max_tokens": max(1, min(int(max_tokens), 16000)),
        "stream": False,
    }
    service = (config["baseUrl"], config["model"])
    with_format = json_mode and service not in _NO_RESPONSE_FORMAT
    if with_format:
        body["response_format"] = {"type": "json_object"}
    model = {"id": config["id"], "name": config["name"], "model": config["model"]}
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False, follow_redirects=False) as client:
            url = config["baseUrl"] + "/chat/completions"
            response = await client.post(url, headers=headers, json=body)
            # 部分兼容服务不支持 response_format：去掉后再试一次，JSON 由提示词约束、解析时兜底
            if with_format and response.status_code in {400, 404, 422}:
                _NO_RESPONSE_FORMAT.add(service)
                body = {key: value for key, value in body.items() if key != "response_format"}
                response = await client.post(url, headers=headers, json=body)
    except httpx.HTTPError as error:
        raise HTTPException(502, f"模型调用失败（{type(error).__name__}），请检查模型服务是否可用") from error
    latency = round((time.monotonic() - started) * 1000)
    if not response.is_success:
        raise HTTPException(502, f"模型服务返回 HTTP {response.status_code}，请检查模型配置或稍后重试")
    try:
        value = response.json()
        text = value["choices"][0]["message"].get("content") or ""
    except (ValueError, KeyError, IndexError, TypeError, AttributeError) as error:
        raise HTTPException(502, "模型返回的不是 Chat Completions 格式") from error
    if not text.strip():
        raise HTTPException(502, "模型没有返回内容，请稍后重试")
    raw_usage = value.get("usage") or {}
    usage = {
        "promptTokens": int(raw_usage.get("prompt_tokens") or 0),
        "completionTokens": int(raw_usage.get("completion_tokens") or 0),
    }
    log.info(
        "LLM 调用 purpose=%s model=%s tokens=%s/%s latency=%sms",
        purpose,
        config["model"],
        usage["promptTokens"],
        usage["completionTokens"],
        latency,
    )
    return LlmResult(text=text, model=model, usage=usage, latency_ms=latency)


_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.S)


def parse_json(text: str) -> dict:
    """解析模型输出的 JSON 对象：兼容 Markdown 代码块和前后多余的说明文字。"""
    text = text.strip()
    fenced = _FENCE.match(text)
    if fenced:
        text = fenced.group(1)
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("输出中没有 JSON 对象") from None
        value = json.loads(text[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("输出不是 JSON 对象")
    return value


def _merge_usage(total: dict, usage: dict) -> dict:
    return {key: total.get(key, 0) + usage.get(key, 0) for key in ("promptTokens", "completionTokens")}


async def complete_json(
    db: AsyncSession,
    *,
    messages: list[dict],
    validate: Callable[[dict], T] | None = None,
    **options: Any,
) -> tuple[T | dict, LlmResult]:
    """要求模型输出 JSON 对象并解析；解析或校验失败时把错误告诉模型重试一次。"""
    history = list(messages)
    usage: dict = {}
    for attempt in range(JSON_RETRIES + 1):
        result = await complete(db, messages=history, json_mode=True, **options)
        usage = _merge_usage(usage, result.usage)
        try:
            data = parse_json(result.text)
            value = validate(data) if validate else data
            result.usage = usage
            return value, result
        except (ValueError, TypeError, KeyError) as error:
            if attempt >= JSON_RETRIES:
                raise HTTPException(502, "模型没有按要求输出结构化结果，请重试或换一个模型") from error
            history = [
                *history,
                {"role": "assistant", "content": result.text[:4000]},
                {
                    "role": "user",
                    "content": f"上面的输出无法使用（{error}）。请只输出一个符合要求的 JSON 对象，不要有其他文字。",
                },
            ]
    raise AssertionError("unreachable")


async def run_task(
    db: AsyncSession,
    task_name: str,
    variables: dict[str, Any],
    *,
    model_id: int | None = None,
    validate: Callable[[dict], T] | None = None,
) -> tuple[Any, LlmResult]:
    """按登记的提示词任务调用模型：JSON 任务返回解析后的对象，文本任务返回字符串。"""
    from .llm_prompts import get_task

    task = get_task(task_name)
    options = {
        "model_id": model_id,
        "temperature": task.temperature,
        "max_tokens": task.max_tokens,
        "purpose": task.name,
    }
    messages = task.render(variables)
    if task.json:
        return await complete_json(db, messages=messages, validate=validate, **options)
    result = await complete(db, messages=messages, **options)
    return result.text, result
