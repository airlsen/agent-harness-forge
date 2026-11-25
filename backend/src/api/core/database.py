"""SQLAlchemy async，开发 SQLite / 部署 PostgreSQL。"""

from collections.abc import AsyncIterator
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from .config import settings


class Base(DeclarativeBase):
    pass


# 取用前先检查连接是否有效；连接用满 30 分钟就换新，避免复用已被网络设备静默断开的旧连接。
_engine = create_async_engine(settings.database_url, pool_pre_ping=True, pool_recycle=1800)
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
            # Runner 执行日志续读位置：旧会话从 0 开始（Runner 侧的执行日志同样是新的）
            if "runner_event_seq" not in existing:
                sync_conn.execute(
                    text("ALTER TABLE agent_session ADD COLUMN runner_event_seq BIGINT NOT NULL DEFAULT 0")
                )

        await conn.run_sync(ensure_session_file_columns)

        # Skill 编辑对话支持选择模型：旧对话保持 NULL，即跟随平台默认模型
        def ensure_authoring_model_column(sync_conn):
            from sqlalchemy import inspect, text

            inspector = inspect(sync_conn)
            if "skill_authoring_session" not in inspector.get_table_names():
                return
            existing = {column["name"] for column in inspector.get_columns("skill_authoring_session")}
            if "model_connection_id" not in existing:
                sync_conn.execute(
                    text("ALTER TABLE skill_authoring_session ADD COLUMN model_connection_id INTEGER NULL")
                )

        await conn.run_sync(ensure_authoring_model_column)

        # 会话内提问复用审批工单表：旧库的工单都是工具确认（kind 默认值即正确）
        def ensure_approval_kind_column(sync_conn):
            from sqlalchemy import inspect, text

            inspector = inspect(sync_conn)
            if "approval_ticket" not in inspector.get_table_names():
                return
            existing = {column["name"] for column in inspector.get_columns("approval_ticket")}
            if "kind" not in existing:
                sync_conn.execute(
                    text("ALTER TABLE approval_ticket ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'tool'")
                )

        await conn.run_sync(ensure_approval_kind_column)

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
                    text(
                        "UPDATE agent_scenario SET published_version = current_version WHERE status = 'published'"
                    )
                )
            # Do not infer a release time from a draft or version creation timestamp.
            if "published_at" not in existing:
                sync_conn.execute(text("ALTER TABLE agent_scenario ADD COLUMN published_at TIMESTAMP NULL"))

        await conn.run_sync(ensure_scenario_published_version)

        # 空间：已有的场景、Skill、MCP、插件、会话全部归入公共空间（id=1）
        def ensure_space_columns(sync_conn):
            from sqlalchemy import inspect, text

            inspector = inspect(sync_conn)
            tables = set(inspector.get_table_names())
            for table in ("agent_scenario", "skill", "mcp_server", "plugin_registry", "agent_session"):
                if table not in tables:
                    continue
                existing = {column["name"] for column in inspector.get_columns(table)}
                if "space_id" not in existing:
                    sync_conn.execute(
                        text(f"ALTER TABLE {table} ADD COLUMN space_id INTEGER NOT NULL DEFAULT 1")
                    )
                    sync_conn.execute(
                        text(f"CREATE INDEX IF NOT EXISTS ix_{table}_space_id ON {table} (space_id)")
                    )

        await conn.run_sync(ensure_space_columns)

        def ensure_authoring_owner(sync_conn):
            from sqlalchemy import inspect, text

            inspector = inspect(sync_conn)
            if "skill_authoring_session" not in inspector.get_table_names():
                return
            existing = {column["name"] for column in inspector.get_columns("skill_authoring_session")}
            if "owner_id" not in existing:
                sync_conn.execute(
                    text(
                        "ALTER TABLE skill_authoring_session ADD COLUMN owner_id VARCHAR(64) NOT NULL DEFAULT 'admin'"
                    )
                )
            sync_conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_skill_authoring_session_owner_id ON skill_authoring_session (owner_id)"
                )
            )

        await conn.run_sync(ensure_authoring_owner)
    import json
    from sqlalchemy import select
    from ..models.platform import PlatformSetting
    from ..models.agent_scenario import AgentScenario, AgentScenarioVersion

    from ..services.space_service import ensure_public_space

    async with SessionFactory() as db:
        await ensure_public_space(db)
        # 运行中会话的对账（接回 / 补录 / 标记中断）需要询问 Runner，由 session_service.reconcile 在启动时完成

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
        await migrate_tool_names(db)
        await db.commit()


TOOL_RENAME_MARKER = "tool-rename-v2"


def _canonical_list(value, rename) -> tuple[list, bool]:
    """把列表里的旧工具名换新（空串表示去掉），去重保持顺序；返回新列表与是否有变化。"""
    if not isinstance(value, list):
        return value, False
    out = list(dict.fromkeys(rename.get(name, name) if isinstance(name, str) else name for name in value))
    out = [name for name in out if name]
    return out, out != value


async def migrate_tool_names(db) -> None:
    """一次性迁移（平台契约 v2）：执行策略、空间工具开关、场景各版本的能力快照里的旧工具名换成新名。

    workspace_list / workspace_read → read，workspace_write → write，workspace_present → present，
    current_time 去掉（当前时间已作为上下文自动提供）。已有会话的历史消息不改，界面按旧名兼容展示。
    完成后写入标记，之后启动不再执行；Runner 与控制面读取旧数据时也会兜底换名。
    """
    import json

    from sqlalchemy import select

    from ..models.agent_scenario import AgentScenarioVersion
    from ..models.platform import PlatformSetting
    from ..models.space import Space
    from ..services.scenario_assembler import Bundle
    from .contracts import renamed_tools

    if await db.get(PlatformSetting, TOOL_RENAME_MARKER):
        return
    rename = renamed_tools()
    counts = {"policy": 0, "spaces": 0, "versions": 0}
    policy_row = await db.get(PlatformSetting, "policy")
    if policy_row and isinstance(policy_row.value, dict):
        allowed, changed = _canonical_list(policy_row.value.get("allowedTools"), rename)
        if changed:
            policy_row.value = {**policy_row.value, "allowedTools": allowed}
            counts["policy"] = 1
    for space in (await db.scalars(select(Space))).all():
        tools, changed = _canonical_list(space.disabled_tools, rename)
        if changed:
            space.disabled_tools = tools
            counts["spaces"] += 1
    for version in (await db.scalars(select(AgentScenarioVersion))).all():
        if not isinstance(version.bundle_json, dict):
            continue
        data = json.loads(json.dumps(version.bundle_json))
        modified = False
        caps = (
            (data.get("payload") or {}).get("capabilities") if isinstance(data.get("payload"), dict) else None
        )
        if isinstance(caps, dict):
            caps["builtin_tool_names"], changed = _canonical_list(caps.get("builtin_tool_names"), rename)
            modified |= changed
        bundle = data.get("bundle")
        meta = bundle.get("meta") if isinstance(bundle, dict) else None
        if isinstance(meta, dict):
            meta["builtin_tools"], changed = _canonical_list(meta.get("builtin_tools"), rename)
            modified |= changed
            policy = meta.get("policy")
            if isinstance(policy, dict):
                policy["allowedTools"], changed = _canonical_list(policy.get("allowedTools"), rename)
                modified |= changed
        if not modified:
            continue
        version.bundle_json = data
        counts["versions"] += 1
        if isinstance(bundle, dict):
            try:
                version.bundle_hash = Bundle.from_dict(bundle).bundle_hash
            except TypeError:
                pass  # 早期快照字段不全：仅更新内容，摘要保持原值
    db.add(PlatformSetting(key=TOOL_RENAME_MARKER, value=counts))


async def close_db() -> None:
    await _engine.dispose()
