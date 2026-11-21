"""Publication timestamps and compatibility with existing catalog data."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core import database
from src.api.models.registry import McpServer
from src.api.services.mcp_service import public_view


def test_mcp_public_view_exposes_utc_creation_time_without_credentials():
    row = McpServer(
        id=7,
        name="test",
        url="https://example.test",
        transport="streamable-http",
        enabled=False,
        status="unverified",
        last_error="",
        tools_json=[],
        server_info={},
        headers_encrypted="",
        created_at=datetime(2024, 1, 2, 3, 4, 5),
    )
    result = public_view(row)
    assert result["createdAt"] == datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc).isoformat()
    assert "headers_encrypted" not in result


@pytest.mark.asyncio
async def test_scenario_publication_date_migration_does_not_invent_history(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(database, "_engine", engine)
    monkeypatch.setattr(database, "SessionFactory", sessions)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(database.Base.metadata.create_all)
            await conn.execute(text("ALTER TABLE agent_scenario DROP COLUMN published_at"))
            await conn.execute(
                text("""
                INSERT INTO agent_scenario (id, tenant_id, space, owner_id, name, description, icon,
                    status, current_version, published_version, created_at, updated_at)
                VALUES (1, 'sandbox', 'personal', 'admin', 'old', '', 'sparkles', 'published', 1, 1,
                    '2020-01-01 00:00:00', '2025-01-01 00:00:00')
            """)
            )
        await database.init_db()
        await database.init_db()  # additive migration is safe to run more than once
        async with engine.connect() as conn:
            names = await conn.run_sync(
                lambda c: {col["name"] for col in inspect(c).get_columns("agent_scenario")}
            )
            assert "published_at" in names
            result = (
                await conn.execute(
                    text("SELECT published_version, published_at FROM agent_scenario WHERE id=1")
                )
            ).one()
            assert result == (1, None)
    finally:
        await engine.dispose()
