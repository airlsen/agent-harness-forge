import json
from io import BytesIO
from zipfile import ZipFile

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.models.registry import PluginRegistry
from src.api.schemas.agent_scenario import ScenarioPayload
from src.api.services import plugin_service
from src.api.services.plugin_service import (
    _archive_manifest,
    approved_bindings,
    builtin_catalog,
    import_archive,
    review_release,
)
from src.api.services.scenario_assembler import ScenarioAssembler


class ScalarRows:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows


class PluginDb:
    def __init__(self, rows):
        self.rows = rows

    async def scalars(self, _query):
        return ScalarRows(self.rows)


def approved_row(package, tools):
    return PluginRegistry(
        package=package,
        plugin_id=package,
        version="0.1.0",
        display_name=package,
        artifact_hash="sha256-test",
        runtime="forge-bridge",
        tools_json=tools,
        audit_status="approved",
        enabled=True,
    )


def remote_manifest() -> dict:
    return {
        "id": "acme-contacts",
        "package": "@acme/contacts-worker",
        "displayName": "Acme Contacts",
        "description": "Existing remote company worker.",
        "version": "1.2.3",
        "runtime": "forge-remote-worker-v1",
        "execution": {
            "kind": "remote-worker",
            "endpoint": "https://plugins.acme.example/invoke",
            "networkDomains": ["plugins.acme.example"],
            "timeoutSeconds": 15,
        },
        "tools": [
            {
                "name": "acme_find_contact",
                "title": "Find contact",
                "description": "Read a contact from Acme.",
                "permission": "read",
                "risk": "read",
                "inputSchema": {"type": "object"},
                "outputSchema": {"type": "object"},
            }
        ],
    }


def remote_archive(manifest: dict, *, extra: dict[str, str] | None = None) -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("forge.plugin.json", json.dumps(manifest))
        for path, content in (extra or {}).items():
            archive.writestr(path, content)
    return buffer.getvalue()


def public_dns(_host, _port):
    import socket

    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]


def test_uploaded_remote_worker_archive_requires_fixed_safe_contract(monkeypatch):
    monkeypatch.setattr("socket.getaddrinfo", public_dns)
    manifest = remote_manifest()
    parsed = _archive_manifest("acme.zip", remote_archive(manifest))
    assert parsed["execution"]["endpoint"] == "https://plugins.acme.example/invoke"
    assert parsed["runtime"] == "forge-remote-worker-v1"


@pytest.mark.asyncio
async def test_uploaded_release_is_immutable_and_becomes_scene_bindable_after_review(monkeypatch, tmp_path):
    monkeypatch.setattr("socket.getaddrinfo", public_dns)
    monkeypatch.setattr(plugin_service, "ARTIFACT_ROOT", tmp_path / "artifacts")
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    archive = remote_archive(remote_manifest())
    async with sessions() as db:
        imported = await import_archive(db, "acme.zip", archive)
        assert imported["auditStatus"] == "pending"
        assert imported["enabled"] is False
        approved = await review_release(db, imported["id"], "approved", "Network domain checked")
        assert approved["enabled"] is True
        binding = await approved_bindings(
            db,
            ["acme-contacts"],
            {"acme-contacts": ["acme_find_contact"]},
        )
        assert binding[0]["execution"]["kind"] == "remote-worker"
        assert binding[0]["artifactHash"] == imported["artifactHash"]
    await engine.dispose()


def test_uploaded_archive_rejects_unsafe_paths_and_runner_native_runtime():
    native = {
        "id": "legacy-dsh",
        "package": "@acme/legacy-dsh",
        "displayName": "Legacy DSH",
        "description": "native",
        "version": "1.0.0",
        "runtime": "forge-bridge",
        "tools": [
            {
                "name": "legacy_lookup",
                "title": "Lookup",
                "description": "Lookup.",
                "permission": "read",
                "risk": "read",
                "inputSchema": {"type": "object"},
                "outputSchema": {"type": "object"},
            }
        ],
    }
    with pytest.raises(HTTPException, match="forge-bridge"):
        _archive_manifest("legacy.zip", remote_archive(native))
    with pytest.raises(HTTPException, match="不安全路径"):
        _archive_manifest("unsafe.zip", remote_archive({**native, "runtime": "dsh-native"}, extra={"../escape": "no"}))


def test_builtin_manifests_are_static_versioned_contracts():
    manifests = {item["id"]: item for item in builtin_catalog()}
    assert {"forge-text-tools", "forge-demo-crm"}.issubset(manifests)
    crm = manifests["forge-demo-crm"]
    assert crm["runtime"] == "forge-bridge"
    write = next(tool for tool in crm["tools"] if tool["name"] == "crm_add_customer_note")
    assert write["permission"] == "approval"
    assert write["risk"] == "write"
    assert len(crm["artifactHash"]) == 64


@pytest.mark.asyncio
async def test_scenario_assembler_freezes_only_selected_approved_plugin_tools():
    manifest = next(item for item in builtin_catalog() if item["id"] == "forge-demo-crm")
    db = PluginDb([approved_row("forge-demo-crm", manifest["tools"])])
    payload = ScenarioPayload.model_validate(
        {
            "name": "CRM 摘要",
            "prompt_template": "帮助整理 CRM 信息",
            "capabilities": {
                "plugin_names": ["forge-runtime", "forge-demo-crm"],
                "plugin_tools": {"forge-demo-crm": ["crm_find_customer"]},
            },
        }
    )
    bundle = await ScenarioAssembler().compile(
        db,
        payload,
        tenant_policy={"allowedTools": [], "allowedPluginTools": ["crm_find_customer"]},
        rendered_prompt=payload.prompt_template,
    )
    assert bundle.plugin_mounts == ["forge-runtime", "forge-plugin-bridge"]
    assert bundle.meta["plugin_tools"] == ["crm_find_customer"]
    binding = bundle.meta["pluginBindings"][0]
    assert binding["version"] == "0.1.0"
    assert binding["artifactHash"] == "sha256-test"


@pytest.mark.asyncio
async def test_plugin_binding_rejects_unapproved_tools_and_packages():
    manifest = next(item for item in builtin_catalog() if item["id"] == "forge-text-tools")
    db = PluginDb([approved_row("forge-text-tools", manifest["tools"])])
    with pytest.raises(HTTPException, match="未登记工具"):
        await approved_bindings(db, ["forge-text-tools"], {"forge-text-tools": ["not_real"]})
    with pytest.raises(HTTPException, match="尚未通过审核"):
        await approved_bindings(db, ["unknown-plugin"], {"unknown-plugin": ["anything"]})
