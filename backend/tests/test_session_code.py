"""会话关联代码：选择随消息提交并保存在会话上，每轮完整下发给 Runner，非法选择不留下任何记录。"""

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select

from src.api.models.platform import SessionMessage
from src.api.routes import agent_session as routes
from src.api.routes import code as code_routes
from src.api.services import session_service as session_module
from src.api.services.runner_client import RunnerClient

# 复用会话切换测试的内存数据库、假 Runner 与加密替身（pytest 默认 prepend 导入模式下可直接引用）
from test_session_switch import env, fake_crypto, turn  # noqa: F401


@pytest.mark.asyncio
async def test_selection_is_sent_every_turn_and_changes_apply_from_the_next_turn(env):  # noqa: F811
    service = session_module.SessionService()
    runner = env["runner"]
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    assert session["codeProjects"] == []

    # 首轮随消息提交选择：Runner 会话创建时就带上，并在本轮完整下发
    first = await turn(service, session["id"], "分析登录流程", code_projects=["alpha"])
    assert first["codeProjects"] == ["alpha"]
    assert first["messageMeta"]["codeProjects"] == ["alpha"]
    assert runner.created_code == [["alpha"]]
    assert runner.code == [["alpha"]]

    # 不传沿用已保存的选择
    await turn(service, session["id"], "继续")
    assert runner.code[-1] == ["alpha"]

    # 修改（多选）随下一条消息提交，从这一轮起生效；Runner 会话不重建
    third = await turn(service, session["id"], "对比两个仓库", code_projects=["beta", "alpha"])
    assert third["codeProjects"] == ["beta", "alpha"]
    assert (await service.detail(session["id"]))["codeProjects"] == ["beta", "alpha"]
    assert runner.code[-1] == ["beta", "alpha"]
    assert third["messageMeta"]["codeProjects"] == ["beta", "alpha"]
    assert len(runner.created) == 1

    # 清空后下发空列表（而不是省略），Runner 据此撤销只读挂载
    await turn(service, session["id"], "不看代码了", code_projects=[])
    assert runner.code[-1] == []
    detail = await service.detail(session["id"])
    assert detail["codeProjects"] == []
    assert "codeProjects" not in detail["messages"][-2]["meta"]
    listed = await service.list()
    assert listed[0]["codeProjects"] == []


@pytest.mark.asyncio
async def test_invalid_selections_are_rejected_without_side_effects(env):  # noqa: F811
    service = session_module.SessionService()
    session = await service.create(env["scenario"]["id"], model_id=env["models"]["chat"]["id"])
    await turn(service, session["id"], "第一轮", code_projects=["alpha"])

    async def messages():
        async with env["sessions"]() as db:
            return await db.scalar(select(func.count()).select_from(SessionMessage))

    before = await messages()
    for names, pattern in [
        (["missing"], "代码项目不存在：missing"),
        (["../etc"], "代码项目不存在"),
        ([".git"], "代码项目不存在"),
        (["a/b"], "代码项目不存在"),
        ([""], "代码项目不存在"),
        (["alpha", "alpha"], "重复"),
        ([f"p{i}" for i in range(21)], "最多"),
    ]:
        with pytest.raises(HTTPException) as error:
            await service.start(session["id"], "换项目", code_projects=names)
        assert error.value.status_code == 422 and pattern in error.value.detail, names
    assert await messages() == before
    assert (await service.detail(session["id"]))["codeProjects"] == ["alpha"]
    assert len(env["runner"].turns) == 1

    # 已关联的项目不重复向 Runner 核对（删除后由 Runner 在执行前报告）；新加入的必须存在
    env["runner"].projects = ["beta"]
    receipt = await turn(service, session["id"], "加上 beta", code_projects=["alpha", "beta"])
    assert receipt["codeProjects"] == ["alpha", "beta"]

    await service.archive(session["id"])
    with pytest.raises(HTTPException) as archived:
        await service.start(session["id"], "归档后", code_projects=["beta"])
    assert archived.value.status_code == 409


def test_request_models_bound_the_selection():
    assert routes.Turn(message="hi").codeProjects is None
    assert routes.Turn(message="hi", codeProjects=[]).codeProjects == []
    with pytest.raises(ValidationError):
        routes.Turn(message="hi", codeProjects=[f"p{i}" for i in range(21)])
    # 不再提供单独保存选择的接口：选择只随消息提交
    assert not hasattr(routes, "CodeProjects")
    paths = {route.path for route in routes.router.routes}
    assert "/{session_id}/turns" in paths
    assert not paths & {"/{session_id}/code-projects", "/{session_id}/capabilities"}


@pytest.mark.asyncio
async def test_runner_client_sends_the_selection_and_lists_projects(monkeypatch):
    import httpx

    seen = []

    def handler(request: httpx.Request):
        seen.append((request.method, request.url.path, request.content))
        if request.url.path == "/v1/code/projects":
            return httpx.Response(200, json={"root": "/usr/data/git", "available": True, "projects": []})
        if request.url.path == "/v1/sessions":
            return httpx.Response(200, json={"sessionId": "s1"})
        return httpx.Response(200, text='data: {"kind":"done","payload":{"status":"idle"}}\n\n')

    client = RunnerClient()
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        client, "client", lambda **_: httpx.AsyncClient(base_url="http://runner", transport=transport)
    )
    assert (await client.code_projects())["root"] == "/usr/data/git"
    await client.create_session({}, {}, {"model": "m"}, ["alpha"])
    assert [event async for event in client.events("s1", "hi", None, [])][0]["kind"] == "done"
    [event async for event in client.events("s1", "hi")]
    import json

    assert json.loads(seen[1][2])["codeProjects"] == ["alpha"]
    assert json.loads(seen[2][2]) == {"message": "hi", "codeProjects": []}
    assert json.loads(seen[3][2]) == {"message": "hi"}

    # 控制面路由直接返回 Runner 的列表
    monkeypatch.setattr(code_routes, "runner_client", client)
    response = await code_routes.projects()
    assert response.data["available"] is True
