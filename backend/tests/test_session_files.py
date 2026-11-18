"""会话产物原始字节接口：路径转义、安全响应头与 Runner 错误映射。"""

from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from src.api.routes import agent_session as routes
from src.api.services.runner_client import RunnerClient


@pytest.mark.asyncio
async def test_raw_file_is_served_as_sandboxed_attachment(monkeypatch):
    calls = []

    async def row(_db, session_id):
        return SimpleNamespace(id=session_id, runner_session_id="runner-1")

    async def raw(path):
        calls.append(path)
        return b"\x89PNG", "image/png"

    monkeypatch.setattr(routes.session_service, "row", row)
    monkeypatch.setattr(routes.runner_client, "raw", raw)
    response = await routes.file_raw(7, path="图表/月度 1.png", db=None)

    assert calls == ["/v1/sessions/runner-1/raw?path=%E5%9B%BE%E8%A1%A8%2F%E6%9C%88%E5%BA%A6%201.png"]
    assert response.body == b"\x89PNG"
    assert response.media_type == "image/png"
    assert response.headers["content-disposition"] == (
        "attachment; filename*=UTF-8''%E6%9C%88%E5%BA%A6%201.png"
    )
    # 模型生成的 HTML/SVG 即使被直接打开也不能在本站源下执行脚本
    assert response.headers["content-security-policy"] == "sandbox; default-src 'none'"
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.asyncio
async def test_raw_file_requires_runner_session(monkeypatch):
    async def row(_db, session_id):
        return SimpleNamespace(id=session_id, runner_session_id="")

    monkeypatch.setattr(routes.session_service, "row", row)
    with pytest.raises(HTTPException) as error:
        await routes.file_raw(7, path="a.txt", db=None)
    assert error.value.status_code == 404


def mock_client(monkeypatch, client, handler):
    monkeypatch.setattr(
        client,
        "client",
        lambda **_: httpx.AsyncClient(base_url="http://runner", transport=httpx.MockTransport(handler)),
    )


@pytest.mark.asyncio
async def test_runner_raw_returns_bytes_and_content_type(monkeypatch):
    client = RunnerClient()
    mock_client(
        monkeypatch,
        client,
        lambda _request: httpx.Response(
            200, content=b"%PDF-1.7", headers={"content-type": "application/pdf"}
        ),
    )
    assert await client.raw("/v1/sessions/x/raw?path=a.pdf") == (b"%PDF-1.7", "application/pdf")


@pytest.mark.asyncio
async def test_runner_raw_maps_errors(monkeypatch):
    client = RunnerClient()
    mock_client(
        monkeypatch, client, lambda _request: httpx.Response(404, json={"message": "文件不存在或已被删除"})
    )
    with pytest.raises(HTTPException) as error:
        await client.raw("/v1/sessions/x/raw?path=gone.md")
    assert (error.value.status_code, error.value.detail) == (404, "文件不存在或已被删除")

    mock_client(monkeypatch, client, lambda _request: httpx.Response(500, text="boom"))
    with pytest.raises(HTTPException) as error:
        await client.raw("/v1/sessions/x/raw?path=a.md")
    assert error.value.status_code == 502

    def offline(_request):
        raise httpx.ConnectError("down")

    mock_client(monkeypatch, client, offline)
    with pytest.raises(HTTPException) as error:
        await client.raw("/v1/sessions/x/raw?path=a.md")
    assert error.value.status_code == 503
