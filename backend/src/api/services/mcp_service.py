"""Remote Streamable HTTP MCP registry and connection probe (no arbitrary process launch)."""

import ipaddress
import json
import os
import socket
import asyncio
from urllib.parse import urljoin, urlsplit

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
        kind = str(
            value.get("type", value.get("transport", "stdio" if "command" in value else "streamable-http"))
        ).lower()
        if kind in {"http", "streamable_http", "streamable-http"}:
            kind = "streamable-http"
        elif kind in {"sse", "http-sse"}:
            kind = "sse"
        elif kind == "stdio":
            command, args, env = value.get("command"), value.get("args", []), value.get("env", {})
            if not isinstance(command, str) or not command.strip() or len(command) > 256 or "\0" in command:
                raise HTTPException(422, f"{name} 的 stdio command 无效")
            if (
                not isinstance(args, list)
                or len(args) > 64
                or any(not isinstance(arg, str) or len(arg) > 4096 or "\0" in arg for arg in args)
            ):
                raise HTTPException(422, f"{name} 的 stdio args 格式无效")
            if (
                not isinstance(env, dict)
                or len(env) > 50
                or any(
                    not isinstance(key, str)
                    or not key
                    or len(key) > 128
                    or not isinstance(val, str)
                    or len(val) > 8192
                    or "\0" in key + val
                    for key, val in env.items()
                )
            ):
                raise HTTPException(422, f"{name} 的 stdio env 格式无效")
            parsed.append(
                {
                    "name": name.strip(),
                    "transport": "stdio",
                    "command": command.strip(),
                    "args": args,
                    "env": env,
                    "headers": {},
                }
            )
            continue
        else:
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
        parsed.append({"name": name.strip(), "url": url, "transport": kind, "headers": clean_headers})
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


async def _probe_sse(client: httpx.AsyncClient, url: str, headers: dict[str, str]) -> tuple[dict, list[dict]]:
    response = await client.send(
        client.build_request("GET", url, headers={**headers, "Accept": "text/event-stream"}), stream=True
    )
    if response.status_code != 200 or "text/event-stream" not in response.headers.get("content-type", ""):
        await response.aclose()
        raise HTTPException(502, "SSE MCP 服务未返回 text/event-stream")
    iterator = response.aiter_lines()
    event_name, data_lines, message_queue = "message", [], asyncio.Queue()
    reader = None
    try:
        endpoint = None
        async for line in iterator:
            if not line:
                if event_name == "endpoint" and data_lines:
                    endpoint = urljoin(url, "\n".join(data_lines))
                    break
                event_name, data_lines = "message", []
            elif line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        if not endpoint:
            raise HTTPException(502, "SSE MCP 服务没有提供消息 endpoint")
        parsed_endpoint = urlsplit(endpoint)
        base = urlsplit(url)
        if parsed_endpoint.scheme != "https" or parsed_endpoint.hostname != base.hostname:
            raise HTTPException(502, "SSE MCP 消息 endpoint 必须使用同一 HTTPS 主机")

        async def receive_events():
            _current_event, current_data = "message", []
            async for line in iterator:
                if not line:
                    if current_data:
                        try:
                            await message_queue.put(json.loads("\n".join(current_data)))
                        except ValueError:
                            pass
                    _current_event, current_data = "message", []
                elif line.startswith("event:"):
                    _current_event = line[6:].strip()
                elif line.startswith("data:"):
                    current_data.append(line[5:].lstrip())

        reader = asyncio.create_task(receive_events())

        async def request(method: str, request_id: int | None = None):
            body = {"jsonrpc": "2.0", "method": method}
            if request_id is not None:
                body["id"] = request_id
            if method == "initialize":
                body["params"] = {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "AgentHarness Forge", "version": "0.2.0"},
                }
            elif method == "tools/list":
                body["params"] = {}
            sent = await client.post(
                endpoint, headers={**headers, "Content-Type": "application/json"}, json=body
            )
            if sent.status_code not in {200, 202, 204}:
                raise HTTPException(502, f"SSE MCP 消息请求返回 HTTP {sent.status_code}")
            if request_id is None:
                return None
            deadline = asyncio.get_running_loop().time() + 8
            while asyncio.get_running_loop().time() < deadline:
                try:
                    item = await asyncio.wait_for(
                        message_queue.get(), timeout=max(0.1, deadline - asyncio.get_running_loop().time())
                    )
                except asyncio.TimeoutError as exc:
                    raise HTTPException(502, "等待 SSE MCP 响应超时") from exc
                if isinstance(item, dict) and item.get("id") == request_id:
                    if item.get("error"):
                        raise HTTPException(502, "SSE MCP 服务请求失败")
                    return item
            raise HTTPException(502, "等待 SSE MCP 响应超时")

        initialized = await request("initialize", 1)
        protocol = initialized.get("result", {}).get("protocolVersion", "2024-11-05")
        await request("notifications/initialized")
        listed = await request("tools/list", 2)
        tools = listed.get("result", {}).get("tools", [])
        if not isinstance(tools, list) or len(tools) > 500:
            raise HTTPException(502, "MCP 服务返回的工具列表无效或过大")
        safe_tools = [
            {
                "name": tool["name"][:128],
                "description": str(tool.get("description", ""))[:2000],
                "inputSchema": tool.get("inputSchema", {"type": "object"}),
                "annotations": tool.get("annotations", {}),
            }
            for tool in tools
            if isinstance(tool, dict) and isinstance(tool.get("name"), str)
        ]
        reader.cancel()
        return {"transport": "sse", "protocolVersion": protocol}, safe_tools
    finally:
        if reader:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        await response.aclose()


async def probe(
    url: str, headers: dict[str, str], transport: str = "streamable-http"
) -> tuple[dict, list[dict]]:
    url = _public_https_url(url)
    base_headers = {"Accept": "application/json, text/event-stream", **headers}
    timeout = httpx.Timeout(8.0, connect=4.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        if transport == "sse":
            return await _probe_sse(client, url, base_headers)
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


async def _probe_stdio(command: str, args: list[str], env: dict[str, str]) -> tuple[dict, list[dict]]:
    """Launch an explicitly configured stdio MCP command without a shell; bound time and protocol output."""
    try:
        process = await asyncio.create_subprocess_exec(
            command,
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ, **env},
            limit=65536,
        )
    except (OSError, ValueError) as exc:
        raise HTTPException(502, "无法启动 MCP stdio 服务，请检查 command 和 args") from exc

    async def send(message: dict, expected_id: int | None = None):
        if not process.stdin or not process.stdout:
            raise HTTPException(502, "MCP stdio 管道未能建立")
        process.stdin.write(json.dumps(message, ensure_ascii=False).encode("utf-8") + b"\n")
        await asyncio.wait_for(process.stdin.drain(), timeout=5)
        if expected_id is None:
            return None
        deadline = asyncio.get_running_loop().time() + 10
        while asyncio.get_running_loop().time() < deadline:
            line = await asyncio.wait_for(
                process.stdout.readline(), timeout=max(0.1, deadline - asyncio.get_running_loop().time())
            )
            if not line:
                raise HTTPException(502, "MCP stdio 服务提前退出")
            if len(line) > 65536:
                raise HTTPException(502, "MCP stdio 响应超过 64 KB 限制")
            try:
                reply = json.loads(line)
            except (ValueError, UnicodeDecodeError) as exc:
                raise HTTPException(502, "MCP stdio 服务 stdout 包含无效 JSON-RPC 数据") from exc
            if isinstance(reply, dict) and reply.get("id") == expected_id:
                if reply.get("error"):
                    raise HTTPException(502, "MCP stdio 服务初始化或工具发现失败")
                return reply
        raise HTTPException(502, "等待 MCP stdio 响应超时")

    try:
        initialized = await send(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "AgentHarness Forge", "version": "0.2.0"},
                },
            },
            1,
        )
        await send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        listed = await send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, 2)
        tools = listed.get("result", {}).get("tools", [])
        if not isinstance(tools, list) or len(tools) > 500:
            raise HTTPException(502, "MCP 服务返回的工具列表无效或过大")
        safe_tools = [
            {
                "name": tool["name"][:128],
                "description": str(tool.get("description", ""))[:2000],
                "inputSchema": tool.get("inputSchema", {"type": "object"}),
                "annotations": tool.get("annotations", {}),
            }
            for tool in tools
            if isinstance(tool, dict) and isinstance(tool.get("name"), str)
        ]
        info = initialized.get("result", {}).get("serverInfo", {})
        return {**(info if isinstance(info, dict) else {}), "transport": "stdio"}, safe_tools
    except asyncio.TimeoutError as exc:
        raise HTTPException(502, "MCP stdio 服务响应超时") from exc
    finally:
        if process.stdin:
            process.stdin.close()
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=1)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()


async def import_servers(db: AsyncSession, raw: dict) -> list[dict]:
    entries = parse_import_config(raw)
    names = [entry["name"] for entry in entries]
    existing = (await db.scalars(select(McpServer).where(McpServer.name.in_(names)))).all()
    by_name = {row.name: row for row in existing}
    result = []
    for entry in entries:
        row = by_name.get(entry["name"])
        server_url = "stdio://local-process" if entry["transport"] == "stdio" else entry["url"]
        if row is None:
            row = McpServer(name=entry["name"], url=server_url, transport=entry["transport"])
            db.add(row)
        row.url = server_url
        row.transport = entry["transport"]
        private_config = (
            {"headers": {}, "command": entry["command"], "args": entry["args"], "env": entry["env"]}
            if entry["transport"] == "stdio"
            else entry["headers"]
        )
        row.headers_encrypted = (
            encrypt(json.dumps(private_config, ensure_ascii=False)) if private_config else ""
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
    has_credentials = bool(row.headers_encrypted)
    if row.transport == "stdio" and row.headers_encrypted:
        try:
            has_credentials = bool(json.loads(decrypt(row.headers_encrypted)).get("env"))
        except (ValueError, AttributeError):
            has_credentials = False
    return {
        "id": row.id,
        "name": row.name,
        "url": row.url,
        "transport": row.transport,
        "enabled": row.enabled,
        "status": row.status,
        "lastError": row.last_error,
        "tools": row.tools_json or [],
        "serverInfo": row.server_info or {},
        "hasCredentials": has_credentials,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
    }


async def test_server(db: AsyncSession, row: McpServer) -> dict:
    private_config = json.loads(decrypt(row.headers_encrypted)) if row.headers_encrypted else {}
    try:
        if row.transport == "stdio":
            info, tools = await _probe_stdio(
                private_config.get("command", ""),
                private_config.get("args", []),
                private_config.get("env", {}),
            )
        else:
            headers = private_config.get("headers", private_config)
            info, tools = await probe(row.url, headers, row.transport)
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
