"""受管插件目录：只登记经审查的不可变制品，不执行任意第三方包。"""

import hashlib
import json
from functools import lru_cache

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import ROOT
from ..models.registry import PluginRegistry
from .settings_service import TOOL_NAMES

CATALOG_ROOT = ROOT / "plugins"


@lru_cache(maxsize=1)
def builtin_catalog() -> list[dict]:
    manifests = sorted(CATALOG_ROOT.glob("*/forge.plugin.json"))
    values = []
    seen_packages, seen_tools = set(), set()
    for path in manifests:
        try:
            raw = path.read_bytes()
            value = json.loads(raw)
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"插件清单不可读取：{path.name}") from error
        required = {"id", "package", "displayName", "description", "version", "runtime", "tools"}
        if not required.issubset(value) or not isinstance(value["tools"], list):
            raise RuntimeError(f"插件清单缺少必要字段：{path.name}")
        if value["id"] in seen_packages:
            raise RuntimeError(f"插件标识重复：{path.name}")
        tool_names = [str(tool.get("name", "")) for tool in value["tools"]]
        if not tool_names or any(not name or not name.replace("_", "").replace("-", "").isalnum() for name in tool_names):
            raise RuntimeError(f"插件工具标识无效：{path.name}")
        if len(set(tool_names)) != len(tool_names) or set(tool_names) & (seen_tools | TOOL_NAMES):
            raise RuntimeError(f"插件工具标识重复或与平台保留工具冲突：{path.name}")
        for tool in value["tools"]:
            if not {"name", "title", "description", "permission", "risk", "inputSchema", "outputSchema"}.issubset(tool):
                raise RuntimeError(f"插件工具契约不完整：{path.name}")
            if tool["permission"] not in {"read", "approval"} or tool["risk"] not in {"read", "write", "external_side_effect"}:
                raise RuntimeError(f"插件工具风险声明无效：{path.name}")
            if (tool["permission"] == "read") != (tool["risk"] == "read"):
                raise RuntimeError(f"插件工具审批风险声明不一致：{path.name}")
            if not isinstance(tool["inputSchema"], dict) or not isinstance(tool["outputSchema"], dict):
                raise TypeError(f"插件工具 Schema 无效：{path.name}")
        seen_packages.add(value["id"])
        seen_tools.update(tool_names)
        values.append({**value, "artifactHash": hashlib.sha256(raw).hexdigest()})
    return values


def public_view(row: PluginRegistry) -> dict:
    return {
        "id": row.id,
        "package": row.package,
        "displayName": row.display_name or row.package,
        "description": row.description,
        "version": row.version,
        "runtime": row.runtime,
        "source": row.source_ref,
        "artifactHash": row.artifact_hash,
        "extensionPoints": row.extension_points or [],
        "permissions": row.permissions or [],
        "tools": row.tools_json or [],
        "auditStatus": row.audit_status,
        "enabled": row.enabled,
    }


async def seed_plugins(db: AsyncSession) -> None:
    """内置制品只在首次登记；后续状态由管理员审核与启停控制。"""
    changed = False
    for manifest in builtin_catalog():
        row = await db.scalar(select(PluginRegistry).where(PluginRegistry.package == manifest["id"]))
        if row:
            continue
        db.add(
            PluginRegistry(
                package=manifest["id"],
                version=manifest["version"],
                display_name=manifest["displayName"],
                description=manifest["description"],
                runtime=manifest["runtime"],
                source_ref=manifest.get("source", "builtin"),
                artifact_hash=manifest["artifactHash"],
                tools_json=manifest["tools"],
                extension_points=manifest.get("extensionPoints", []),
                permissions=manifest.get("permissions", []),
                signature=manifest["artifactHash"],
                audit_status="approved",
                enabled=True,
            )
        )
        changed = True
    if changed:
        await db.commit()


async def list_plugins(db: AsyncSession) -> list[dict]:
    rows = (await db.scalars(select(PluginRegistry).order_by(PluginRegistry.display_name, PluginRegistry.package))).all()
    return [public_view(row) for row in rows]


async def approved_bindings(db: AsyncSession, packages: list[str], tool_map: dict[str, list[str]]) -> list[dict]:
    selected = [item for item in dict.fromkeys(packages) if item != "forge-runtime"]
    if not selected:
        if tool_map:
            raise HTTPException(422, "未选择插件时不能指定插件工具")
        return []
    if set(tool_map) - set(selected):
        raise HTTPException(422, "插件工具与已选择插件不一致")
    rows = (await db.scalars(select(PluginRegistry).where(PluginRegistry.package.in_(selected)))).all()
    by_package = {row.package: row for row in rows}
    missing = set(selected) - set(by_package)
    if missing:
        raise HTTPException(422, "包含未登记的插件：" + "、".join(sorted(missing)))
    bindings = []
    bound_tools = set()
    for package in selected:
        row = by_package[package]
        if row.audit_status != "approved" or not row.enabled:
            raise HTTPException(422, f"插件“{row.display_name or package}”尚未通过审核或已停用")
        if row.runtime != "forge-bridge":
            raise HTTPException(422, f"插件“{row.display_name or package}”不支持当前受管运行时")
        available = {str(tool.get("name")): tool for tool in (row.tools_json or [])}
        names = [name for name in dict.fromkeys(tool_map.get(package, [])) if name]
        if not names:
            raise HTTPException(422, f"请至少选择插件“{row.display_name or package}”的一项工具")
        unknown = set(names) - set(available)
        if unknown:
            raise HTTPException(422, f"插件“{row.display_name or package}”包含未登记工具：" + "、".join(sorted(unknown)))
        if set(names) & TOOL_NAMES or set(names) & bound_tools:
            raise HTTPException(422, "插件工具与平台或其他插件工具冲突")
        bound_tools.update(names)
        bindings.append(
            {
                "package": row.package,
                "displayName": row.display_name or row.package,
                "version": row.version,
                "artifactHash": row.artifact_hash,
                "runtime": row.runtime,
                "tools": [available[name] for name in names],
            }
        )
    return bindings


async def ensure_bindings_available(db: AsyncSession, bindings: list[dict]) -> None:
    """停用或撤销插件后阻止创建新会话；历史 Bundle 仍保留用于审计。"""
    packages = [str(item.get("package", "")) for item in bindings if item.get("package")]
    if not packages:
        return
    rows = (await db.scalars(select(PluginRegistry).where(PluginRegistry.package.in_(packages)))).all()
    current = {row.package: row for row in rows}
    for binding in bindings:
        package = str(binding.get("package", ""))
        row = current.get(package)
        if not row or row.audit_status != "approved" or not row.enabled:
            raise HTTPException(409, f"会话依赖的插件“{package}”已停用或撤销，请选择其他场景")
        if row.version != binding.get("version") or row.artifact_hash != binding.get("artifactHash"):
            raise HTTPException(409, f"会话依赖的插件“{package}”版本已变更，请重新发布场景")
