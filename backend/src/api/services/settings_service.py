from datetime import datetime, timezone
import hashlib
import json
import ipaddress
import uuid
from urllib.parse import urlsplit
import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession
from ..core.security import encrypt, decrypt
from ..models.platform import ModelConnection, PlatformSetting

TOOLS = [
    {
        "name": "current_time",
        "title": "当前时间",
        "description": "读取当前日期与时区，不访问外部网络。",
        "permission": "read",
        "icon": "clock",
    },
    {
        "name": "workspace_list",
        "title": "列出工作区文件",
        "description": "仅列出当前会话工作区内的文件。",
        "permission": "read",
        "icon": "folder",
    },
    {
        "name": "workspace_read",
        "title": "读取工作区文件",
        "description": "读取当前会话生成的文本文件，禁止越界路径与符号链接。",
        "permission": "read",
        "icon": "file",
    },
    {
        "name": "workspace_write",
        "title": "生成文本产物",
        "description": "写入当前会话工作区，默认需要用户逐次批准。",
        "permission": "approval",
        "icon": "edit",
    },
]
TOOL_NAMES = {x["name"] for x in TOOLS}
DEFAULT_POLICY = {
    "requireWriteApproval": True,
    "allowedTools": [x["name"] for x in TOOLS],
    # 明确的企业策略面；* 表示当前企业允许已审核插件声明的工具，场景仍须逐项授权。
    "allowedPluginTools": ["*"],
    "maxOutputTokens": 4096,
    "requestTimeoutSeconds": 120,
    "approvalTimeoutSeconds": 120,
}


class ModelInput(BaseModel):
    name: str = Field(default="默认模型连接", max_length=100)
    baseUrl: str = Field(min_length=8, max_length=512)
    model: str = Field(min_length=1, max_length=128)
    apiKey: str | None = Field(default=None, max_length=2048)
    clearKey: bool = False
    contextWindow: int = Field(default=64000, ge=4096, le=2000000)
    inputPrice: float | None = Field(default=None, ge=0, le=100000)
    outputPrice: float | None = Field(default=None, ge=0, le=100000)

    @model_validator(mode="after")
    def valid_url(self):
        parsed = urlsplit(self.baseUrl)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("请输入不含凭据、查询参数的 HTTP(S) Base URL")
        # 不允许云元数据地址；私网/本机网关由工作空间管理员明确配置。
        host = parsed.hostname.lower().rstrip(".")
        try:
            address = ipaddress.ip_address(host)
            blocked_address = address.is_link_local or (
                getattr(address, "ipv4_mapped", None) and address.ipv4_mapped.is_link_local
            )
        except ValueError:
            blocked_address = False
        if blocked_address or host in ("metadata.google.internal", "100.100.100.200"):
            raise ValueError("禁止访问云元数据服务")
        self.baseUrl = self.baseUrl.rstrip("/")
        self.model = self.model.strip()
        if not self.model:
            raise ValueError("模型 ID 不能为空")
        return self


class PolicyInput(BaseModel):
    requireWriteApproval: bool = True
    allowedTools: list[str] = Field(default_factory=lambda: list(DEFAULT_POLICY["allowedTools"]))
    allowedPluginTools: list[str] = Field(default_factory=lambda: list(DEFAULT_POLICY["allowedPluginTools"]))
    maxOutputTokens: int = Field(default=4096, ge=256, le=16384)
    requestTimeoutSeconds: int = Field(default=120, ge=15, le=300)
    approvalTimeoutSeconds: int = Field(default=120, ge=15, le=600)

    @model_validator(mode="after")
    def known_tools(self):
        if set(self.allowedTools) - TOOL_NAMES:
            raise ValueError("当前部署仅支持已登记的会话工作区工具")
        return self


async def get_policy(db: AsyncSession) -> dict:
    row = await db.get(PlatformSetting, "policy")
    return {**DEFAULT_POLICY, **(row.value if row else {})}


async def get_connection(db: AsyncSession, *, secret=False) -> dict:
    row = await db.get(ModelConnection, 1)
    if not row:
        return {
            "configured": False,
            "name": "",
            "baseUrl": "",
            "model": "",
            "apiKeyConfigured": False,
            "contextWindow": 64000,
            "inputPrice": None,
            "outputPrice": None,
            "lastTest": {},
        }
    data = {
        "configured": True,
        "name": row.name,
        "baseUrl": row.base_url,
        "model": row.model,
        "apiKeyConfigured": bool(row.credential),
        "contextWindow": row.context_window,
        "inputPrice": row.input_price,
        "outputPrice": row.output_price,
        "lastTest": row.last_test or {},
    }
    revision = await db.get(PlatformSetting, "model-revision")
    data["revision"] = revision.value.get("id", "") if revision else ""
    if secret:
        data["apiKey"] = decrypt(row.credential)
    return data


async def save_connection(db: AsyncSession, payload: ModelInput) -> dict:
    row = await db.get(ModelConnection, 1)
    if not row:
        row = ModelConnection(id=1, base_url=payload.baseUrl, model=payload.model)
        db.add(row)
    row.name = payload.name.strip() or "默认模型连接"
    row.base_url, row.model = payload.baseUrl, payload.model
    row.context_window, row.input_price, row.output_price = (
        payload.contextWindow,
        payload.inputPrice,
        payload.outputPrice,
    )
    if payload.clearKey:
        row.credential = ""
    elif payload.apiKey:
        row.credential = encrypt(payload.apiKey.strip())
    row.last_test = {}
    revision = await db.get(PlatformSetting, "model-revision")
    if revision:
        revision.value = {"id": str(uuid.uuid4())}
    else:
        db.add(PlatformSetting(key="model-revision", value={"id": str(uuid.uuid4())}))
    await db.commit()
    return await get_connection(db)


async def test_connection(db: AsyncSession) -> dict:
    import time

    config = await get_connection(db, secret=True)
    if not config["configured"]:
        raise HTTPException(409, "请先保存模型连接")
    started = time.monotonic()
    headers = {
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/airlsen/agent-harness-forge",
        "X-Title": "AgentHarness Forge",
    }
    if config.get("apiKey"):
        headers["Authorization"] = "Bearer " + config["apiKey"]
    result = {"ok": False, "at": datetime.now(timezone.utc).isoformat()}
    try:
        async with httpx.AsyncClient(timeout=30, trust_env=False, follow_redirects=False) as client:
            response = await client.post(
                config["baseUrl"] + "/chat/completions",
                headers=headers,
                json={
                    "model": config["model"],
                    "messages": [{"role": "user", "content": "Reply with OK."}],
                    "max_tokens": 32,
                    "stream": False,
                },
            )
            result["httpStatus"] = response.status_code
            if response.is_success:
                value = response.json()
                result["ok"] = bool(value.get("choices"))
                result["message"] = (
                    "模型已返回有效响应" if result["ok"] else "服务可达，但响应不是 Chat Completions 格式"
                )
            else:
                result["message"] = f"模型服务返回 HTTP {response.status_code}，请检查地址、模型名与密钥"
    except (httpx.HTTPError, ValueError) as error:
        result["message"] = f"模型连接失败（{type(error).__name__}），请检查网关配置"
    result["latencyMs"] = round((time.monotonic() - started) * 1000)
    row = await db.get(ModelConnection, 1)
    row.last_test = result
    await db.commit()
    return result


async def environment_ref(db: AsyncSession) -> str:
    revision = await db.get(PlatformSetting, "model-revision")
    value = {"modelRevision": revision.value if revision else {}, "policy": await get_policy(db)}
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
