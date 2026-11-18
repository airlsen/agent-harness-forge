import socket

import pytest
from fastapi import HTTPException

from src.api.services.mcp_service import parse_import_config


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
            "headers": {"Authorization": "Bearer example-secret"},
        }
    ]


@pytest.mark.parametrize(
    "entry, message",
    [
        ({"command": "npx", "args": ["unreviewed-package"]}, "stdio"),
        ({"type": "sse", "url": "https://mcp.example.test/sse"}, "暂不支持"),
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
