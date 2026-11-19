import hashlib
import ipaddress
import json
import uuid
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.security import decrypt, encrypt
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
        "description": "直接写入当前会话的受限工作区，无需逐次确认；受文件数量与容量配额约束。",
        "permission": "write",
        "icon": "edit",
    },
    {
        "name": "bash",
        "title": "终端命令执行",
        "description": "受控执行终端与 Git 命令；只读命令自动放行，修改或编译命令须经用户审批。",
        "permission": "write",
        "icon": "terminal",
    },
]
TOOL_NAMES = {x["name"] for x in TOOLS}
DEFAULT_POLICY = {
    "allowedTools": [x["name"] for x in TOOLS],
    # 明确的企业策略面；* 表示当前企业允许已审核插件声明的工具，场景仍须逐项授权。
    "allowedPluginTools": ["*"],
    "maxOutputTokens": 4096,
    "requestTimeoutSeconds": 120,
    "approvalTimeoutSeconds": 120,
    # 会话文件保留天数（从会话最后一次活动起算），0 表示永久保留；对所有会话即时生效
    "fileRetentionDays": 30,
}


class ModelInput(BaseModel):
    name: str = Field(default="未命名模型", max_length=100)
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


class ModelAvailabilityInput(BaseModel):
    enabled: bool


class PolicyInput(BaseModel):
    allowedTools: list[str] = Field(default_factory=lambda: list(DEFAULT_POLICY["allowedTools"]))
    allowedPluginTools: list[str] = Field(default_factory=lambda: list(DEFAULT_POLICY["allowedPluginTools"]))
    maxOutputTokens: int = Field(default=4096, ge=256, le=16384)
    requestTimeoutSeconds: int = Field(default=120, ge=15, le=300)
    approvalTimeoutSeconds: int = Field(default=120, ge=15, le=600)
    fileRetentionDays: int = Field(default=30, ge=0, le=3650)

    @model_validator(mode="after")
    def known_tools(self):
        if set(self.allowedTools) - TOOL_NAMES:
            raise ValueError("当前部署仅支持已登记的会话工作区工具")
        return self


async def get_policy(db: AsyncSession) -> dict:
    row = await db.get(PlatformSetting, "policy")
    # 只保留当前仍有效的策略项：旧版本保存的 requireWriteApproval 等已下线字段不再下发
    stored = {key: value for key, value in (row.value if row else {}).items() if key in DEFAULT_POLICY}
    return {**DEFAULT_POLICY, **stored}


def _connection_view(row: ModelConnection) -> dict:
    return {
        "id": row.id,
        "configured": True,
        "name": row.name,
        "baseUrl": row.base_url,
        "model": row.model,
        "apiKeyConfigured": bool(row.credential),
        "contextWindow": row.context_window,
        "inputPrice": row.input_price,
        "outputPrice": row.output_price,
        "enabled": row.enabled,
        "isDefault": bool(row.is_default),
        "lastTest": row.last_test or {},
    }


def _unconfigured_connection() -> dict:
    return {
        "configured": False,
        "name": "",
        "baseUrl": "",
        "model": "",
        "apiKeyConfigured": False,
        "contextWindow": 64000,
        "inputPrice": None,
        "outputPrice": None,
        "enabled": False,
        "isDefault": False,
        "lastTest": {},
    }


async def _connection_row(
    db: AsyncSession, connection_id: int | None = None, *, available_only: bool = False
) -> ModelConnection | None:
    if connection_id is not None:
        return await db.get(ModelConnection, connection_id)
    # 未显式指定时取平台默认模型；尚未设置默认（或旧数据）时回退到最早创建的启用配置。
    statement = (
        select(ModelConnection).order_by(ModelConnection.is_default.desc(), ModelConnection.id).limit(1)
    )
    if available_only:
        statement = statement.where(ModelConnection.enabled.is_(True))
    return await db.scalar(statement)


async def get_connection(db: AsyncSession, *, secret=False, connection_id: int | None = None) -> dict:
    row = await _connection_row(db, connection_id, available_only=connection_id is None)
    if not row:
        return _unconfigured_connection()
    data = _connection_view(row)
    revision = await db.get(PlatformSetting, "model-revision")
    data["revision"] = revision.value.get("id", "") if revision else ""
    if secret:
        data["apiKey"] = decrypt(row.credential)
    return data


async def list_connections(db: AsyncSession) -> list[dict]:
    rows = (await db.scalars(select(ModelConnection).order_by(ModelConnection.id))).all()
    return [_connection_view(row) for row in rows]


def _test_status(row: ModelConnection) -> str:
    last = row.last_test or {}
    if last.get("ok"):
        return "ok"
    return "failed" if last.get("at") else "untested"


async def list_model_options(db: AsyncSession) -> dict:
    """聊天模型选择的数据源：只含启用的配置，且不返回服务地址与任何凭据信息。

    连接测试不是启用的前置条件，因此测试状态只作为提示（status），不参与过滤。
    defaultId 是新会话未显式选择时实际会使用的模型（显式默认优先，否则为最早的启用配置）。
    """
    rows = (
        await db.scalars(
            select(ModelConnection).where(ModelConnection.enabled.is_(True)).order_by(ModelConnection.id)
        )
    ).all()
    default = next((row for row in rows if row.is_default), rows[0] if rows else None)
    items = [
        {
            "id": row.id,
            "name": row.name,
            "model": row.model,
            "contextWindow": row.context_window,
            "inputPrice": row.input_price,
            "outputPrice": row.output_price,
            "isDefault": bool(row.is_default),
            "status": _test_status(row),
        }
        for row in rows
    ]
    return {"items": items, "defaultId": default.id if default else None}


async def set_default_connection(db: AsyncSession, connection_id: int) -> dict:
    row = await db.get(ModelConnection, connection_id)
    if not row:
        raise HTTPException(404, "模型配置不存在")
    if not row.enabled:
        raise HTTPException(409, "已停用的模型不能设为默认，请先启用")
    await db.execute(
        update(ModelConnection).where(ModelConnection.id != connection_id).values(is_default=False)
    )
    row.is_default = True
    await _touch_model_revision(db)
    await db.commit()
    await db.refresh(row)
    return _connection_view(row)


async def resolve_session_connection(db: AsyncSession, connection_id: int | None = None) -> dict:
    """新会话使用的模型（含解密后的密钥，仅供服务端快照）。

    显式选择时必须存在且已启用；未选择时使用平台默认模型。
    """
    if connection_id is None:
        config = await get_connection(db, secret=True)
        if not config["configured"]:
            raise HTTPException(409, "没有已启用的模型配置，请先到模型管理启用至少一个模型")
        return config
    row = await db.get(ModelConnection, connection_id)
    if not row:
        raise HTTPException(404, "所选模型不存在或已被删除，请重新选择")
    if not row.enabled:
        raise HTTPException(409, "所选模型已停用，请重新选择")
    return await get_connection(db, secret=True, connection_id=connection_id)


async def _touch_model_revision(db: AsyncSession) -> None:
    revision = await db.get(PlatformSetting, "model-revision")
    if revision:
        revision.value = {"id": str(uuid.uuid4())}
    else:
        db.add(PlatformSetting(key="model-revision", value={"id": str(uuid.uuid4())}))


def _apply_connection_payload(row: ModelConnection, payload: ModelInput) -> None:
    row.name = payload.name.strip() or "未命名模型"
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


async def create_connection(db: AsyncSession, payload: ModelInput) -> dict:
    row = ModelConnection(base_url=payload.baseUrl, model=payload.model)
    _apply_connection_payload(row, payload)
    db.add(row)
    await _touch_model_revision(db)
    await db.commit()
    await db.refresh(row)
    return _connection_view(row)


async def save_connection(db: AsyncSession, payload: ModelInput, *, connection_id: int | None = None) -> dict:
    row = await _connection_row(db, connection_id)
    if not row:
        if connection_id is not None:
            raise HTTPException(404, "模型配置不存在")
        # Preserve the first-run single-connection endpoint for callers that still use it.
        row = ModelConnection(base_url=payload.baseUrl, model=payload.model)
        db.add(row)
    _apply_connection_payload(row, payload)
    await _touch_model_revision(db)
    await db.commit()
    await db.refresh(row)
    return _connection_view(row)


async def set_connection_availability(db: AsyncSession, connection_id: int, *, enabled: bool) -> dict:
    row = await db.get(ModelConnection, connection_id)
    if not row:
        raise HTTPException(404, "模型配置不存在")
    row.enabled = enabled
    if not enabled:
        # 停用的模型不能继续作为默认；新会话回退到最早的启用配置。
        row.is_default = False
    await _touch_model_revision(db)
    await db.commit()
    await db.refresh(row)
    return _connection_view(row)


async def delete_connection(db: AsyncSession, connection_id: int) -> None:
    row = await db.get(ModelConnection, connection_id)
    if not row:
        raise HTTPException(404, "模型配置不存在")
    await db.delete(row)
    await _touch_model_revision(db)
    await db.commit()


async def test_connection(db: AsyncSession, *, connection_id: int | None = None) -> dict:
    import time

    config = await get_connection(db, secret=True, connection_id=connection_id)
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
    result = {"ok": False, "at": datetime.now(UTC).isoformat()}
    try:
        async with httpx.AsyncClient(timeout=30, trust_env=False, follow_redirects=False) as client:
            response = await client.post(
                config["baseUrl"] + "/chat/completions",
                headers=headers,
                json={
                    "model": config["model"],
                    "messages": [{"role": "user", "content": "Reply with OK."}],
                    "max_tokens": 8,
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
    row = await db.get(ModelConnection, config["id"])
    if row:
        row.last_test = result
        await db.commit()
    return result


async def environment_ref(db: AsyncSession) -> str:
    revision = await db.get(PlatformSetting, "model-revision")
    value = {"modelRevision": revision.value if revision else {}, "policy": await get_policy(db)}
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
