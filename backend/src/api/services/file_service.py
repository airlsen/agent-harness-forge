"""会话文件服务：把 Runner 工作区同步到服务端存储，记录逐轮改动，并按保留期限清理。

- 同步：执行中每次写文件、每轮结束时，按 Runner 清单（含 SHA-256）只拉取变化的文件；
  Runner 不可用或清单不完整时保留已有记录，绝不因此误删服务端副本。
- 改动记录：每轮开始前取快照，结束后与最新清单对比，得到新增/修改/删除及文本行数变化；
  改动前后的内容都保留在仓库中，可随时查看对比。
- 保留与清理：会话最后一次活动后超过保留天数，清理 Runner 工作区与服务端副本，
  并回收不再被引用的内容。
"""

import asyncio
import difflib
import io
import logging
import time
import zipfile
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import delete, func, or_, select

from ..core.config import settings
from ..core.database import SessionFactory
from ..models.agent_session import AgentSession
from ..models.platform import SessionMessage
from ..models.session_file import SessionFile, SessionFileChange
from ..models.skill import SkillAuthoringFile, SkillAuthoringSession
from .file_store import FileStore, file_store
from .settings_service import get_policy

log = logging.getLogger(__name__)
# 超过该大小或含 NUL 的文件按二进制处理：不统计行数、不展示文本对比
TEXT_LIMIT = 512_000
MAX_DIFF_LINES = 20_000
MAX_DIFF_OUTPUT_LINES = 4_000
# 本轮改动摘要（写入用户消息）最多列出的文件数
SUMMARY_FILES = 50
# 刚写入、尚未登记的内容不参与回收，避免与并发同步竞争
GC_GRACE_SECONDS = 600


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def naive(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.astimezone(UTC).replace(tzinfo=None) if value.tzinfo else value


def iso(value: datetime | None) -> str | None:
    return value.isoformat(timespec="seconds") + "Z" if value else None


def parse_time(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return naive(datetime.fromisoformat(value))
    except ValueError:
        return None


def text_lines(data: bytes | None) -> list[str] | None:
    """按行拆分 UTF-8 文本（保留换行符）；二进制或过大时返回 None。"""
    if data is None:
        return []
    if len(data) > TEXT_LIMIT or b"\0" in data:
        return None
    try:
        lines = data.decode("utf-8").splitlines(keepends=True)
    except UnicodeDecodeError:
        return None
    if lines and not lines[-1].endswith(("\n", "\r")):
        lines[-1] += "\n"
    return lines


def line_stats(before: bytes | None, after: bytes | None) -> tuple[int | None, int | None]:
    a, b = text_lines(before), text_lines(after)
    if a is None or b is None or len(a) > MAX_DIFF_LINES or len(b) > MAX_DIFF_LINES:
        return None, None
    added = removed = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b).get_opcodes():
        if tag in ("replace", "delete"):
            removed += i2 - i1
        if tag in ("replace", "insert"):
            added += j2 - j1
    return added, removed


def last_activity(session: AgentSession) -> datetime | None:
    """保留期限的起算点：最后一次执行与最后一次文件同步中较晚者。

    旧会话在升级后首次同步（补同步）时也会刷新该时间，因此升级不会立即清理存量会话的文件。
    """
    times = [naive(session.ended_at) or naive(session.created_at), naive(session.files_synced_at)]
    return max((t for t in times if t), default=None)


class FileService:
    def __init__(self, store: FileStore = file_store, sessions=SessionFactory):
        self.store = store
        self.sessions = sessions
        self.locks: dict[object, asyncio.Lock] = {}
        self.last_cleanup: dict | None = None
        self.cleanup_lock = asyncio.Lock()

    def lock(self, key) -> asyncio.Lock:
        """同步锁：业务会话以会话 ID 为键，Skill 编辑对话以 ("skill", 对话 ID) 为键。"""
        return self.locks.setdefault(key, asyncio.Lock())

    # ---------- 同步 ----------

    async def snapshot(self, session_id: int) -> dict[str, tuple[str, int]]:
        async with self.sessions() as db:
            rows = (await db.scalars(select(SessionFile).where(SessionFile.session_id == session_id))).all()
        return {row.path: (row.sha256, row.bytes) for row in rows}

    @staticmethod
    async def _listing(runner_session_id: str, client) -> tuple[list, bool] | None:
        """读取 Runner 工作区清单；Runner 离线或工作区丢失时返回 None（调用方保留服务端副本）。"""
        try:
            listing = await client.call("GET", f"/v1/sessions/{runner_session_id}/files")
        except Exception:  # noqa: BLE001 - Runner 离线或工作区丢失时保留服务端副本
            return None
        items = listing.get("items") if isinstance(listing, dict) else None
        if not isinstance(items, list):
            return None
        return items, not listing.get("truncated")

    async def _pull(
        self, db, rows: dict, items: list, runner_session_id: str, client, new_row
    ) -> tuple[set, bool]:
        """按清单拉取变化的文件写入存储并更新 rows（path → 记录），返回 (清单中的路径, 清单是否完整)。

        new_row(path) 创建并登记一条新记录；内容哈希未变且存储中仍有内容的文件不重复拉取。
        """
        complete = True
        seen: set[str] = set()
        for item in items:
            path = item.get("path") if isinstance(item, dict) else None
            if not isinstance(path, str) or not path or len(path) > 256:
                continue
            seen.add(path)
            row, digest = rows.get(path), item.get("sha256")
            if row and digest and row.sha256 == digest and self.store.exists(digest):
                continue
            try:
                data, mime = await client.raw(
                    f"/v1/sessions/{runner_session_id}/raw?path={quote(path, safe='')}"
                )
            except HTTPException as error:
                if error.status_code == 404:  # 列出后又被删除
                    seen.discard(path)
                else:
                    complete = False
                continue
            if row is None:
                row = new_row(path)
                db.add(row)
                rows[path] = row
            row.sha256 = self.store.put(data)
            row.bytes = len(data)
            row.mime = (item.get("mime") or mime or "application/octet-stream").split(";")[0][:128]
            row.modified_at = parse_time(item.get("modifiedAt")) or utcnow()
        return seen, complete

    async def sync(self, session_id: int, runner_session_id: str, client) -> bool:
        """把 Runner 工作区同步到服务端存储，返回是否拿到了权威清单。"""
        if not runner_session_id:
            return False
        async with self.lock(session_id):
            listing = await self._listing(runner_session_id, client)
            if listing is None:
                return False
            items, complete = listing
            async with self.sessions() as db:
                rows = {
                    row.path: row
                    for row in (
                        await db.scalars(select(SessionFile).where(SessionFile.session_id == session_id))
                    ).all()
                }
                seen, pulled = await self._pull(
                    db,
                    rows,
                    items,
                    runner_session_id,
                    client,
                    lambda path: SessionFile(session_id=session_id, path=path),
                )
                if complete and pulled:
                    for path, row in rows.items():
                        if path not in seen:
                            await db.delete(row)
                session = await db.get(AgentSession, session_id)
                if session:
                    session.files_synced_at = utcnow()
                    if seen:
                        session.files_purged_at = None
                await db.commit()
            return True

    async def ensure_synced(self, session: AgentSession, client) -> None:
        """旧会话（本功能上线前创建）首次访问时补一次同步。"""
        if session.files_synced_at is None and session.files_purged_at is None and session.runner_session_id:
            await self.sync(session.id, session.runner_session_id, client)

    async def finish_turn(
        self, session_id: int, runner_session_id: str, message_id: int, baseline: dict, client
    ) -> dict | None:
        """一轮结束：同步并与轮前快照对比，记录改动并写入该轮用户消息；无改动时返回 None。"""
        if not await self.sync(session_id, runner_session_id, client):
            return None
        current = await self.snapshot(session_id)
        changes = []
        for path in sorted(set(baseline) | set(current)):
            before, after = baseline.get(path), current.get(path)
            if before and after and before[0] == after[0]:
                continue
            action = "added" if not before else "deleted" if not after else "modified"
            changes.append((path, action, before, after))
        if not changes:
            return None
        async with self.sessions() as db:
            records = []
            for path, action, before, after in changes:
                added, removed = line_stats(self._read(before), self._read(after))
                record = SessionFileChange(
                    session_id=session_id,
                    message_id=message_id,
                    actor="agent",
                    path=path,
                    action=action,
                    before_sha=before[0] if before else "",
                    after_sha=after[0] if after else "",
                    before_bytes=before[1] if before else 0,
                    after_bytes=after[1] if after else 0,
                    lines_added=added,
                    lines_removed=removed,
                )
                db.add(record)
                records.append(record)
            await db.flush()
            summary = self.summary(message_id, records)
            message = await db.get(SessionMessage, message_id)
            if message:
                message.meta = {**(message.meta or {}), "workspaceChanges": summary}
            await db.commit()
        return summary

    def _read(self, entry: tuple[str, int] | None) -> bytes | None:
        if not entry:
            return None
        sha, size = entry
        if size > TEXT_LIMIT:
            return b"\0"  # 视为二进制，避免读入大文件
        try:
            return self.store.get(sha)
        except (FileNotFoundError, ValueError):
            return b"\0"

    @staticmethod
    def summary(message_id: int, records: list[SessionFileChange]) -> dict:
        count = {
            action: sum(1 for r in records if r.action == action)
            for action in ("added", "modified", "deleted")
        }
        return {
            "messageId": message_id,
            **count,
            "total": len(records),
            "files": [
                {
                    "id": record.id,
                    "path": record.path,
                    "action": record.action,
                    "bytes": record.after_bytes if record.action != "deleted" else record.before_bytes,
                    "linesAdded": record.lines_added,
                    "linesRemoved": record.lines_removed,
                }
                for record in records[:SUMMARY_FILES]
            ],
        }

    # ---------- 查询 ----------

    async def retention_days(self, db) -> int:
        return int((await get_policy(db)).get("fileRetentionDays", 30) or 0)

    async def list(self, db, session: AgentSession) -> dict:
        rows = (
            await db.scalars(
                select(SessionFile).where(SessionFile.session_id == session.id).order_by(SessionFile.path)
            )
        ).all()
        days = await self.retention_days(db)
        activity = last_activity(session)
        expires = activity + timedelta(days=days) if days > 0 and activity and rows else None
        return {
            "items": [
                {
                    "path": row.path,
                    "bytes": row.bytes,
                    "mime": row.mime,
                    "modifiedAt": iso(row.modified_at),
                    "sha256": row.sha256,
                }
                for row in rows
            ],
            "retention": {"days": days, "expiresAt": iso(expires)},
        }

    async def _row(self, db, session_id: int, path: str) -> SessionFile:
        row = await db.scalar(
            select(SessionFile).where(SessionFile.session_id == session_id, SessionFile.path == path)
        )
        if not row:
            raise HTTPException(404, "文件不存在或已被删除")
        return row

    async def raw(self, db, session_id: int, path: str) -> tuple[bytes, str]:
        row = await self._row(db, session_id, path)
        try:
            return self.store.get(row.sha256), row.mime
        except FileNotFoundError as error:
            raise HTTPException(410, "文件内容已被清理") from error

    async def archive(self, db, session_id: int, directory: str = "") -> bytes:
        prefix = directory.strip("/")
        query = select(SessionFile).where(SessionFile.session_id == session_id)
        if prefix:
            query = query.where(or_(SessionFile.path == prefix, SessionFile.path.startswith(prefix + "/")))
        rows = (await db.scalars(query.order_by(SessionFile.path))).all()
        buffer = io.BytesIO()
        written = 0
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for row in rows:
                try:
                    data = self.store.get(row.sha256)
                except FileNotFoundError:
                    continue
                name = row.path[len(prefix) + 1 :] if prefix and row.path != prefix else row.path
                info = zipfile.ZipInfo(name, date_time=(row.modified_at or utcnow()).timetuple()[:6])
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                archive.writestr(info, data)
                written += 1
        if not written:
            raise HTTPException(404, "没有可打包下载的文件")
        return buffer.getvalue()

    async def diff(self, db, session_id: int, change_id: int) -> dict:
        change = await db.get(SessionFileChange, change_id)
        if not change or change.session_id != session_id:
            raise HTTPException(404, "改动记录不存在或已被清理")
        view = {
            "id": change.id,
            "path": change.path,
            "action": change.action,
            "linesAdded": change.lines_added,
            "linesRemoved": change.lines_removed,
            "beforeBytes": change.before_bytes,
            "afterBytes": change.after_bytes,
            "binary": False,
            "truncated": False,
            "diff": "",
        }
        try:
            before = self.store.get(change.before_sha) if change.before_sha else None
            after = self.store.get(change.after_sha) if change.after_sha else None
        except FileNotFoundError as error:
            raise HTTPException(410, "改动内容已被清理") from error
        a, b = text_lines(before), text_lines(after)
        if a is None or b is None or len(a) > MAX_DIFF_LINES or len(b) > MAX_DIFF_LINES:
            return {**view, "binary": True}
        lines = list(
            difflib.unified_diff(
                a,
                b,
                fromfile=f"a/{change.path}" if before is not None else "/dev/null",
                tofile=f"b/{change.path}" if after is not None else "/dev/null",
                n=3,
            )
        )
        truncated = len(lines) > MAX_DIFF_OUTPUT_LINES
        return {**view, "truncated": truncated, "diff": "".join(lines[:MAX_DIFF_OUTPUT_LINES])}

    # ---------- Skill 编辑对话的试用文件 ----------
    # 编辑对话的会话工作区（试用产出、脚本输出）同步到 skill_authoring_file，与 Skill 目录分开：
    # 不进入修订、不随发布。执行会话重建时旧工作区的记录保留（只删除当前执行会话清单中消失的文件）。

    async def sync_authoring(self, authoring_session_id: int, runner_session_id: str, client) -> bool:
        """同步一个编辑对话的工作区，返回是否拿到了权威清单。"""
        if not runner_session_id:
            return False
        async with self.lock(("skill", authoring_session_id)):
            listing = await self._listing(runner_session_id, client)
            if listing is None:
                return False
            items, complete = listing
            async with self.sessions() as db:
                rows = {
                    row.path: row
                    for row in (
                        await db.scalars(
                            select(SkillAuthoringFile).where(
                                SkillAuthoringFile.authoring_session_id == authoring_session_id
                            )
                        )
                    ).all()
                }

                def new_row(path: str) -> SkillAuthoringFile:
                    return SkillAuthoringFile(
                        authoring_session_id=authoring_session_id,
                        runner_session_id=runner_session_id,
                        path=path,
                    )

                seen, pulled = await self._pull(db, rows, items, runner_session_id, client, new_row)
                for path in seen:
                    rows[path].runner_session_id = runner_session_id
                if complete and pulled:
                    for path, row in rows.items():
                        if path not in seen and row.runner_session_id == runner_session_id:
                            await db.delete(row)
                await db.commit()
            return True

    async def authoring_list(self, db, authoring_session_id: int) -> "list[dict]":
        rows = (
            await db.scalars(
                select(SkillAuthoringFile)
                .where(SkillAuthoringFile.authoring_session_id == authoring_session_id)
                .order_by(SkillAuthoringFile.path)
            )
        ).all()
        return [
            {
                "path": row.path,
                "bytes": row.bytes,
                "mime": row.mime,
                "modifiedAt": iso(row.modified_at),
                "sha256": row.sha256,
            }
            for row in rows
        ]

    async def _authoring_row(self, db, authoring_session_id: int, path: str) -> SkillAuthoringFile:
        row = await db.scalar(
            select(SkillAuthoringFile).where(
                SkillAuthoringFile.authoring_session_id == authoring_session_id,
                SkillAuthoringFile.path == path,
            )
        )
        if not row:
            raise HTTPException(404, "文件不存在或已被删除")
        return row

    async def authoring_raw(self, db, authoring_session_id: int, path: str) -> tuple[bytes, str]:
        row = await self._authoring_row(db, authoring_session_id, path)
        try:
            return self.store.get(row.sha256), row.mime
        except FileNotFoundError as error:
            raise HTTPException(410, "文件内容已被清理") from error

    async def authoring_delete(
        self, authoring_session_id: int, runner_session_id: str, path: str, client
    ) -> None:
        """删除一个试用文件：当前执行会话的工作区与服务端记录一起删除。"""
        async with self.lock(("skill", authoring_session_id)), self.sessions() as db:
            row = await self._authoring_row(db, authoring_session_id, path)
            if runner_session_id and row.runner_session_id == runner_session_id:
                try:
                    await client.call(
                        "DELETE", f"/v1/sessions/{runner_session_id}/file?path={quote(path, safe='')}"
                    )
                except HTTPException as error:
                    if error.status_code != 404:  # Runner 中已不存在时只需删除服务端副本
                        raise
            await db.delete(row)
            await db.commit()

    async def authoring_purge(self, authoring_session_id: int, runner_session_id: str, client) -> None:
        """清理一个编辑对话的全部试用文件：Runner 工作区（尽力而为）与服务端记录。"""
        async with self.lock(("skill", authoring_session_id)):
            if runner_session_id:
                try:
                    await client.call("DELETE", f"/v1/sessions/{runner_session_id}/workspace")
                except Exception:  # noqa: BLE001 - Runner 离线时只清理服务端记录
                    log.info("编辑对话 %s 的 Runner 工作区清理失败，仅清理服务端记录", authoring_session_id)
            async with self.sessions() as db:
                await db.execute(
                    delete(SkillAuthoringFile).where(
                        SkillAuthoringFile.authoring_session_id == authoring_session_id
                    )
                )
                await db.commit()

    # ---------- 删除与清理 ----------

    async def delete(self, session: AgentSession, path: str, client) -> None:
        if session.status == "running":
            raise HTTPException(409, "会话正在执行，请等待本轮结束后再删除文件")
        async with self.lock(session.id), self.sessions() as db:
            row = await self._row(db, session.id, path)
            if session.runner_session_id:
                try:
                    await client.call(
                        "DELETE", f"/v1/sessions/{session.runner_session_id}/file?path={quote(path, safe='')}"
                    )
                except HTTPException as error:
                    if error.status_code != 404:  # Runner 中已不存在时只需删除服务端副本
                        raise
            db.add(
                SessionFileChange(
                    session_id=session.id,
                    actor="user",
                    path=row.path,
                    action="deleted",
                    before_sha=row.sha256,
                    before_bytes=row.bytes,
                )
            )
            await db.delete(row)
            await db.commit()

    async def purge(self, session_id: int, runner_session_id: str, client) -> None:
        """清理一个会话的全部文件：Runner 工作区、服务端清单与改动记录。"""
        async with self.lock(session_id):
            if runner_session_id:
                try:
                    await client.call("DELETE", f"/v1/sessions/{runner_session_id}/workspace")
                except HTTPException as error:
                    if error.status_code != 404:
                        raise
            async with self.sessions() as db:
                await db.execute(delete(SessionFile).where(SessionFile.session_id == session_id))
                await db.execute(delete(SessionFileChange).where(SessionFileChange.session_id == session_id))
                session = await db.get(AgentSession, session_id)
                if session:
                    session.files_purged_at = utcnow()
                await db.commit()

    async def gc(self) -> int:
        """回收不再被任何文件或改动记录引用的内容，返回释放的字节数。"""
        async with self.sessions() as db:
            referenced = set((await db.scalars(select(SessionFile.sha256))).all())
            referenced |= set((await db.scalars(select(SessionFileChange.before_sha))).all())
            referenced |= set((await db.scalars(select(SessionFileChange.after_sha))).all())
            referenced |= set((await db.scalars(select(SkillAuthoringFile.sha256))).all())
        threshold = time.time() - GC_GRACE_SECONDS
        freed = 0
        for sha, _size, mtime in self.store.all():
            if sha not in referenced and mtime < threshold:
                freed += self.store.delete(sha)
        return freed

    async def cleanup_expired(self, client, now: datetime | None = None) -> dict:
        """清理超过保留期限的会话文件；单个会话失败不影响其他会话，下次继续重试。"""
        async with self.cleanup_lock:
            now = naive(now) or utcnow()
            async with self.sessions() as db:
                days = await self.retention_days(db)
                expired = []
                if days > 0:
                    cutoff = now - timedelta(days=days)
                    has_files = (
                        select(SessionFile.id).where(SessionFile.session_id == AgentSession.id).exists()
                    )
                    expired = (
                        await db.execute(
                            select(
                                AgentSession.id, AgentSession.runner_session_id, AgentSession.files_synced_at
                            ).where(
                                AgentSession.status != "running",
                                AgentSession.files_purged_at.is_(None),
                                func.coalesce(AgentSession.ended_at, AgentSession.created_at) < cutoff,
                                or_(
                                    AgentSession.files_synced_at.is_(None),
                                    AgentSession.files_synced_at < cutoff,
                                ),
                                or_(AgentSession.runner_session_id != "", has_files),
                            )
                        )
                    ).all()
            purged = failed = backfilled = 0
            for session_id, runner_session_id, synced_at in expired:
                try:
                    if synced_at is None and runner_session_id:
                        # 升级前的旧会话：先补同步到服务端、从现在起计算保留期限，而不是直接清理
                        if await self.sync(session_id, runner_session_id, client):
                            backfilled += 1
                        else:
                            failed += 1
                        continue
                    await self.purge(session_id, runner_session_id, client)
                    purged += 1
                except Exception:
                    failed += 1
                    log.warning("会话 %s 的文件清理失败，将在下次重试", session_id, exc_info=True)
            # Skill 编辑对话的试用文件：对话最后一次活动超过保留期限后清理
            purged_authoring = 0
            if days > 0:
                cutoff = now - timedelta(days=days)
                async with self.sessions() as db:
                    has_trial_files = (
                        select(SkillAuthoringFile.id)
                        .where(SkillAuthoringFile.authoring_session_id == SkillAuthoringSession.id)
                        .exists()
                    )
                    stale = (
                        await db.execute(
                            select(SkillAuthoringSession.id, SkillAuthoringSession.runner_session_id).where(
                                SkillAuthoringSession.status != "running",
                                SkillAuthoringSession.updated_at < cutoff,
                                has_trial_files,
                            )
                        )
                    ).all()
                for authoring_id, runner_session_id in stale:
                    try:
                        await self.authoring_purge(authoring_id, runner_session_id, client)
                        purged_authoring += 1
                    except Exception:
                        failed += 1
                        log.warning(
                            "编辑对话 %s 的试用文件清理失败，将在下次重试", authoring_id, exc_info=True
                        )
            result = {
                "retentionDays": days,
                "purgedSessions": purged,
                "purgedSkillConversations": purged_authoring,
                "backfilledSessions": backfilled,
                "failedSessions": failed,
                "freedBytes": await self.gc(),
                "ranAt": iso(utcnow()),
            }
            self.last_cleanup = result
            return result

    async def retention_loop(self, client) -> None:
        await asyncio.sleep(60)
        while True:
            try:
                await self.cleanup_expired(client)
            except Exception:
                log.exception("会话文件过期清理失败")
            await asyncio.sleep(max(60, settings.file_cleanup_interval_seconds))

    async def stats(self, db) -> dict:
        files, logical, sessions = (
            await db.execute(
                select(
                    func.count(SessionFile.id),
                    func.coalesce(func.sum(SessionFile.bytes), 0),
                    func.count(func.distinct(SessionFile.session_id)),
                )
            )
        ).one()
        objects = self.store.all()
        return {
            "files": files,
            "bytes": int(logical),
            "sessions": sessions,
            "storedObjects": len(objects),
            "storedBytes": sum(size for _, size, _ in objects),
            "retentionDays": await self.retention_days(db),
            "lastCleanup": self.last_cleanup,
        }


file_service = FileService()
