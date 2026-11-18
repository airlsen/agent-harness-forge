"""Remote Streamable HTTP MCP registry and connection probe (no arbitrary process launch)."""

import ipaddress
import json
import socket
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.security import decrypt, encrypt
from ..models.registry import McpServer


def _public_https_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(422, "第一版仅支持 HTTPS 远程 MCP 地址，且不能包含用户名或密码")
    if parsed.query or parsed.fragment:
        raise HTTPException(422, "MCP 地址不能包含查询参数或片段；请将认证信息放入独立密钥字段")
    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"}:
        raise HTTPException(422, "不允许连接本机地址")
    try:
        addresses = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            addresses = {
                ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(host, parsed.port or 443)
            }
        except OSError as exc:
            raise HTTPException(422, "无法解析 MCP 服务域名") from exc
    if not addresses or any(not addr.is_global for addr in addresses):
        raise HTTPException(422, "MCP 服务必须解析到公网地址，不能连接本机或内网地址")
    return value.rstrip("/")


def parse_import_config(raw: dict) -> list[dict]:
    """Accept the common mcpServers JSON shape and normalize supported remote entries."""
    servers = raw.get("mcpServers") if isinstance(raw, dict) else None
    if not isinstance(servers, dict) or not servers:
        raise HTTPException(422, "JSON 格式应包含非空的 mcpServers 对象")
    if len(servers) > 20:
        raise HTTPException(422, "一次最多导入 20 个 MCP 服务")
    if len({str(name).strip() for name in servers}) != len(servers):
        raise HTTPException(422, "MCP 服务名称不能重复")
    parsed = []
    for name, value in servers.items():
        if not isinstance(name, str) or not name.strip() or len(name) > 96 or not isinstance(value, dict):
            raise HTTPException(422, "MCP 服务名称或配置格式无效")
        if "command" in value:
            raise HTTPException(422, f"{name} 使用 stdio 子进程配置；第一版暂不运行本机命令")
        kind = str(value.get("type", value.get("transport", "http"))).lower()
        if kind not in {"http", "streamable-http", "streamable_http"}:
            raise HTTPException(422, f"{name} 的传输方式暂不支持：{kind}")
        url = _public_https_url(str(value.get("url", "")))
        headers = value.get("headers", {})
        if not isinstance(headers, dict) or len(headers) > 30:
            raise HTTPException(422, f"{name} 的 headers 格式无效")
        clean_headers = {}
        for key, val in headers.items():
            if not isinstance(key, str) or not isinstance(val, str) or len(key) > 128 or len(val) > 8192:
                raise HTTPException(422, f"{name} 的 headers 格式无效")
            if key.lower() in {"host", "content-length", "connection", "transfer-encoding", "mcp-session-id"}:
                raise HTTPException(422, f"{name} 包含平台保留的 HTTP 请求头")
            clean_headers[key] = val
        parsed.append({"name": name.strip(), "url": url, "headers": clean_headers})
    return parsed


def _rpc_result(response: httpx.Response) -> dict:
    if response.status_code not in {200, 202}:
        raise HTTPException(502, f"MCP 服务返回 HTTP {response.status_code}")
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        value = response.json()
        if isinstance(value, dict):
            return value
    if "text/event-stream" in content_type:
        for line in response.text.splitlines():
            if line.startswith("data:"):
                data = line[5:].strip()
                if data:
                    value = json.loads(data)
                    if isinstance(value, dict):
                        return value
    raise HTTPException(502, "MCP 服务没有返回可识别的 JSON-RPC 响应")


async def probe(url: str, headers: dict[str, str]) -> tuple[dict, list[dict]]:
    url = _public_https_url(url)
    base_headers = {"Accept": "application/json, text/event-stream", **headers}
    timeout = httpx.Timeout(8.0, connect=4.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        initialize = await client.post(
            url,
            headers={**base_headers, "Content-Type": "application/json"},
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "AgentHarness Forge", "version": "0.2.0"},
                },
            },
        )
        result = _rpc_result(initialize)
        if "error" in result or result.get("id") != 1:
            raise HTTPException(502, "MCP 初始化失败：服务响应不符合 JSON-RPC 约定")
        protocol = result.get("result", {}).get("protocolVersion", "")
        session_id = initialize.headers.get("mcp-session-id", "")
        notify_headers = {
            **base_headers,
            "Content-Type": "application/json",
            "MCP-Protocol-Version": protocol or "2025-03-26",
        }
        if session_id:
            notify_headers["Mcp-Session-Id"] = session_id
        await client.post(
            url,
            headers=notify_headers,
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        )
        tool_response = await client.post(
            url,
            headers=notify_headers,
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        tools_result = _rpc_result(tool_response)
        if "error" in tools_result or tools_result.get("id") != 2:
            raise HTTPException(502, "MCP 工具列表读取失败")
        tools = tools_result.get("result", {}).get("tools", [])
        if not isinstance(tools, list) or len(tools) > 500:
            raise HTTPException(502, "MCP 服务返回的工具列表无效或过大")
        safe_tools = []
        for tool in tools:
            if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
                continue
            safe_tools.append(
                {
                    "name": tool["name"][:128],
                    "description": str(tool.get("description", ""))[:2000],
                    "inputSchema": tool.get("inputSchema", {"type": "object"}),
                    "annotations": tool.get("annotations", {}),
                }
            )
        return result.get("result", {}).get("serverInfo", {}), safe_tools


async def import_servers(db: AsyncSession, raw: dict) -> list[dict]:
    entries = parse_import_config(raw)
    names = [entry["name"] for entry in entries]
    existing = (await db.scalars(select(McpServer).where(McpServer.name.in_(names)))).all()
    by_name = {row.name: row for row in existing}
    result = []
    for entry in entries:
        row = by_name.get(entry["name"])
        if row is None:
            row = McpServer(name=entry["name"], url=entry["url"])
            db.add(row)
        row.url = entry["url"]
        row.headers_encrypted = (
            encrypt(json.dumps(entry["headers"], ensure_ascii=False)) if entry["headers"] else ""
        )
        row.enabled = False
        row.status = "unverified"
        row.last_error = ""
        result.append(row)
    await db.commit()
    for row in result:
        await db.refresh(row)
    return result


def public_view(row: McpServer) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "url": row.url,
        "enabled": row.enabled,
        "status": row.status,
        "lastError": row.last_error,
        "tools": row.tools_json or [],
        "serverInfo": row.server_info or {},
        "hasCredentials": bool(row.headers_encrypted),
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
    }


async def test_server(db: AsyncSession, row: McpServer) -> dict:
    headers = json.loads(decrypt(row.headers_encrypted)) if row.headers_encrypted else {}
    try:
        info, tools = await probe(row.url, headers)
        row.status = "connected"
        row.server_info = info if isinstance(info, dict) else {}
        row.tools_json = tools
        row.last_error = ""
        await db.commit()
        return public_view(row)
    except (httpx.HTTPError, ValueError, HTTPException) as exc:
        detail = (
            exc.detail if isinstance(exc, HTTPException) else "无法连接 MCP 服务，请检查地址、认证和服务状态"
        )
        row.status = "error"
        row.last_error = str(detail)[:512]
        row.enabled = False
        await db.commit()
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(502, row.last_error) from exc
