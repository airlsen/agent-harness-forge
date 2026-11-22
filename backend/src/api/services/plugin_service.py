"""受管插件目录、不可变上传制品与场景版本绑定。

控制面可以接收已有 Forge Worker 包，但绝不在上传阶段安装 npm 依赖或执行包内 Node 代码。
原生 DSH 包只作为高风险系统插件候选登记，不能由本服务直接发布到 Runner。
"""

import hashlib
import ipaddress
import json
import re
import socket
import zipfile
from functools import lru_cache
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import space_service
from ..core.config import ROOT, settings
from ..models.registry import PluginRegistry
from ..models.agent_scenario import AgentScenario, AgentScenarioVersion
from ..models.agent_session import SessionEventIndex
from .settings_service import TOOL_NAMES

CATALOG_ROOT = ROOT / "plugins"
ARTIFACT_ROOT = settings.data_dir / "plugin-artifacts"
MAX_ARCHIVE_BYTES = 5 * 1024 * 1024
MAX_ARCHIVE_FILES = 64
MAX_UNPACKED_BYTES = 12 * 1024 * 1024
PLUGIN_ID = re.compile(r"^[a-z][a-z0-9-]{2,95}$")
VERSION = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
AUTH_REF = re.compile(r"^FORGE_PLUGIN_AUTH_[A-Z0-9_]{1,80}$")
SUPPORTED_RUNTIMES = {"forge-bridge", "forge-remote-worker-v1", "dsh-native"}


def _row_plugin_id(row: PluginRegistry) -> str:
    return row.plugin_id or row.package


def _version_key(value: str) -> tuple:
    """足够覆盖目录版本排序；制品版本仍以精确文本和哈希固定。"""
    main, _, prerelease = value.partition("-")
    main, _, build = main.partition("+")
    numeric = tuple(int(part) if part.isdigit() else 0 for part in main.split("."))
    # Build metadata does not change precedence; stable releases outrank prereleases.
    return (*numeric, 1 if not prerelease else 0, prerelease, build)


def _validate_remote_execution(value: object) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(422, "远程 Worker 插件必须声明 execution")
    if value.get("kind") != "remote-worker":
        raise HTTPException(422, "仅支持 remote-worker 执行契约")
    endpoint = value.get("endpoint")
    domains = value.get("networkDomains")
    if not isinstance(endpoint, str) or not isinstance(domains, list) or not domains:
        raise HTTPException(422, "远程 Worker 必须声明 HTTPS endpoint 与 networkDomains")
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise HTTPException(422, "远程 Worker endpoint 必须是无凭据、无查询参数的 HTTPS 地址")
    host = parsed.hostname.lower().rstrip(".")
    normalized = [str(domain).lower().rstrip(".") for domain in domains]
    if any(not domain or "/" in domain or ":" in domain for domain in normalized):
        raise HTTPException(422, "networkDomains 仅允许主机名")
    if host not in normalized:
        raise HTTPException(422, "远程 Worker endpoint 必须位于 networkDomains 白名单")
    if host in {"localhost", "localhost.localdomain"}:
        raise HTTPException(422, "远程 Worker 不能连接本机地址")
    try:
        addresses = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            addresses = {
                ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(host, parsed.port or 443)
            }
        except OSError as error:
            raise HTTPException(422, "无法解析远程 Worker 域名") from error
    if not addresses or any(not address.is_global for address in addresses):
        raise HTTPException(422, "远程 Worker 必须解析到公网地址，不能连接内网地址")
    timeout = value.get("timeoutSeconds", 20)
    if not isinstance(timeout, int) or not 3 <= timeout <= 60:
        raise HTTPException(422, "远程 Worker 超时必须在 3 到 60 秒之间")
    auth_ref = value.get("authRef", "")
    if not isinstance(auth_ref, str) or (auth_ref and not AUTH_REF.fullmatch(auth_ref)):
        raise HTTPException(422, "认证引用必须是 FORGE_PLUGIN_AUTH_ 开头的环境变量名")
    return {
        "kind": "remote-worker",
        "endpoint": parsed.geturl(),
        "networkDomains": sorted(set(normalized)),
        "timeoutSeconds": timeout,
        "authRef": auth_ref,
    }


def validate_manifest(value: object, *, uploaded: bool = False) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(422, "forge.plugin.json 必须是 JSON 对象")
    required = {"id", "package", "displayName", "description", "version", "runtime", "tools"}
    if not required.issubset(value) or not isinstance(value["tools"], list):
        raise HTTPException(422, "插件清单缺少必要字段")
    plugin_id = value["id"]
    version = value["version"]
    runtime = value["runtime"]
    if not isinstance(plugin_id, str) or not PLUGIN_ID.fullmatch(plugin_id):
        raise HTTPException(422, "插件 ID 仅允许小写字母、数字和连字符")
    if uploaded and plugin_id.startswith("forge-"):
        raise HTTPException(422, "forge- 前缀为平台保留命名空间，请使用企业插件 ID")
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise HTTPException(422, "插件版本必须使用固定的语义化版本，例如 1.2.3")
    if runtime not in SUPPORTED_RUNTIMES:
        raise HTTPException(422, "不支持的插件运行时")
    if (
        not isinstance(value["package"], str)
        or not value["package"].strip()
        or len(value["package"]) > 128
        or not isinstance(value["displayName"], str)
        or not value["displayName"].strip()
        or len(value["displayName"]) > 128
        or not isinstance(value["description"], str)
        or len(value["description"]) > 512
    ):
        raise HTTPException(422, "插件名称、包标识或说明无效")
    if uploaded and runtime == "forge-bridge":
        raise HTTPException(
            422, "上传包不能声明 forge-bridge；请使用 forge-remote-worker-v1 或作为 DSH 系统插件候选导入"
        )
    tools = value["tools"]
    if not tools or len(tools) > 32:
        raise HTTPException(422, "一个插件版本最多声明 32 项工具")
    if len(json.dumps(tools, ensure_ascii=False).encode()) > 128 * 1024:
        raise HTTPException(422, "插件工具契约不能超过 128 KB")
    tool_names = [str(tool.get("name", "")) for tool in tools if isinstance(tool, dict)]
    if (
        len(tool_names) != len(tools)
        or not tool_names
        or any(not name or not name.replace("_", "").replace("-", "").isalnum() for name in tool_names)
    ):
        raise HTTPException(422, "插件工具标识无效")
    if len(set(tool_names)) != len(tool_names) or set(tool_names) & TOOL_NAMES:
        raise HTTPException(422, "插件工具标识重复或与平台保留工具冲突")
    for tool in tools:
        required_tool = {"name", "title", "description", "permission", "risk", "inputSchema", "outputSchema"}
        if not required_tool.issubset(tool):
            raise HTTPException(422, "插件工具契约不完整")
        if tool["permission"] not in {"read", "approval"} or tool["risk"] not in {
            "read",
            "write",
            "external_side_effect",
        }:
            raise HTTPException(422, "插件工具风险声明无效")
        if (tool["permission"] == "read") != (tool["risk"] == "read"):
            raise HTTPException(422, "插件工具审批与风险声明不一致")
        if not isinstance(tool["inputSchema"], dict) or not isinstance(tool["outputSchema"], dict):
            raise HTTPException(422, "插件工具 Schema 无效")
    if (
        uploaded
        and runtime == "forge-remote-worker-v1"
        and not any(tool["permission"] == "read" for tool in tools)
    ):
        raise HTTPException(422, "远程 Worker 至少需要一个只读工具用于发布前试运行")
    extension_points = value.get("extensionPoints", [])
    permissions = value.get("permissions", [])
    if (
        not isinstance(extension_points, list)
        or not isinstance(permissions, list)
        or len(extension_points) > 20
        or len(permissions) > 50
        or any(not isinstance(item, str) or len(item) > 128 for item in [*extension_points, *permissions])
    ):
        raise HTTPException(422, "插件扩展点或权限声明无效")
    execution = {}
    if runtime == "forge-remote-worker-v1":
        execution = _validate_remote_execution(value.get("execution"))
    return {
        **value,
        "id": plugin_id,
        "version": version,
        "runtime": runtime,
        "tools": tools,
        "execution": execution,
        "extensionPoints": extension_points,
        "permissions": permissions,
    }


@lru_cache(maxsize=1)
def builtin_catalog() -> list[dict]:
    manifests = sorted(CATALOG_ROOT.glob("*/forge.plugin.json"))
    values, seen_packages, seen_tools = [], set(), set()
    for path in manifests:
        try:
            raw = path.read_bytes()
            manifest = validate_manifest(json.loads(raw))
        except (OSError, json.JSONDecodeError, HTTPException) as error:
            raise RuntimeError(f"插件清单不可读取或无效：{path.name}") from error
        if manifest["id"] in seen_packages or {tool["name"] for tool in manifest["tools"]} & seen_tools:
            raise RuntimeError(f"插件或工具标识重复：{path.name}")
        seen_packages.add(manifest["id"])
        seen_tools.update(tool["name"] for tool in manifest["tools"])
        values.append({**manifest, "artifactHash": hashlib.sha256(raw).hexdigest()})
    return values


def _release_key(plugin_id: str, version: str, artifact_hash: str) -> str:
    return f"{plugin_id}@{version}@{artifact_hash[:12]}"


def public_view(row: PluginRegistry) -> dict:
    return {
        "id": row.id,
        "package": _row_plugin_id(row),
        # 所属空间（公共空间 = 1）；同一插件的所有版本一致
        "spaceId": row.space_id or 1,
        "releaseKey": row.package,
        "displayName": row.display_name or _row_plugin_id(row),
        "description": row.description,
        "version": row.version,
        "runtime": row.runtime,
        "source": row.source_ref,
        "artifactHash": row.artifact_hash,
        "artifactName": row.artifact_name,
        "artifactBytes": row.artifact_bytes,
        "extensionPoints": row.extension_points or [],
        "permissions": row.permissions or [],
        "tools": row.tools_json or [],
        "auditStatus": row.audit_status,
        "scanStatus": row.scan_status,
        "reviewNote": row.review_note,
        "execution": row.execution_json or {},
        "enabled": row.enabled,
        "isDefault": row.is_default,
        "lastTestedAt": row.last_tested_at.isoformat() if row.last_tested_at else None,
        "lastTestError": row.last_test_error,
    }


def _archive_manifest(filename: str, archive: bytes) -> dict:
    if not filename.lower().endswith(".zip"):
        raise HTTPException(422, "当前仅接收 .zip Forge 插件包")
    if not archive or len(archive) > MAX_ARCHIVE_BYTES:
        raise HTTPException(413, f"插件包必须在 1 到 {MAX_ARCHIVE_BYTES // 1024 // 1024} MB 之间")
    try:
        with zipfile.ZipFile(BytesIO(archive)) as bundle:
            infos = bundle.infolist()
            if not infos or len(infos) > MAX_ARCHIVE_FILES:
                raise HTTPException(422, "插件包文件数量无效")
            total = 0
            manifest_info = None
            for info in infos:
                path = Path(info.filename)
                if info.is_dir():
                    continue
                if path.is_absolute() or ".." in path.parts or "\x00" in info.filename:
                    raise HTTPException(422, "插件包包含不安全路径")
                # Unix symlink mode: archive must contain regular files only.
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise HTTPException(422, "插件包不能包含符号链接")
                total += info.file_size
                if total > MAX_UNPACKED_BYTES:
                    raise HTTPException(422, "插件包解压后超过 12 MB 限制")
                if info.filename == "forge.plugin.json":
                    manifest_info = info
            if not manifest_info:
                raise HTTPException(422, "插件包根目录必须包含 forge.plugin.json")
            if manifest_info.file_size > 256 * 1024:
                raise HTTPException(422, "forge.plugin.json 不能超过 256 KB")
            return validate_manifest(json.loads(bundle.read(manifest_info)), uploaded=True)
    except zipfile.BadZipFile as error:
        raise HTTPException(422, "插件包不是有效 ZIP 文件") from error
    except UnicodeDecodeError as error:
        raise HTTPException(422, "forge.plugin.json 必须使用 UTF-8 编码") from error
    except json.JSONDecodeError as error:
        raise HTTPException(422, "forge.plugin.json 不是有效 JSON") from error


async def import_archive(
    db: AsyncSession, filename: str, archive: bytes, space_id: int | None = None
) -> dict:
    manifest = _archive_manifest(filename, archive)
    artifact_hash = hashlib.sha256(archive).hexdigest()
    plugin_id, version = manifest["id"], manifest["version"]
    # 插件属于一个空间，同一插件的所有版本在同一空间；插件标识全局唯一
    sibling = await db.scalar(select(PluginRegistry).where(PluginRegistry.plugin_id == plugin_id).limit(1))
    if sibling is not None and not space_service.is_visible(sibling.space_id, space_id):
        spaces = await space_service.space_map(db)
        name = spaces.get(sibling.space_id, {}).get("name", "其他")
        raise HTTPException(409, f"插件标识“{plugin_id}”已被「{name}」空间使用，请在该空间上传新版本")
    plugin_space = sibling.space_id if sibling is not None else space_service.target_space(space_id)
    existing = await db.scalar(
        select(PluginRegistry).where(
            PluginRegistry.plugin_id == plugin_id,
            PluginRegistry.version == version,
        )
    )
    if existing:
        if existing.artifact_hash == artifact_hash:
            return public_view(existing)
        raise HTTPException(409, f"插件“{plugin_id}”的版本 {version} 已存在，版本号不可覆盖")
    ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    artifact_path = ARTIFACT_ROOT / f"{artifact_hash}.zip"
    if not artifact_path.exists():
        artifact_path.write_bytes(archive)
        artifact_path.chmod(0o600)
    release = PluginRegistry(
        package=_release_key(plugin_id, version, artifact_hash),
        plugin_id=plugin_id,
        space_id=plugin_space,
        version=version,
        display_name=str(manifest["displayName"])[:128],
        description=str(manifest["description"])[:512],
        runtime=manifest["runtime"],
        source_ref="uploaded:" + Path(filename).name[:220],
        artifact_hash=artifact_hash,
        artifact_name=Path(filename).name[:256],
        artifact_bytes=len(archive),
        manifest_json=manifest,
        execution_json=manifest.get("execution", {}),
        tools_json=manifest["tools"],
        extension_points=manifest.get("extensionPoints", []),
        permissions=manifest.get("permissions", []),
        signature="",
        audit_status="pending",
        scan_status="manifest_valid",
        enabled=False,
    )
    db.add(release)
    await db.commit()
    await db.refresh(release)
    return public_view(release)


async def review_release(db: AsyncSession, release_id: int, action: str, note: str = "") -> dict:
    row = await db.get(PluginRegistry, release_id)
    if not row:
        raise HTTPException(404, "插件版本不存在")
    if row.source_ref.startswith("builtin"):
        raise HTTPException(403, "内置插件版本不能通过上传审核流程修改")
    if action not in {"approved", "rejected"}:
        raise HTTPException(422, "审核动作无效")
    if action == "approved" and row.runtime != "forge-remote-worker-v1":
        raise HTTPException(422, "DSH 原生插件只能由平台团队通过专用 Runner 镜像审核发布")
    if action == "approved" and row.last_tested_at is None:
        raise HTTPException(409, "请先试运行一个只读工具，再批准插件版本")
    row.audit_status = action
    row.enabled = action == "approved"
    if action == "approved":
        existing_default = await db.scalar(
            select(PluginRegistry.id).where(
                PluginRegistry.plugin_id == _row_plugin_id(row), PluginRegistry.is_default.is_(True)
            )
        )
        if existing_default is None:
            row.is_default = True
    else:
        row.is_default = False
    row.review_note = note.strip()[:1024]
    await db.commit()
    await db.refresh(row)
    return public_view(row)


async def set_release_enabled(db: AsyncSession, release_id: int, enabled: bool) -> dict:
    row = await db.get(PluginRegistry, release_id)
    if not row:
        raise HTTPException(404, "插件版本不存在")
    if enabled and row.audit_status != "approved":
        raise HTTPException(409, "只有已批准的插件版本可以启用")
    row.enabled = enabled
    if not enabled:
        row.is_default = False
    await db.commit()
    await db.refresh(row)
    return public_view(row)


async def set_default_release(db: AsyncSession, release_id: int) -> dict:
    row = await db.get(PluginRegistry, release_id)
    if not row:
        raise HTTPException(404, "插件版本不存在")
    if row.audit_status != "approved" or not row.enabled or row.runtime == "dsh-native":
        raise HTTPException(409, "只能将已批准且启用的业务插件设为默认版本")
    releases = (
        await db.scalars(select(PluginRegistry).where(PluginRegistry.plugin_id == _row_plugin_id(row)))
    ).all()
    for release in releases:
        release.is_default = release.id == row.id
    await db.commit()
    await db.refresh(row)
    return public_view(row)


async def record_test(db: AsyncSession, row: PluginRegistry, error: str = "") -> dict:
    row.last_tested_at = None if error else datetime.now(timezone.utc).replace(tzinfo=None)
    row.last_test_error = error[:512]
    await db.commit()
    await db.refresh(row)
    return public_view(row)


async def seed_plugins(db: AsyncSession) -> None:
    """内置制品仅在首次登记；上传制品始终是独立、不可变 release。"""
    changed = False
    for manifest in builtin_catalog():
        row = await db.scalar(
            select(PluginRegistry).where(
                or_(PluginRegistry.plugin_id == manifest["id"], PluginRegistry.package == manifest["id"])
            )
        )
        if row:
            if not row.plugin_id:
                row.plugin_id = manifest["id"]
                changed = True
            if not row.source_ref.startswith("builtin:"):
                row.source_ref = "builtin:" + str(manifest.get("source", "platform"))
                changed = True
            continue
        db.add(
            PluginRegistry(
                package=manifest["id"],
                plugin_id=manifest["id"],
                version=manifest["version"],
                display_name=manifest["displayName"],
                description=manifest["description"],
                runtime=manifest["runtime"],
                source_ref="builtin:" + str(manifest.get("source", "platform")),
                artifact_hash=manifest["artifactHash"],
                manifest_json=manifest,
                execution_json=manifest.get("execution", {}),
                tools_json=manifest["tools"],
                extension_points=manifest.get("extensionPoints", []),
                permissions=manifest.get("permissions", []),
                signature=manifest["artifactHash"],
                audit_status="approved",
                scan_status="builtin",
                enabled=True,
                is_default=True,
            )
        )
        changed = True
    if changed:
        await db.commit()


def _current_available(rows: list[PluginRegistry]) -> list[PluginRegistry]:
    grouped: dict[str, list[PluginRegistry]] = {}
    for row in rows:
        grouped.setdefault(_row_plugin_id(row), []).append(row)
    selected = []
    for releases in grouped.values():
        ready = [row for row in releases if row.audit_status == "approved" and row.enabled and row.is_default]
        if ready:
            selected.append(ready[0])
    return sorted(selected, key=lambda row: (row.display_name or _row_plugin_id(row), _row_plugin_id(row)))


async def list_plugins(db: AsyncSession, space_id: int | None = None) -> tuple[list[dict], list[dict]]:
    """插件列表；传入当前空间时只列本空间和公共空间的插件。"""
    rows = (
        await db.scalars(
            select(PluginRegistry)
            .where(space_service.visible_filter(PluginRegistry.space_id, space_id))
            .order_by(PluginRegistry.id.desc())
        )
    ).all()
    available = _current_available(rows)
    return [public_view(row) for row in available], [
        public_view(row) for row in rows if row.source_ref.startswith("uploaded:")
    ]


async def plugin_usage_counts(db: AsyncSession) -> dict[str, int]:
    scenarios = (await db.scalars(select(AgentScenario))).all()
    if not scenarios:
        return {}
    versions = (
        await db.scalars(
            select(AgentScenarioVersion).where(
                AgentScenarioVersion.scenario_id.in_([scenario.id for scenario in scenarios])
            )
        )
    ).all()
    relevant = {
        scenario.id: {scenario.current_version, scenario.published_version} - {0}
        for scenario in scenarios
        if scenario.status != "deleted"
    }
    counts: dict[str, int] = {}
    used: dict[int, set[str]] = {}
    for version in versions:
        if version.version not in relevant.get(version.scenario_id, set()):
            continue
        bindings = version.bundle_json.get("bundle", {}).get("meta", {}).get("pluginBindings", [])
        for plugin_id in {binding.get("package") for binding in bindings if binding.get("package")}:
            used.setdefault(version.scenario_id, set()).add(plugin_id)
    for plugins in used.values():
        for plugin_id in plugins:
            counts[plugin_id] = counts.get(plugin_id, 0) + 1
    return counts


async def plugin_detail(db: AsyncSession, plugin_id: str) -> dict:
    releases = (await db.scalars(select(PluginRegistry))).all()
    versions = [row for row in releases if _row_plugin_id(row) == plugin_id]
    if not versions:
        raise HTTPException(404, "插件不存在")
    scenarios = (await db.scalars(select(AgentScenario))).all()
    linked = []
    for scenario in scenarios:
        if scenario.status == "deleted":
            continue
        numbers = {scenario.current_version, scenario.published_version} - {0}
        active_versions = (
            await db.scalars(
                select(AgentScenarioVersion).where(
                    AgentScenarioVersion.scenario_id == scenario.id,
                    AgentScenarioVersion.version.in_(numbers),
                )
            )
        ).all()
        # One scenario reference; when both revisions use the plugin, show the live release.
        active_versions.sort(key=lambda row: row.version != scenario.published_version)
        bindings = [
            binding
            for version in active_versions
            for binding in version.bundle_json.get("bundle", {}).get("meta", {}).get("pluginBindings", [])
            if binding.get("package") == plugin_id
        ]
        if bindings:
            binding = bindings[0]
            linked.append(
                {
                    "id": scenario.id,
                    "name": scenario.name,
                    "status": scenario.status,
                    "version": binding.get("version"),
                    "artifactHash": binding.get("artifactHash"),
                }
            )
    events = (
        await db.scalars(
            select(SessionEventIndex)
            .where(SessionEventIndex.kind == "plugin_call")
            .order_by(SessionEventIndex.id.desc())
            .limit(200)
        )
    ).all()
    calls = [
        {
            "sessionId": event.session_id,
            "tool": event.attrs.get("tool"),
            "version": event.attrs.get("version"),
            "outcome": event.attrs.get("outcome"),
            "elapsedMs": event.attrs.get("elapsedMs"),
            "createdAt": event.created_at.isoformat() if event.created_at else None,
        }
        for event in events
        if event.attrs.get("package") == plugin_id
    ][:20]
    return {
        "id": plugin_id,
        "spaceId": versions[0].space_id or 1,
        "releases": [
            public_view(row)
            for row in sorted(versions, key=lambda r: (_version_key(r.version), r.id), reverse=True)
        ],
        "scenarios": linked,
        "recentCalls": calls,
    }


async def approved_bindings(
    db: AsyncSession, packages: list[str], tool_map: dict[str, list[str]]
) -> list[dict]:
    selected = [item for item in dict.fromkeys(packages) if item != "forge-runtime"]
    if not selected:
        if tool_map:
            raise HTTPException(422, "未选择插件时不能指定插件工具")
        return []
    if set(tool_map) - set(selected):
        raise HTTPException(422, "插件工具与已选择插件不一致")
    rows = (await db.scalars(select(PluginRegistry).where(PluginRegistry.plugin_id.in_(selected)))).all()
    # 兼容迁移前的 P0 表记录；init_db 会填充 plugin_id，防御性保留此回退。
    if len({_row_plugin_id(row) for row in rows}) < len(selected):
        rows = (await db.scalars(select(PluginRegistry))).all()
    by_plugin: dict[str, list[PluginRegistry]] = {}
    for row in rows:
        by_plugin.setdefault(_row_plugin_id(row), []).append(row)
    bindings, bound_tools = [], set()
    for plugin_id in selected:
        candidates = [
            row
            for row in by_plugin.get(plugin_id, [])
            if row.audit_status == "approved"
            and row.enabled
            and row.runtime in {"forge-bridge", "forge-remote-worker-v1"}
            and row.is_default
        ]
        if not candidates:
            raise HTTPException(422, f"插件“{plugin_id}”尚未通过审核、已停用或运行时不受支持")
        row = candidates[0]
        available = {str(tool.get("name")): tool for tool in (row.tools_json or [])}
        names = [name for name in dict.fromkeys(tool_map.get(plugin_id, [])) if name]
        if not names:
            raise HTTPException(422, f"请至少选择插件“{row.display_name or plugin_id}”的一项工具")
        unknown = set(names) - set(available)
        if unknown:
            raise HTTPException(
                422, f"插件“{row.display_name or plugin_id}”包含未登记工具：" + "、".join(sorted(unknown))
            )
        if set(names) & TOOL_NAMES or set(names) & bound_tools:
            raise HTTPException(422, "插件工具与平台或其他插件工具冲突")
        bound_tools.update(names)
        bindings.append(
            {
                "package": _row_plugin_id(row),
                "displayName": row.display_name or _row_plugin_id(row),
                "version": row.version,
                "artifactHash": row.artifact_hash,
                "runtime": row.runtime,
                "execution": row.execution_json or {},
                "tools": [available[name] for name in names],
            }
        )
    return bindings


async def ensure_bindings_available(db: AsyncSession, bindings: list[dict]) -> None:
    """停用/撤销只阻止新会话；历史 Bundle 及其审计轨迹不被篡改。"""
    packages = [str(item.get("package", "")) for item in bindings if item.get("package")]
    if not packages:
        return
    rows = (await db.scalars(select(PluginRegistry).where(PluginRegistry.plugin_id.in_(packages)))).all()
    by_plugin: dict[str, list[PluginRegistry]] = {}
    for row in rows:
        by_plugin.setdefault(_row_plugin_id(row), []).append(row)
    for binding in bindings:
        plugin_id = str(binding.get("package", ""))
        match = next(
            (
                row
                for row in by_plugin.get(plugin_id, [])
                if row.version == binding.get("version") and row.artifact_hash == binding.get("artifactHash")
            ),
            None,
        )
        if not match or match.audit_status != "approved" or not match.enabled:
            raise HTTPException(409, f"会话依赖的插件“{plugin_id}”已停用、撤销或版本不可用，请选择其他场景")
