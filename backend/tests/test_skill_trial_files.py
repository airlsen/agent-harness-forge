"""Skill 编辑对话的试用文件：同步到服务端、执行会话重建后保留、读取与删除、过期清理与对话事件。"""

import os
import time
from datetime import datetime, timedelta
from hashlib import sha256
from urllib.parse import unquote

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.models.skill import SkillAuthoringFile, SkillAuthoringSession
from src.api.services import skill_service
from src.api.services.file_service import FileService
from src.api.services.file_store import FileStore
from src.api.services.skill_service import create_skill


class FakeWorkspaceRunner:
    """按执行会话区分的 Runner 工作区：files[runner_id][path] = bytes。"""

    def __init__(self):
        self.files: dict[str, dict[str, bytes]] = {}
        self.offline = False
        self.deleted: list[tuple[str, str]] = []
        self.purged: list[str] = []

    async def ack(self, _runner_id, _seq):
        return None

    @staticmethod
    def _runner(path: str) -> str:
        return path.split("/v1/sessions/", 1)[1].split("/", 1)[0]

    async def call(self, method, path, _body=None):
        if self.offline:
            raise HTTPException(503, "Runner 不可用")
        runner = self._runner(path)
        workspace = self.files.setdefault(runner, {})
        if method == "GET" and path.endswith("/files"):
            return {
                "items": [
                    {
                        "path": name,
                        "bytes": len(data),
                        "mime": "text/plain",
                        "modifiedAt": "2026-11-22T08:00:00.000Z",
                        "sha256": sha256(data).hexdigest(),
                    }
                    for name, data in sorted(workspace.items())
                ],
                "truncated": False,
            }
        if method == "DELETE" and "/file?path=" in path:
            name = unquote(path.split("path=", 1)[1])
            if name not in workspace:
                raise HTTPException(404, "文件不存在或已被删除")
            del workspace[name]
            self.deleted.append((runner, name))
            return {"ok": True}
        if method == "DELETE" and path.endswith("/workspace"):
            workspace.clear()
            self.purged.append(runner)
            return {"ok": True}
        raise AssertionError(f"unexpected call {method} {path}")

    async def raw(self, path):
        runner = self._runner(path)
        name = unquote(path.split("path=", 1)[1])
        workspace = self.files.get(runner, {})
        if name not in workspace:
            raise HTTPException(404, "文件不存在或已被删除")
        return workspace[name], "text/plain"


@pytest_asyncio.fixture
async def env(tmp_path, monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    service = FileService(FileStore(tmp_path / "store"), sessions)
    runner = FakeWorkspaceRunner()
    monkeypatch.setattr(skill_service, "SKILL_ROOT", tmp_path / "skills")
    monkeypatch.setattr(skill_service.settings, "data_dir", tmp_path)
    monkeypatch.setattr(skill_service, "SessionFactory", sessions)
    monkeypatch.setattr(skill_service, "file_service", service)
    monkeypatch.setattr(skill_service, "runner_client", runner)
    async with sessions() as db:
        created = await create_skill(db, "接口自动化", "写接口测试时使用", None, "tester")
        row = SkillAuthoringSession(
            skill_id=created["id"],
            runner_session_id="r1",
            status="idle",
            current_revision_id=created["currentRevisionId"],
        )
        db.add(row)
        await db.commit()
        authoring_id = row.id
    try:
        yield {
            "sessions": sessions,
            "service": service,
            "runner": runner,
            "skill_id": created["id"],
            "authoring_id": authoring_id,
        }
    finally:
        await engine.dispose()


async def _rows(env) -> dict[str, SkillAuthoringFile]:
    async with env["sessions"]() as db:
        rows = (await db.scalars(select(SkillAuthoringFile))).all()
    return {row.path: row for row in rows}


@pytest.mark.asyncio
async def test_sync_keeps_files_from_previous_runner_session(env):
    service, runner, authoring_id = env["service"], env["runner"], env["authoring_id"]
    runner.files["r1"] = {"outputs/parse-1/result.json": b'{"ok": true}', "docs/report.md": b"# report"}
    assert await service.sync_authoring(authoring_id, "r1", runner)
    rows = await _rows(env)
    assert set(rows) == {"outputs/parse-1/result.json", "docs/report.md"}
    assert {row.runner_session_id for row in rows.values()} == {"r1"}

    # 同一执行会话中删除与修改：清单中消失的文件删除记录，修改的文件更新内容
    runner.files["r1"] = {"docs/report.md": b"# report v2"}
    assert await service.sync_authoring(authoring_id, "r1", runner)
    rows = await _rows(env)
    assert set(rows) == {"docs/report.md"}
    assert service.store.get(rows["docs/report.md"].sha256) == b"# report v2"

    # 执行会话重建（新的空工作区）：旧工作区的文件保留，不会被空清单删掉
    runner.files["r2"] = {"outputs/parse-2/result.json": b"{}"}
    assert await service.sync_authoring(authoring_id, "r2", runner)
    rows = await _rows(env)
    assert set(rows) == {"docs/report.md", "outputs/parse-2/result.json"}
    assert rows["docs/report.md"].runner_session_id == "r1"
    assert rows["outputs/parse-2/result.json"].runner_session_id == "r2"

    # 新执行会话写出同名文件：记录转到新会话，之后随新会话清单更新
    runner.files["r2"]["docs/report.md"] = b"# report v3"
    assert await service.sync_authoring(authoring_id, "r2", runner)
    assert (await _rows(env))["docs/report.md"].runner_session_id == "r2"

    # Runner 离线：不改动已有记录
    runner.offline = True
    assert not await service.sync_authoring(authoring_id, "r2", runner)
    assert len(await _rows(env)) == 2


@pytest.mark.asyncio
async def test_list_raw_and_delete(env):
    sessions, runner = env["sessions"], env["runner"]
    skill_id, authoring_id = env["skill_id"], env["authoring_id"]
    runner.files["r1"] = {"outputs/parse/sample.json": b'{"method": "GET"}', "outputs/bin.dat": b"\xff\xfe"}
    async with sessions() as db:
        listed = await skill_service.trial_files(db, skill_id, authoring_id, refresh=True)
    assert [item["path"] for item in listed["items"]] == ["outputs/bin.dat", "outputs/parse/sample.json"]

    async with sessions() as db:
        data, _ = await skill_service.trial_file_raw(db, skill_id, authoring_id, "outputs/parse/sample.json")
        assert data == b'{"method": "GET"}'
        with pytest.raises(HTTPException) as missing:
            await skill_service.trial_file_raw(db, skill_id, authoring_id, "outputs/none.json")
        assert missing.value.status_code == 404

    # 运行中不能删除；空闲时同时删除 Runner 工作区与服务端记录
    async with sessions() as db:
        await db.execute(update(SkillAuthoringSession).values(status="running"))
        await db.commit()
    async with sessions() as db:
        with pytest.raises(HTTPException) as running:
            await skill_service.delete_trial_file(db, skill_id, authoring_id, "outputs/bin.dat")
        assert running.value.status_code == 409
        await db.execute(update(SkillAuthoringSession).values(status="idle"))
        await db.commit()
    async with sessions() as db:
        await skill_service.delete_trial_file(db, skill_id, authoring_id, "outputs/bin.dat")
    assert runner.deleted == [("r1", "outputs/bin.dat")]
    assert set(await _rows(env)) == {"outputs/parse/sample.json"}


@pytest.mark.asyncio
async def test_gc_keeps_trial_contents_and_retention_purges_stale_conversations(env):
    service, runner, sessions = env["service"], env["runner"], env["sessions"]
    runner.files["r1"] = {"outputs/a.txt": b"trial"}
    assert await service.sync_authoring(env["authoring_id"], "r1", runner)
    digest = (await _rows(env))["outputs/a.txt"].sha256
    old = time.time() - 3600
    os.utime(service.store.path(digest), (old, old))
    assert await service.gc() == 0  # 试用文件引用的内容不能被回收
    assert service.store.exists(digest)

    # 对话超过保留期限（默认 30 天）后清理试用文件：Runner 工作区与服务端记录
    async with sessions() as db:
        await db.execute(update(SkillAuthoringSession).values(updated_at=datetime.now() - timedelta(days=40)))
        await db.commit()
    result = await service.cleanup_expired(runner)
    assert result["purgedSkillConversations"] == 1
    assert runner.purged == ["r1"]
    assert await _rows(env) == {}


@pytest.mark.asyncio
async def test_authoring_turn_pushes_trial_file_updates(env, monkeypatch):
    runner, skill_id, authoring_id = env["runner"], env["skill_id"], env["authoring_id"]

    async def fake_prepare(db, session):
        return {"model": "m"}

    async def fake_events(runner_id, message, model_config=None):
        yield {"kind": "tool_use_start", "payload": {"toolCallId": "c1", "tool": "bash", "arguments": {}}}
        runner.files["r1"] = {"outputs/pytest/report.txt": b"2 passed"}
        yield {
            "kind": "tool_result",
            "payload": {"toolCallId": "c1", "tool": "bash", "arguments": {}, "result": "2 passed"},
        }
        yield {"kind": "message", "payload": {"text": "跑通了", "runtimeMessageId": "m1"}}

    monkeypatch.setattr(skill_service, "_prepare_authoring_runner", fake_prepare)
    monkeypatch.setattr(runner, "events", fake_events, raising=False)
    events = [event async for event in skill_service.run_authoring_turn(skill_id, authoring_id, "跑一下测试")]
    kinds = [event["kind"] for event in events]
    # bash 结果之后立即推送一次，本轮结束再推送一次
    assert kinds == ["tool_use_start", "tool_result", "trial_files", "message", "trial_files"]
    assert events[2]["payload"] == {"count": 1}
    assert set(await _rows(env)) == {"outputs/pytest/report.txt"}
