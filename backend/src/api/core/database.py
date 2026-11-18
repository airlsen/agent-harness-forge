"""SQLAlchemy async，开发 SQLite / 部署 PostgreSQL。"""

from collections.abc import AsyncIterator
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from .config import settings


class Base(DeclarativeBase):
    pass


_engine = create_async_engine(settings.database_url, pool_pre_ping=True)
SessionFactory = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)
if settings.database_url.startswith("sqlite"):

    @event.listens_for(_engine.sync_engine, "connect")
    def sqlite_options(connection, _record):
        cursor = connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionFactory() as session:
        yield session


async def init_db() -> None:
    from .. import models  # noqa: F401

    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Additive compatibility for existing workspaces created before MCP transport selection.
        def ensure_mcp_transport(sync_conn):
            from sqlalchemy import inspect, text

            inspector = inspect(sync_conn)
            if "mcp_server" in inspector.get_table_names() and "transport" not in {
                column["name"] for column in inspector.get_columns("mcp_server")
            }:
                sync_conn.execute(text("ALTER TABLE mcp_server ADD COLUMN transport VARCHAR(24) NOT NULL DEFAULT 'streamable-http'"))

        await conn.run_sync(ensure_mcp_transport)

        # Additive compatibility for the managed-plugin registry introduced after the first sandbox schema.
        def ensure_plugin_columns(sync_conn):
            from sqlalchemy import inspect, text

            inspector = inspect(sync_conn)
            if "plugin_registry" not in inspector.get_table_names():
                return
            existing = {column["name"] for column in inspector.get_columns("plugin_registry")}
            postgres = sync_conn.dialect.name == "postgresql"
            additions = {
                "display_name": "VARCHAR(128) NOT NULL DEFAULT ''",
                "description": "VARCHAR(512) NOT NULL DEFAULT ''",
                "runtime": "VARCHAR(32) NOT NULL DEFAULT 'forge-bridge'",
                "source_ref": "VARCHAR(256) NOT NULL DEFAULT ''",
                "artifact_hash": "VARCHAR(128) NOT NULL DEFAULT ''",
                "tools_json": "JSON NOT NULL DEFAULT '[]'",
                "enabled": "BOOLEAN NOT NULL DEFAULT " + ("FALSE" if postgres else "0"),
                "plugin_id": "VARCHAR(128) NOT NULL DEFAULT ''",
                "artifact_name": "VARCHAR(256) NOT NULL DEFAULT ''",
                "artifact_bytes": "BIGINT NOT NULL DEFAULT 0",
                "manifest_json": "JSON NOT NULL DEFAULT '{}'",
                "execution_json": "JSON NOT NULL DEFAULT '{}'",
                "scan_status": "VARCHAR(32) NOT NULL DEFAULT 'builtin'",
                "review_note": "VARCHAR(1024) NOT NULL DEFAULT ''",
            }
            for name, ddl in additions.items():
                if name not in existing:
                    sync_conn.execute(text(f"ALTER TABLE plugin_registry ADD COLUMN {name} {ddl}"))
            # P0 rows used package as the stable ID. Keep them addressable after adding release keys.
            sync_conn.execute(text("UPDATE plugin_registry SET plugin_id = package WHERE plugin_id = ''"))

        await conn.run_sync(ensure_plugin_columns)

        # Additive compatibility for model availability controls.
        def ensure_model_connection_columns(sync_conn):
            from sqlalchemy import inspect, text

            inspector = inspect(sync_conn)
            if "model_connection" not in inspector.get_table_names():
                return
            existing = {column["name"] for column in inspector.get_columns("model_connection")}
            if "enabled" not in existing:
                default = "TRUE" if sync_conn.dialect.name == "postgresql" else "1"
                sync_conn.execute(text(f"ALTER TABLE model_connection ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT {default}"))

        await conn.run_sync(ensure_model_connection_columns)
    # 重启时关闭所有孤立审批，为未完成的运行保留明确的中断记录。
    from datetime import datetime, timezone
    from sqlalchemy import select, func
    from ..models.agent_session import AgentSession, SessionEventIndex
    from ..models.approval_ticket import ApprovalTicket

    async with SessionFactory() as db:
        active = (await db.scalars(select(AgentSession).where(AgentSession.status == "running"))).all()
        pending = (await db.scalars(select(ApprovalTicket).where(ApprovalTicket.status == "pending"))).all()
        affected = {row.id for row in active} | {ticket.session_id for ticket in pending}
        for session_id in affected:
            cursor = (
                await db.scalar(
                    select(func.max(SessionEventIndex.seq)).where(SessionEventIndex.session_id == session_id)
                )
                or 0
            )

            def append(kind, payload, source="system"):
                nonlocal cursor
                cursor += 1
                db.add(
                    SessionEventIndex(
                        session_id=session_id, seq=cursor, kind=kind, source=source, attrs=payload
                    )
                )

            for ticket in (ticket for ticket in pending if ticket.session_id == session_id):
                ticket.status, ticket.decided_at = "cancelled", datetime.now(timezone.utc)
                append(
                    "approval_resolved",
                    {"ticketId": ticket.id, "action": "cancelled", "reason": "控制面重启"},
                    "tools",
                )
            for row in (row for row in active if row.id == session_id):
                row.status, row.ended_at = "interrupted", datetime.now(timezone.utc)
                append("error", {"message": "控制面重启，未完成的任务已标记中断，请新建会话"})
                append("done", {"status": "error", "reason": "control-plane-restart"})
        await db.commit()


async def close_db() -> None:
    await _engine.dispose()
