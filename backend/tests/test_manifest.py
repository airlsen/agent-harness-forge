"""会话清单：Schema 与模型同步、早期快照的投影、版本与字段校验。"""

import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from src.api.core.manifest import (
    MANIFEST_VERSION,
    SCHEMA_PATH,
    SessionManifest,
    manifest_from_bundle,
    render_schema,
)
from src.api.services.runner_client import RunnerClient
from src.api.services.scenario_assembler import Bundle


def test_committed_schema_matches_the_model():
    # 修改 core/manifest.py 后忘记执行 make contracts，这里会失败
    assert SCHEMA_PATH.read_text(encoding="utf-8") == render_schema()
    schema = json.loads(render_schema())
    assert schema["properties"]["version"]["const"] == MANIFEST_VERSION


def legacy_bundle():
    """早期场景版本保存的快照：带已废弃字段，meta 混有会话记录字段。"""
    return {
        "profile_patch": {
            "mode": "standard",
            "systemPrompt": {"identity": "助手", "domain": "客服", "safety": ["诚实"]},
        },
        "plugin_mounts": ["forge-runtime", "forge-plugin-bridge"],
        "skill_files": {},
        "mcp": [],
        "model_route": {"primary": "default", "fallbacks": []},
        "policy_ref": "abc",
        "input_schema": None,
        "meta": {
            "builtin_tools": ["current_time"],
            "plugin_tools": ["crm_find"],
            "pluginBindings": [
                {
                    "package": "forge-demo-crm",
                    "displayName": "CRM",
                    "version": "1.0.0",
                    "artifactHash": "sha256:1",
                    "runtime": "forge-bridge",
                    "tools": [{"name": "crm_find", "permission": "read"}],
                }
            ],
            "policy": {"allowedTools": ["current_time"], "approvalTimeoutSeconds": 60, "maxTurns": 30},
            "skills": [{"id": 1}],
            "scenarioName": "客服",
            "isTest": False,
            "inputPrice": 1.5,
        },
    }


def test_legacy_snapshot_projects_to_a_manifest_without_control_plane_facts():
    manifest = manifest_from_bundle(legacy_bundle())
    assert manifest["version"] == MANIFEST_VERSION
    assert manifest["systemPrompt"] == {
        "identity": "助手",
        "domain": "客服",
        "safety": ["诚实"],
        "workspace": [],
    }
    assert manifest["tools"] == {"builtin": ["current_time"], "plugin": ["crm_find"]}
    assert manifest["pluginBindings"][0]["execution"] == {}
    # 企业策略的其他字段原样保留；Runner 读取的字段齐全
    assert manifest["policy"]["maxTurns"] == 30 and manifest["policy"]["approvalTimeoutSeconds"] == 60
    flat = json.dumps(manifest, ensure_ascii=False)
    for fact in ("scenarioName", "isTest", "inputPrice", "skill_files", "model_route", "skills"):
        assert fact not in flat
    # 同一份快照也能装回控制面的 Bundle（废弃字段忽略）
    bundle = Bundle.from_dict(legacy_bundle())
    assert bundle.policy_ref == "abc" and not hasattr(bundle, "skill_files")


def test_manifest_rejects_unknown_versions_and_fields():
    manifest = manifest_from_bundle(legacy_bundle())
    with pytest.raises(ValidationError):
        SessionManifest.model_validate({**manifest, "version": 2})
    with pytest.raises(ValidationError):
        SessionManifest.model_validate({**manifest, "model_route": {}})


def test_incomplete_snapshot_is_a_clear_conflict_not_a_server_error():
    broken = {**legacy_bundle(), "profile_patch": {}}
    with pytest.raises(HTTPException) as error:
        RunnerClient()._session_body(broken, {"model": "m"}, [], None)
    assert error.value.status_code == 409
