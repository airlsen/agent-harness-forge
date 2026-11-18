import pytest
from fastapi import HTTPException

from src.api.models.registry import PluginRegistry
from src.api.schemas.agent_scenario import ScenarioPayload
from src.api.services.plugin_service import approved_bindings, builtin_catalog
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
        version="0.1.0",
        display_name=package,
        artifact_hash="sha256-test",
        runtime="forge-bridge",
        tools_json=tools,
        audit_status="approved",
        enabled=True,
    )


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
    with pytest.raises(HTTPException, match="未登记的插件"):
        await approved_bindings(db, ["unknown-plugin"], {"unknown-plugin": ["anything"]})
