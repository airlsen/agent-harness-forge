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
                sync_conn.execute(
                    text(
                        "ALTER TABLE mcp_server ADD COLUMN transport VARCHAR(24) NOT NULL DEFAULT 'streamable-http'"
                    )
                )

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
                "is_default": "BOOLEAN NOT NULL DEFAULT " + ("FALSE" if postgres else "0"),
                "last_tested_at": "TIMESTAMP NULL",
                "last_test_error": "VARCHAR(512) NOT NULL DEFAULT ''",
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
            if "is_default" not in existing:
                # Preserve the previously active release for existing installations once.
                from ..services.plugin_service import _version_key

                rows = (
                    sync_conn.execute(
                        text("""
                    SELECT id, COALESCE(NULLIF(plugin_id, ''), package) AS plugin_id, version
                    FROM plugin_registry WHERE audit_status = 'approved' AND enabled = TRUE
                """)
                    )
                    .mappings()
                    .all()
                )
                selected = {}
                for row in rows:
                    previous = selected.get(row["plugin_id"])
                    if previous is None or (_version_key(row["version"]), row["id"]) > (
                        _version_key(previous["version"]),
                        previous["id"],
                    ):
                        selected[row["plugin_id"]] = row
                for row in selected.values():
                    sync_conn.execute(
                        text("UPDATE plugin_registry SET is_default = TRUE WHERE id = :id"), {"id": row["id"]}
                    )
            # P0 rows used package as the stable ID. Keep them addressable after adding release keys.
            sync_conn.execute(text("UPDATE plugin_registry SET plugin_id = package WHERE plugin_id = ''"))

        await conn.run_sync(ensure_plugin_columns)

        # Additive compatibility for model availability controls and the platform default model.
        def ensure_model_connection_columns(sync_conn):
            from sqlalchemy import inspect, text

            inspector = inspect(sync_conn)
            if "model_connection" not in inspector.get_table_names():
                return
            existing = {column["name"] for column in inspector.get_columns("model_connection")}
            postgres = sync_conn.dialect.name == "postgresql"
            if "enabled" not in existing:
                default = "TRUE" if postgres else "1"
                sync_conn.execute(
                    text(
                        f"ALTER TABLE model_connection ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT {default}"
                    )
                )
            if "is_default" not in existing:
                default = "FALSE" if postgres else "0"
                sync_conn.execute(
                    text(
                        f"ALTER TABLE model_connection ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT {default}"
                    )
                )

        await conn.run_sync(ensure_model_connection_columns)

        # Additive compatibility for server-side workspace file persistence and retention.
        def ensure_session_file_columns(sync_conn):
            from sqlalchemy import inspect, text

            inspector = inspect(sync_conn)
            if "agent_session" not in inspector.get_table_names():
                return
            existing = {column["name"] for column in inspector.get_columns("agent_session")}
            for name in ("files_synced_at", "files_purged_at"):
                if name not in existing:
                    sync_conn.execute(text(f"ALTER TABLE agent_session ADD COLUMN {name} TIMESTAMP NULL"))
            # 会话关联代码（只读）：旧会话保持 NULL，即未关联
            if "code_projects" not in existing:
                sync_conn.execute(text("ALTER TABLE agent_session ADD COLUMN code_projects JSON NULL"))
            if "capability_selection" not in existing:
                sync_conn.execute(text("ALTER TABLE agent_session ADD COLUMN capability_selection JSON NULL"))

        await conn.run_sync(ensure_session_file_columns)

        # Existing published rows keep their live version when new revisions are saved.
        def ensure_scenario_published_version(sync_conn):
            from sqlalchemy import inspect, text

            inspector = inspect(sync_conn)
            if "agent_scenario" not in inspector.get_table_names():
                return
            existing = {column["name"] for column in inspector.get_columns("agent_scenario")}
            if "published_version" not in existing:
                sync_conn.execute(
                    text("ALTER TABLE agent_scenario ADD COLUMN published_version INTEGER NOT NULL DEFAULT 0")
                )
                sync_conn.execute(
                    text("UPDATE agent_scenario SET published_version = current_version WHERE status = 'published'")
                )

        await conn.run_sync(ensure_scenario_published_version)
    # 重启时关闭所有孤立审批，为未完成的运行保留明确的中断记录。
    import json
    from datetime import datetime, timezone
    from sqlalchemy import select, func
    from ..models.agent_session import AgentSession, SessionEventIndex
    from ..models.approval_ticket import ApprovalTicket
    from ..models.platform import PlatformSetting
    from ..models.agent_scenario import AgentScenario, AgentScenarioVersion

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

        # Additive compatibility for existing platform policies and official scenarios to include bash
        policy_row = await db.get(PlatformSetting, "policy")
        if policy_row and isinstance(policy_row.value, dict):
            allowed = policy_row.value.get("allowedTools")
            if isinstance(allowed, list) and "bash" not in allowed:
                policy_row.value = {**policy_row.value, "allowedTools": [*allowed, "bash"]}

        scenarios = (await db.scalars(select(AgentScenario).where(AgentScenario.space == "official"))).all()
        for sc in scenarios:
            if sc.name in ("通用助手", "代码与研发"):
                versions = (
                    await db.scalars(
                        select(AgentScenarioVersion).where(AgentScenarioVersion.scenario_id == sc.id)
                    )
                ).all()
                for ver in versions:
                    if isinstance(ver.bundle_json, dict):
                        bundle_data = json.loads(json.dumps(ver.bundle_json))
                        modified = False
                        payload = bundle_data.get("payload")
                        if isinstance(payload, dict):
                            caps = payload.get("capabilities")
                            if isinstance(caps, dict):
                                tools = caps.get("builtin_tool_names")
                                if isinstance(tools, list) and "bash" not in tools:
                                    tools.append("bash")
                                    modified = True
                        bundle_inner = bundle_data.get("bundle")
                        if isinstance(bundle_inner, dict):
                            meta = bundle_inner.get("meta")
                            if isinstance(meta, dict):
                                b_tools = meta.get("builtin_tools")
                                if isinstance(b_tools, list) and "bash" not in b_tools:
                                    b_tools.append("bash")
                                    modified = True
                        if modified:
                            ver.bundle_json = bundle_data
        await db.commit()


async def close_db() -> None:
    await _engine.dispose()
