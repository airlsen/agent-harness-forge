import json
import socket

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.models.registry import McpServer
from src.api.services import mcp_service
from src.api.services.mcp_service import (
    _probe_sse,
    _probe_stdio,
    editable_view,
    parse_import_config,
    update_server,
)


def public_dns(_host, _port):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]


def test_import_common_remote_mcp_servers_shape(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", public_dns)
    result = parse_import_config(
        {
            "mcpServers": {
                "crm": {
                    "type": "http",
                    "url": "https://mcp.example.test/mcp",
                    "headers": {"Authorization": "Bearer example-secret"},
                }
            }
        }
    )
    assert result == [
        {
            "name": "crm",
            "url": "https://mcp.example.test/mcp",
            "transport": "streamable-http",
            "headers": {"Authorization": "Bearer example-secret"},
        }
    ]


def test_import_sse_protocol(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", public_dns)
    config = parse_import_config(
        {"mcpServers": {"legacy": {"type": "sse", "url": "https://mcp.example.test/sse"}}}
    )
    assert config[0]["transport"] == "sse"


@pytest.mark.asyncio
async def test_sse_transport_performs_initialize_and_tool_discovery():
    messages = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "result": {"protocolVersion": "2024-11-05", "serverInfo": {"name": "legacy"}},
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {
            "jsonrpc": "2.0",
            "id": 2,
            "result": {"tools": [{"name": "lookup", "description": "Lookup records"}]},
        },
    ]
    body = "event: endpoint\ndata: https://mcp.example.test/messages\n\n" + "".join(
        f"event: message\ndata: {json.dumps(item)}\n\n" for item in messages
    )

    def handler(_request):
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=body)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        info, tools = await _probe_sse(client, "https://mcp.example.test/sse", {})
    assert info["transport"] == "sse"
    assert tools[0]["name"] == "lookup"


def test_import_stdio_protocol():
    config = parse_import_config(
        {"mcpServers": {"local": {"command": "npx", "args": ["-y", "server"], "env": {"TOKEN": "secret"}}}}
    )
    assert config[0]["transport"] == "stdio"
    assert config[0]["command"] == "npx"
    assert config[0]["args"] == ["-y", "server"]


@pytest.mark.asyncio
async def test_stdio_transport_launches_json_rpc_process():
    import sys

    script = """
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    if 'id' in message:
        result = {'serverInfo': {'name': 'test'}} if message['method'] == 'initialize' else {'tools': [{'name': 'hello'}]}
        print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}), flush=True)
"""
    info, tools = await _probe_stdio(sys.executable, ["-c", script], {})
    assert info["transport"] == "stdio"
    assert tools[0]["name"] == "hello"


@pytest.mark.parametrize(
    "entry, message",
    [
        ({"type": "http", "url": "http://mcp.example.test/mcp"}, "HTTPS"),
        ({"type": "http", "url": "https://mcp.example.test/mcp?token=secret"}, "查询参数"),
        ({"type": "http", "url": "https://127.0.0.1/mcp"}, "公网地址"),
        (
            {"type": "http", "url": "https://mcp.example.test/mcp", "headers": {"Host": "x"}},
            "保留",
        ),
    ],
)
def test_reject_unsupported_or_unsafe_config(entry, message, monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", public_dns)
    with pytest.raises(HTTPException) as error:
        parse_import_config({"mcpServers": {"test": entry}})
    assert message in error.value.detail


@pytest.mark.asyncio
async def test_edit_preserves_secrets_by_id_and_resets_only_when_connection_changes(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", public_dns)
    monkeypatch.setattr(mcp_service, "encrypt", lambda value: "encrypted:" + value)
    monkeypatch.setattr(mcp_service, "decrypt", lambda value: value.removeprefix("encrypted:"))
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        row = McpServer(
            name="before",
            url="https://mcp.example.test/mcp",
            transport="streamable-http",
            headers_encrypted='encrypted:{"Authorization": "Bearer secret"}',
            enabled=True,
            status="connected",
            tools_json=[{"name": "lookup"}],
        )
        db.add(row)
        await db.commit()
        view = editable_view(row)
        assert "secret" not in json.dumps(view)
        assert view["hasCredentials"] is True
        await update_server(db, row, {"mcpServers": {"after": {"type": "http", "url": row.url}}}, "keep")
        assert row.enabled is True and row.tools_json == [{"name": "lookup"}]
        assert row.headers_encrypted == 'encrypted:{"Authorization": "Bearer secret"}'
        await update_server(
            db,
            row,
            {"mcpServers": {"after": {"type": "http", "url": "https://mcp.example.test/new"}}},
            "keep",
        )
        assert row.enabled is False and row.status == "unverified" and row.tools_json == []
        assert json.loads(mcp_service.decrypt(row.headers_encrypted))["Authorization"] == "Bearer secret"
        await update_server(db, row, {"mcpServers": {"after": {"type": "http", "url": row.url}}}, "clear")
        assert row.headers_encrypted == ""
    await engine.dispose()


@pytest.mark.asyncio
async def test_edit_stdio_keeps_env_and_rejects_duplicate_names(monkeypatch):
    monkeypatch.setattr(mcp_service, "encrypt", lambda value: "encrypted:" + value)
    monkeypatch.setattr(mcp_service, "decrypt", lambda value: value.removeprefix("encrypted:"))
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        row = McpServer(
            name="local",
            url="stdio://local-process",
            transport="stdio",
            enabled=True,
            status="connected",
            tools_json=[{"name": "lookup"}],
            headers_encrypted='encrypted:{"headers": {}, "command": "npx", "args": ["-y", "server"], "env": {"TOKEN": "secret"}}',
        )
        db.add_all([row, McpServer(name="taken", url="stdio://local-process", transport="stdio")])
        await db.commit()
        config = editable_view(row)["config"]
        assert config["mcpServers"]["local"]["args"] == ["-y", "server"]
        assert "secret" not in json.dumps(config)
        with pytest.raises(HTTPException) as error:
            await update_server(db, row, {"mcpServers": {"taken": config["mcpServers"]["local"]}}, "keep")
        assert error.value.status_code == 409
        config["mcpServers"]["local"]["args"].append("--new")
        await update_server(db, row, config, "keep")
        assert row.status == "unverified" and row.enabled is False
        assert json.loads(mcp_service.decrypt(row.headers_encrypted))["env"] == {"TOKEN": "secret"}
    await engine.dispose()
