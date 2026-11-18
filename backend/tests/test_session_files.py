"""会话文件：服务端存储同步、逐轮改动记录、删除、打包、对比、保留期限清理与 Runner 原始字节接口。"""

import io
import os
import time
import zipfile
from datetime import datetime, timedelta
from hashlib import sha256

import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.models.agent_session import AgentSession
from src.api.models.platform import PlatformSetting, SessionMessage
from src.api.models.session_file import SessionFileChange
from src.api.routes import agent_session as routes
from src.api.routes import governance as governance_routes
from src.api.services import file_service as file_module
from src.api.services.file_service import FileService, line_stats
from src.api.services.file_store import FileStore
from src.api.services.runner_client import RunnerClient


class FakeRunner:
    """模拟 Runner 工作区：清单带 SHA-256，可切换离线、截断清单。"""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.offline = False
        self.truncated = False
        self.raw_calls: list[str] = []
        self.deleted: list[str] = []
        self.purged: list[str] = []

    async def call(self, method, path, _body=None):
        if self.offline:
            raise HTTPException(503, "Runner 不可用")
        if method == "GET" and path.endswith("/files"):
            return {
                "items": [
                    {
                        "path": name,
                        "bytes": len(data),
                        "mime": "text/markdown" if name.endswith(".md") else "application/octet-stream",
                        "modifiedAt": "2026-11-18T08:00:00.000Z",
                        "sha256": sha256(data).hexdigest(),
                    }
                    for name, data in sorted(self.files.items())
                ],
                "truncated": self.truncated,
            }
        if method == "DELETE" and "/file?path=" in path:
            from urllib.parse import unquote

            name = unquote(path.split("path=", 1)[1])
            if name not in self.files:
                raise HTTPException(404, "文件不存在或已被删除")
            del self.files[name]
            self.deleted.append(name)
            return {"ok": True}
        if method == "DELETE" and path.endswith("/workspace"):
            self.files.clear()
            self.purged.append(path)
            return {"ok": True}
        raise AssertionError(f"unexpected call {method} {path}")

    async def raw(self, path):
        from urllib.parse import unquote

        if self.offline:
            raise HTTPException(503, "Runner 不可用")
        self.raw_calls.append(path)
        name = unquote(path.split("path=", 1)[1])
        if name not in self.files:
            raise HTTPException(404, "文件不存在或已被删除")
        return self.files[name], "application/octet-stream"


@pytest_asyncio.fixture
async def env(tmp_path, monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    service = FileService(FileStore(tmp_path), sessions)
    runner = FakeRunner()
    monkeypatch.setattr(routes, "file_service", service)
    monkeypatch.setattr(routes, "runner_client", runner)
    monkeypatch.setattr(governance_routes, "file_service", service)
    monkeypatch.setattr(governance_routes, "runner_client", runner)

    async def row(db, session_id):
        found = await db.get(AgentSession, session_id)
        if not found:
            raise HTTPException(404, "会话不存在")
        return found

    monkeypatch.setattr(routes.session_service, "row", row)
    async with sessions() as db:
        session = AgentSession(
            scenario_id=1,
            bundle_hash="h",
            title="t",
            user_id="u",
            status="idle",
            runner_session_id="runner-1",
            files_synced_at=datetime(2026, 11, 18),
        )
        db.add(session)
        await db.flush()
        message = SessionMessage(session_id=session.id, role="user", content="写报告", meta={})
        db.add(message)
        await db.commit()
        ids = {"session": session.id, "message": message.id}
    yield {"service": service, "runner": runner, "sessions": sessions, **ids}
    await engine.dispose()


async def files_of(env):
    async with env["sessions"]() as db:
        return (await routes.files(env["session"], db=db)).data


def test_line_stats_counts_text_and_skips_binary():
    assert line_stats(None, b"a\nb\n") == (2, 0)
    assert line_stats(b"a\nb\nc\n", b"a\nB\nc\nd") == (2, 1)
    assert line_stats(b"a\n", None) == (0, 1)
    assert line_stats(b"\x89PNG\0", b"\x89PNG\0x") == (None, None)


@pytest.mark.asyncio
async def test_turn_sync_records_changes_and_survives_runner_loss(env):
    service, runner = env["service"], env["runner"]
    runner.files = {"report.md": b"# v1\n", "old.txt": b"bye\n", "chart.png": b"\x89PNG\0"}
    assert await service.sync(env["session"], "runner-1", runner)
    baseline = await service.snapshot(env["session"])

    runner.files = {"report.md": b"# v2\nmore\n", "chart.png": b"\x89PNG\0", "data/new.csv": b"a,b\n1,2\n"}
    runner.raw_calls.clear()
    summary = await service.finish_turn(env["session"], "runner-1", env["message"], baseline, runner)

    # 未变化的文件按哈希跳过，不重复拉取
    assert sorted(runner.raw_calls) == [
        "/v1/sessions/runner-1/raw?path=data%2Fnew.csv",
        "/v1/sessions/runner-1/raw?path=report.md",
    ]
    assert (summary["added"], summary["modified"], summary["deleted"], summary["total"]) == (1, 1, 1, 3)
    by_path = {item["path"]: item for item in summary["files"]}
    assert by_path["report.md"]["linesAdded"] == 2 and by_path["report.md"]["linesRemoved"] == 1
    assert by_path["old.txt"]["action"] == "deleted" and by_path["old.txt"]["linesRemoved"] == 1
    assert by_path["data/new.csv"]["action"] == "added"
    async with env["sessions"]() as db:
        message = await db.get(SessionMessage, env["message"])
        assert message.meta["workspaceChanges"]["total"] == 3
        changes = (await db.scalars(select(SessionFileChange))).all()
        assert {c.actor for c in changes} == {"agent"} and {c.message_id for c in changes} == {env["message"]}

    # 无改动的轮次不产生记录
    assert (
        await service.finish_turn(
            env["session"], "runner-1", env["message"], await service.snapshot(env["session"]), runner
        )
        is None
    )

    # Runner 离线或工作区已回收：清单与原始字节都来自服务端存储
    runner.offline = True
    listing = await files_of(env)
    assert [item["path"] for item in listing["items"]] == ["chart.png", "data/new.csv", "report.md"]
    assert listing["retention"]["days"] == 30
    async with env["sessions"]() as db:
        response = await routes.file_raw(env["session"], path="report.md", db=db)
    assert response.body == b"# v2\nmore\n"
    assert response.media_type == "text/markdown"
    assert response.headers["content-disposition"] == "attachment; filename*=UTF-8''report.md"
    assert response.headers["content-security-policy"] == "sandbox; default-src 'none'"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert not await service.sync(env["session"], "runner-1", runner)
    assert len((await files_of(env))["items"]) == 3


@pytest.mark.asyncio
async def test_truncated_listing_never_deletes_stored_files(env):
    service, runner = env["service"], env["runner"]
    runner.files = {"a.txt": b"a", "b.txt": b"b"}
    await service.sync(env["session"], "runner-1", runner)
    runner.files = {"a.txt": b"a"}
    runner.truncated = True
    await service.sync(env["session"], "runner-1", runner)
    assert [item["path"] for item in (await files_of(env))["items"]] == ["a.txt", "b.txt"]


@pytest.mark.asyncio
async def test_legacy_session_is_backfilled_on_first_access(env):
    runner = env["runner"]
    runner.files = {"图表/月度 1.md": b"# legacy\n"}
    async with env["sessions"]() as db:
        session = await db.get(AgentSession, env["session"])
        session.files_synced_at = None
        await db.commit()
    listing = await files_of(env)
    assert [item["path"] for item in listing["items"]] == ["图表/月度 1.md"]
    async with env["sessions"]() as db:
        assert (await db.get(AgentSession, env["session"])).files_synced_at is not None
        response = await routes.file_raw(env["session"], path="图表/月度 1.md", db=db)
    assert response.headers["content-disposition"] == (
        "attachment; filename*=UTF-8''%E6%9C%88%E5%BA%A6%201.md"
    )


@pytest.mark.asyncio
async def test_delete_archive_and_diff(env):
    service, runner = env["service"], env["runner"]
    runner.files = {"report.md": b"# v1\n", "out/a.txt": b"A\n", "out/sub/b.bin": b"\0\1"}
    await service.sync(env["session"], "runner-1", runner)
    baseline = await service.snapshot(env["session"])
    runner.files["report.md"] = b"# v2\n"
    summary = await service.finish_turn(env["session"], "runner-1", env["message"], baseline, runner)

    async with env["sessions"]() as db:
        diff = (await routes.file_change(env["session"], summary["files"][0]["id"], db=db)).data
    assert diff["path"] == "report.md" and not diff["binary"]
    assert "-# v1\n+# v2\n" in diff["diff"] and diff["diff"].startswith("--- a/report.md")

    async with env["sessions"]() as db:
        whole = await routes.file_archive(env["session"], dir="", db=db)
        folder = await routes.file_archive(env["session"], dir="out", db=db)
    assert whole.media_type == "application/zip"
    assert "forge-session-" in whole.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(whole.body)) as archive:
        assert sorted(archive.namelist()) == ["out/a.txt", "out/sub/b.bin", "report.md"]
        assert archive.read("report.md") == b"# v2\n"
    with zipfile.ZipFile(io.BytesIO(folder.body)) as archive:
        assert sorted(archive.namelist()) == ["a.txt", "sub/b.bin"]
    async with env["sessions"]() as db:
        with pytest.raises(HTTPException) as empty:
            await routes.file_archive(env["session"], dir="nothing", db=db)
    assert empty.value.status_code == 404

    async with env["sessions"]() as db:
        await routes.delete_file(env["session"], path="out/a.txt", db=db)
    assert runner.deleted == ["out/a.txt"]
    assert [item["path"] for item in (await files_of(env))["items"]] == ["out/sub/b.bin", "report.md"]
    async with env["sessions"]() as db:
        record = (await db.scalars(select(SessionFileChange).where(SessionFileChange.actor == "user"))).one()
        assert (record.path, record.action, record.message_id) == ("out/a.txt", "deleted", None)
        with pytest.raises(HTTPException) as gone:
            await routes.delete_file(env["session"], path="out/a.txt", db=db)
        assert gone.value.status_code == 404

    # Runner 中已不存在（例如已被回收）时，只删除服务端副本
    del runner.files["report.md"]
    async with env["sessions"]() as db:
        await routes.delete_file(env["session"], path="report.md", db=db)
    assert [item["path"] for item in (await files_of(env))["items"]] == ["out/sub/b.bin"]

    async with env["sessions"]() as db:
        session = await db.get(AgentSession, env["session"])
        session.status = "running"
        await db.commit()
        with pytest.raises(HTTPException) as busy:
            await routes.delete_file(env["session"], path="out/sub/b.bin", db=db)
    assert busy.value.status_code == 409


@pytest.mark.asyncio
async def test_retention_cleanup_purges_expired_sessions_and_collects_garbage(env):
    service, runner = env["service"], env["runner"]
    runner.files = {"report.md": b"# keep\n"}
    await service.sync(env["session"], "runner-1", runner)
    stored = service.store.path(sha256(b"# keep\n").hexdigest())
    orphan = service.store.put(b"orphan")
    old = time.time() - 3600
    os.utime(stored, (old, old))
    os.utime(service.store.path(orphan), (old, old))
    fresh = service.store.put(b"just written")  # 宽限期内的新内容不回收
    async with env["sessions"]() as db:
        session = await db.get(AgentSession, env["session"])
        session.ended_at = datetime(2020, 1, 1)
        session.files_synced_at = datetime(2020, 1, 1)
        await db.commit()

    # 未过期：只回收孤立内容
    result = await service.cleanup_expired(runner, now=datetime(2020, 1, 20))
    assert result["purgedSessions"] == 0 and result["freedBytes"] == len(b"orphan")
    assert stored.exists() and service.store.exists(fresh) and not service.store.exists(orphan)

    # 保留 0 天表示永久保留
    async with env["sessions"]() as db:
        db.add(PlatformSetting(key="policy", value={"fileRetentionDays": 0}))
        await db.commit()
    assert (await service.cleanup_expired(runner))["purgedSessions"] == 0

    async with env["sessions"]() as db:
        policy = await db.get(PlatformSetting, "policy")
        policy.value = {"fileRetentionDays": 30}
        await db.commit()
    async with env["sessions"]() as db:
        stats = (await governance_routes.storage(db=db)).data
    assert (stats["files"], stats["sessions"], stats["retentionDays"]) == (1, 1, 30)

    result = (await governance_routes.cleanup()).data
    assert result["purgedSessions"] == 1 and result["failedSessions"] == 0
    assert runner.purged == ["/v1/sessions/runner-1/workspace"] and not stored.exists()
    listing = await files_of(env)
    assert listing["items"] == [] and listing["retention"]["expiresAt"] is None
    async with env["sessions"]() as db:
        assert (await db.get(AgentSession, env["session"])).files_purged_at is not None
    # 已清理的会话不会重复清理
    assert (await service.cleanup_expired(runner))["purgedSessions"] == 0

    # Runner 清理失败时保留服务端副本，下次重试
    async with env["sessions"]() as db:
        session = await db.get(AgentSession, env["session"])
        session.files_purged_at = None
        await db.commit()
    runner.files = {"x.txt": b"x"}
    await service.sync(env["session"], "runner-1", runner)
    runner.offline = True
    result = await service.cleanup_expired(runner, now=datetime.now() + timedelta(days=400))
    assert result["failedSessions"] == 1
    assert [item["path"] for item in (await files_of(env))["items"]] == ["x.txt"]


@pytest.mark.asyncio
async def test_expiry_is_reported_from_last_activity(env):
    runner = env["runner"]
    runner.files = {"a.txt": b"a"}
    await env["service"].sync(env["session"], "runner-1", runner)
    async with env["sessions"]() as db:
        session = await db.get(AgentSession, env["session"])
        session.ended_at = datetime(2026, 11, 1, 12, 0, 0)
        session.files_synced_at = datetime(2026, 10, 1)
        await db.commit()
    assert (await files_of(env))["retention"]["expiresAt"] == "2026-12-01T12:00:00Z"
    # 文件同步晚于最后一次执行时（例如升级后的补同步），从同步时间起算
    async with env["sessions"]() as db:
        session = await db.get(AgentSession, env["session"])
        session.files_synced_at = datetime(2026, 11, 10)
        await db.commit()
    assert (await files_of(env))["retention"]["expiresAt"] == "2026-12-10T00:00:00Z"


@pytest.mark.asyncio
async def test_upgrade_backfills_legacy_sessions_instead_of_purging(env):
    """升级前创建、早已不活动的旧会话：首次清理时先补同步保存，保留期限从此刻起算。"""
    service, runner = env["service"], env["runner"]
    runner.files = {"legacy.md": b"# old\n"}
    async with env["sessions"]() as db:
        session = await db.get(AgentSession, env["session"])
        session.ended_at = datetime(2020, 1, 1)
        session.files_synced_at = None
        await db.commit()
    result = (await governance_routes.cleanup()).data
    assert (result["purgedSessions"], result["backfilledSessions"]) == (0, 1)
    assert runner.purged == [] and runner.files == {"legacy.md": b"# old\n"}
    assert [item["path"] for item in (await files_of(env))["items"]] == ["legacy.md"]
    # 再次清理时已在保留期内，不会被清理
    assert (await service.cleanup_expired(runner))["purgedSessions"] == 0
    # Runner 离线时补同步失败，下次重试，不清理
    async with env["sessions"]() as db:
        session = await db.get(AgentSession, env["session"])
        session.files_synced_at = None
        await db.commit()
    runner.offline = True
    result = await service.cleanup_expired(runner)
    assert (result["purgedSessions"], result["failedSessions"]) == (0, 1)


def test_file_store_is_content_addressed(tmp_path):
    store = FileStore(tmp_path)
    sha = store.put(b"same")
    assert store.put(b"same") == sha and store.get(sha) == b"same"
    assert oct(store.path(sha).stat().st_mode & 0o777) == "0o600"
    assert [(item[0], item[1]) for item in store.all()] == [(sha, 4)]
    with pytest.raises(ValueError):
        store.path("../../etc/passwd")
    assert store.delete(sha) == 4 and store.delete(sha) == 0


def test_module_singleton_uses_default_store():
    assert isinstance(file_module.file_service.store, FileStore)


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
