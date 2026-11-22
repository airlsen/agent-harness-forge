"""会话扩展能力：Skill、MCP 与联网搜索。

一次执行可用的扩展能力 = 场景绑定（Bundle 冻结） ∪ 聊天临时选择（会话保存，下一轮生效）。
控制面每轮把完整集合解析成 Runner 可执行的配置下发：

- Skill：场景冻结到已发布的修订（SkillRevision 不可变），聊天临时选择使用当时最新的已发布修订；
  内容按快照传递：快照标识「修订号-内容哈希」，Runner 据此物化只读快照目录（SKILL.md + references/、assets/、
  scripts/），与修订逐字节一致。修订不可变，所以控制面记住已算过的快照：首次使用某修订时读取全部文件、下发全文
  （document 原文 + content 正文 + files）；之后每轮只发 {revisionId, snapshot} 引用，不读文件内容、不传全文。
  Runner 没有该快照（重启或缓存淘汰）时返回 409 + missingSkills，由 expand_skills 补发全文后重试一次。
  附加文件缺失或损坏时只跳过这一个 Skill 并在摘要中记录原因，不阻断对话。
- MCP：只用已启用、连接测试通过的服务；凭据每轮解密下发，不进入 Bundle 与事件。
  工具标注 readOnlyHint=true 的直接执行，其余每次调用都需用户确认。
- 联网：平台级开关与凭据（治理中心），场景或聊天开启后才会装配；搜索使用 DeepSeek 官方搜索。
"""

import hashlib
import json
import re
from collections import OrderedDict
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core import security
from ..models.platform import ModelConnection, PlatformSetting
from ..models.registry import McpServer
from ..models.skill import Skill, SkillRevision
from .skill_service import MAX_SKILL_BYTES, skill_file_snapshot, skill_files_missing

MAX_SESSION_SKILLS = 20
MAX_SESSION_MCP = 10
RUNNABLE_MCP_TRANSPORTS = ("stdio", "streamable-http")
WEB_SETTING_KEY = "web-search"
WEB_PROVIDERS = {
    "deepseek-official": "DeepSeek 官方联网搜索（Anthropic 兼容接口，每次搜索相当于一次模型调用）",
    "deepseek-search-api": "DeepSeek Search API",
}
DEFAULT_WEB_SETTINGS = {
    "enabled": False,
    "provider": "deepseek-official",
    "baseUrl": "",
    "credential": "",
    "fetchEnabled": True,
}
SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MCP_SERVER_NAME = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
EMPTY_SELECTION = {"skillIds": [], "mcpServerIds": [], "webSearch": False}


# —— 选择（会话临时能力） ——


class CapabilityChoice(BaseModel):
    """聊天中临时选择的扩展能力；与场景绑定的能力取并集。"""

    skillIds: list[int] = Field(default_factory=list, max_length=MAX_SESSION_SKILLS)
    mcpServerIds: list[int] = Field(default_factory=list, max_length=MAX_SESSION_MCP)
    webSearch: bool = False

    @model_validator(mode="after")
    def unique(self):
        if len(set(self.skillIds)) != len(self.skillIds) or len(set(self.mcpServerIds)) != len(
            self.mcpServerIds
        ):
            raise ValueError("能力选择中有重复项")
        return self


def selection_of(value) -> dict:
    """会话保存的临时选择；旧会话为 NULL，视为未选择。"""
    if not isinstance(value, dict):
        return dict(EMPTY_SELECTION)
    return {
        "skillIds": [int(item) for item in value.get("skillIds", []) if isinstance(item, int)],
        "mcpServerIds": [int(item) for item in value.get("mcpServerIds", []) if isinstance(item, int)],
        "webSearch": bool(value.get("webSearch", False)),
    }


# —— Skill ——


def parse_skill(content: str) -> tuple[str, str, str]:
    """拆出 front matter 的 name / description 与正文（已发布内容均已通过 validate_content）。"""
    name, description, body = "", "", content
    if content.startswith("---\n"):
        parts = content.split("---", 2)
        if len(parts) == 3:
            front, body = parts[1], parts[2].lstrip("\n")
            match = re.search(r"(?m)^name:\s*(\S+)\s*$", front)
            name = match.group(1).strip("'\"") if match else ""
            match = re.search(r"(?m)^description:\s*(\S.*)$", front)
            description = match.group(1).strip().strip("'\"") if match else ""
    return name, description, body


def runtime_skill_name(name: str, skill_id: int) -> str:
    """DSH 技能名只允许小写 kebab-case：规范化 front matter 的 name，无法规范化时用 skill-<id>。"""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:64].strip("-")
    return slug if SKILL_NAME.match(slug) else f"skill-{skill_id}"


async def published_skills(db: AsyncSession, skill_ids: list[int] | None = None) -> dict[int, tuple]:
    """已发布 Skill → (Skill, 发布修订)。未发布或不存在的不返回。"""
    statement = select(Skill).where(Skill.published_revision_id.is_not(None))
    if skill_ids is not None:
        if not skill_ids:
            return {}
        statement = statement.where(Skill.id.in_(skill_ids))
    rows = (await db.scalars(statement.order_by(Skill.name, Skill.id))).all()
    result = {}
    for row in rows:
        revision = await db.get(SkillRevision, row.published_revision_id)
        if revision:
            result[row.id] = (row, revision)
    return result


def skill_unavailable_reason(row: Skill | None) -> str:
    """Skill 不能使用的原因（用于提示与摘要）：已删除、已下线或尚未发布。"""
    if row is None:
        return "已删除"
    return "已下线" if row.next_published_version > 1 else "尚未发布"


async def skill_unavailable_labels(db: AsyncSession, skill_ids: list[int]) -> str:
    """把不可用的 Skill 编号整理成「名称（原因）」，用于保存场景、选择能力时的报错。"""
    labels = []
    for skill_id in skill_ids:
        row = await db.get(Skill, skill_id)
        name = row.name if row else f"#{skill_id}"
        labels.append(f"{name}（{skill_unavailable_reason(row)}）")
    return "、".join(labels)


def skill_ref(skill: Skill, revision: SkillRevision) -> dict:
    """场景 Bundle 里冻结的 Skill 引用：修订不可变，不内联正文与参考资料。"""
    name, description, _ = parse_skill(revision.content)
    return {
        "id": skill.id,
        "revisionId": revision.id,
        "version": revision.published_version,
        "title": skill.name,
        "name": runtime_skill_name(name, skill.id),
        "description": (description or skill.description or skill.name)[:1024],
    }


async def freeze_scenario_skills(db: AsyncSession, skill_ids: list[int]) -> list[dict]:
    if len(skill_ids) > MAX_SESSION_SKILLS:
        raise HTTPException(422, f"一个场景最多绑定 {MAX_SESSION_SKILLS} 个 Skill")
    available = await published_skills(db, skill_ids)
    missing = [str(item) for item in skill_ids if item not in available]
    if missing:
        labels = await skill_unavailable_labels(db, [int(item) for item in missing])
        raise HTTPException(422, f"以下 Skill 不可用，请先在场景中移除：{labels}")
    return [skill_ref(*available[item]) for item in skill_ids]


def skill_snapshot_id(revision_id: int | None, document: str, files: list[dict]) -> str:
    """Skill 快照标识「<修订号>-<内容哈希前 12 位>」，与 Runner capabilities.skillSnapshotId 算法一致。

    哈希覆盖 SKILL.md 原文与全部附加文件（按路径排序，路径与内容以 NUL 分隔；两者都不含 NUL），
    同一修订内容不变时快照目录可复用，内容不同则必然是新目录。
    """
    digest = hashlib.sha256()
    for part in ["SKILL.md", document]:
        digest.update(part.encode("utf-8") + b"\0")
    for item in sorted(files, key=lambda file: file["path"]):
        digest.update(item["path"].encode("utf-8") + b"\0")
        digest.update(item["content"].encode("utf-8") + b"\0")
    return f"{revision_id or 0}-{digest.hexdigest()[:12]}"


# 已算过的快照：修订内容键 → 快照标识。键含修订编号、原文哈希与文件清单（含磁盘位置），
# 数据库重建导致编号复用时也不会对错版本；只在内存里，进程重启后首次使用再算一次。
MAX_KNOWN_SNAPSHOTS = 4096
_known_snapshots: "OrderedDict[tuple, str]" = OrderedDict()


def _revision_key(revision: SkillRevision) -> tuple:
    return (
        revision.id,
        revision.skill_id,
        hashlib.sha256(revision.content.encode("utf-8")).hexdigest(),
        json.dumps(revision.reference_files or [], sort_keys=True, ensure_ascii=False),
    )


def _remember_snapshot(key: tuple, snapshot: str) -> None:
    _known_snapshots[key] = snapshot
    _known_snapshots.move_to_end(key)
    while len(_known_snapshots) > MAX_KNOWN_SNAPSHOTS:
        _known_snapshots.popitem(last=False)


def forget_snapshots(snapshot: str | None = None) -> None:
    """忘记某个快照（不传则全部）：下一轮重新读取文件并下发全文。"""
    for key in [key for key, value in _known_snapshots.items() if snapshot is None or value == snapshot]:
        _known_snapshots.pop(key, None)


async def _runtime_skill(db: AsyncSession, ref: dict, source: str, name: str) -> tuple[dict | None, str]:
    """Runner 配置；不可用时返回 (None, 原因)。已知快照只发引用，首次使用才读文件、发全文。"""
    revision = await db.get(SkillRevision, ref.get("revisionId"))
    if not revision or revision.skill_id != ref.get("id"):
        return None, "Skill 修订不存在或已删除"
    document = revision.content
    if "\0" in document or len(document.encode("utf-8")) > MAX_SKILL_BYTES:
        return None, f"SKILL.md 无效或超过 {MAX_SKILL_BYTES // 1000} KB"
    meta = {
        "name": name,
        "title": ref.get("title") or name,
        "description": ref.get("description") or name,
        "revisionId": revision.id,
        "source": source,
    }
    key = _revision_key(revision)
    known = _known_snapshots.get(key)
    if known:
        # 引用形式：只确认文件仍在（不读内容），被删除时与首次读取一样只跳过这个 Skill
        problem = skill_files_missing(revision)
        if problem:
            _known_snapshots.pop(key, None)
            return None, problem
        _known_snapshots.move_to_end(key)
        return {**meta, "snapshot": known}, ""
    files, problem = skill_file_snapshot(revision)
    if problem:
        return None, problem
    snapshot = skill_snapshot_id(revision.id, document, files)
    _remember_snapshot(key, snapshot)
    return {**meta, "snapshot": snapshot, **_skill_content(document, files)}, ""


def _skill_content(document: str, files: list[dict]) -> dict:
    _, _, body = parse_skill(document)
    return {
        # 完整原文：Runner 写成快照目录里的 SKILL.md（不从正文重建，保证与修订逐字节一致）
        "document": document,
        # 去掉 front matter 的正文：注册为 DSH 运行时 Skill，由 skill 工具加载
        "content": body or document,
        # 附加文件：Runner 写入同一快照目录的 references/、assets/、scripts/（只读）
        "files": files,
    }


SKILL_CONTENT_FIELDS = ("document", "content", "files")


def as_refs(caps: dict) -> dict:
    """只保留 Skill 的快照引用：Runner 已有这些内容时（例如刚用全文创建会话）使用。"""
    return {
        **caps,
        "skills": [
            {key: value for key, value in skill.items() if key not in SKILL_CONTENT_FIELDS}
            if skill.get("snapshot")
            else skill
            for skill in caps.get("skills") or []
        ],
    }


async def expand_skills(db: AsyncSession, caps: dict, snapshots: list[str]) -> dict:
    """Runner 缺少这些快照的内容：把对应 Skill 换成全文形式（按修订重新严格读取）。

    内容已不可用（文件在两轮之间被删除）或与记录的快照不一致时，忘记该快照并让本轮失败；
    下一轮会重新读取，并按常规把它标记为不可用。
    """
    wanted = set(snapshots)
    skills = []
    for skill in caps.get("skills") or []:
        if skill.get("snapshot") in wanted and "content" not in skill:
            revision = await db.get(SkillRevision, skill.get("revisionId"))
            files, problem = skill_file_snapshot(revision) if revision else ([], "Skill 修订不存在或已删除")
            if not problem and skill_snapshot_id(revision.id, revision.content, files) != skill["snapshot"]:
                problem = "内容与记录的版本不一致"
            if problem:
                forget_snapshots(skill["snapshot"])
                raise HTTPException(
                    409, f"Skill「{skill.get('title') or skill['name']}」暂不可用：{problem}，请重新发送消息"
                )
            skill = {**skill, **_skill_content(revision.content, files)}
        skills.append(skill)
    return {**caps, "skills": skills}


# —— MCP ——


def runtime_server_name(row: McpServer) -> str:
    return row.name if MCP_SERVER_NAME.match(row.name) else f"mcp{row.id}"


def mcp_runnable(row: McpServer | None) -> bool:
    return bool(
        row
        and row.enabled
        and row.status == "connected"
        and row.transport in RUNNABLE_MCP_TRANSPORTS
        and row.tools_json
    )


def tool_permission(tool: dict) -> str:
    """MCP 工具一律直接执行（与 bash 一致），不再按 readOnlyHint 标注逐次确认。

    管理员接入并启用 MCP 服务即视为授权；Runner 仍兼容 permission=approval（受管插件等来源）。
    """
    return "read"


def mcp_option(row: McpServer) -> dict:
    tools = [tool for tool in row.tools_json or [] if isinstance(tool, dict) and tool.get("name")]
    return {
        "id": row.id,
        "name": row.name,
        "transport": row.transport,
        "description": str((row.server_info or {}).get("name") or ""),
        "tools": [
            {
                "name": tool["name"],
                "description": str(tool.get("description", ""))[:300],
                "permission": tool_permission(tool),
            }
            for tool in tools
        ],
    }


async def freeze_scenario_mcp(db: AsyncSession, server_ids: list[int]) -> list[dict]:
    if len(server_ids) > MAX_SESSION_MCP:
        raise HTTPException(422, f"一个场景最多绑定 {MAX_SESSION_MCP} 个 MCP 服务")
    refs = []
    for server_id in server_ids:
        row = await db.get(McpServer, server_id)
        if not mcp_runnable(row):
            raise HTTPException(422, f"MCP 服务不可用（需已启用且连接测试通过）：{server_id}")
        refs.append({"id": row.id, "name": row.name})
    return refs


def _runtime_mcp(row: McpServer, server_name: str, source: str) -> dict:
    private = json.loads(security.decrypt(row.headers_encrypted)) if row.headers_encrypted else {}
    tools = [
        {"name": tool["name"], "permission": tool_permission(tool)}
        for tool in row.tools_json or []
        if isinstance(tool, dict) and isinstance(tool.get("name"), str) and tool["name"]
    ]
    common = {"serverName": server_name, "title": row.name, "source": source, "tools": tools[:200]}
    if row.transport == "stdio":
        return {
            **common,
            "transport": "stdio",
            "command": private.get("command", ""),
            "args": list(private.get("args", [])),
            "env": dict(private.get("env", {})),
        }
    headers = private.get("headers", private) if isinstance(private, dict) else {}
    return {**common, "transport": "streamable-http", "url": row.url, "headers": dict(headers)}


# —— 联网 ——


class WebSearchInput(BaseModel):
    enabled: bool = False
    provider: str = Field(default="deepseek-official")
    baseUrl: str = Field(default="", max_length=512)
    apiKey: str | None = Field(default=None, max_length=2048)
    clearKey: bool = False
    fetchEnabled: bool = True

    @model_validator(mode="after")
    def valid(self):
        if self.provider not in WEB_PROVIDERS:
            raise ValueError("不支持的联网搜索提供方")
        self.baseUrl = self.baseUrl.strip().rstrip("/")
        if self.baseUrl:
            parsed = urlsplit(self.baseUrl)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("搜索服务地址必须是不含凭据与查询参数的 HTTPS 地址")
        return self


async def _web_row(db: AsyncSession) -> dict:
    row = await db.get(PlatformSetting, WEB_SETTING_KEY)
    return {**DEFAULT_WEB_SETTINGS, **(row.value if row else {})}


async def _model_fallback_key(db: AsyncSession) -> str:
    """未单独配置搜索密钥时，复用模型中心里 DeepSeek 官方地址的模型密钥（同一账号）。"""
    rows = (
        await db.scalars(
            select(ModelConnection).where(ModelConnection.enabled.is_(True)).order_by(ModelConnection.id)
        )
    ).all()
    for row in rows:
        host = (urlsplit(row.base_url).hostname or "").lower()
        if host == "api.deepseek.com" and row.credential:
            return security.decrypt(row.credential)
    return ""


async def web_settings_view(db: AsyncSession) -> dict:
    value = await _web_row(db)
    model_key = "" if value["credential"] else await _model_fallback_key(db)
    key_source = "custom" if value["credential"] else ("model" if model_key else "none")
    search_ready = key_source != "none"
    if not value["enabled"]:
        reason = "管理员尚未开启联网"
    elif not search_ready:
        reason = "未配置搜索密钥：可填写 DeepSeek API Key，或在模型中心接入 DeepSeek 官方模型"
    else:
        reason = ""
    return {
        "enabled": bool(value["enabled"]),
        "provider": value["provider"],
        "providers": [{"id": key, "label": label} for key, label in WEB_PROVIDERS.items()],
        "baseUrl": value["baseUrl"],
        "apiKeyConfigured": bool(value["credential"]),
        "keySource": key_source,
        "fetchEnabled": bool(value["fetchEnabled"]),
        "searchReady": bool(value["enabled"] and search_ready),
        "available": bool(value["enabled"] and (search_ready or value["fetchEnabled"])),
        "reason": reason,
    }


async def save_web_settings(db: AsyncSession, payload: WebSearchInput) -> dict:
    value = await _web_row(db)
    credential = value["credential"]
    if payload.clearKey:
        credential = ""
    elif payload.apiKey:
        credential = security.encrypt(payload.apiKey.strip())
    stored = {
        "enabled": payload.enabled,
        "provider": payload.provider,
        "baseUrl": payload.baseUrl,
        "credential": credential,
        "fetchEnabled": payload.fetchEnabled,
    }
    row = await db.get(PlatformSetting, WEB_SETTING_KEY)
    if row:
        row.value = stored
    else:
        db.add(PlatformSetting(key=WEB_SETTING_KEY, value=stored))
    await db.commit()
    return await web_settings_view(db)


async def _runtime_web(db: AsyncSession, source: str) -> dict | None:
    value = await _web_row(db)
    if not value["enabled"]:
        return None
    key = security.decrypt(value["credential"]) if value["credential"] else await _model_fallback_key(db)
    search, fetch = bool(key), bool(value["fetchEnabled"])
    if not search and not fetch:
        return None
    web = {"search": search, "fetch": fetch, "source": source}
    if search:
        web.update({"provider": value["provider"], "apiKey": key})
        if value["baseUrl"]:
            web["baseUrl"] = value["baseUrl"]
    return web


# —— 选项与校验 ——


async def options(db: AsyncSession) -> dict:
    """聊天与场景编辑器的能力选项：只列可用的（已发布 Skill、可运行的 MCP、联网状态），不含任何凭据。"""
    skills = await published_skills(db)
    offline = (
        await db.scalars(
            select(Skill)
            .where(Skill.published_revision_id.is_(None), Skill.next_published_version > 1)
            .order_by(Skill.name, Skill.id)
        )
    ).all()
    servers = (await db.scalars(select(McpServer).order_by(McpServer.name))).all()
    web = await web_settings_view(db)
    return {
        "skills": [
            {**skill_ref(skill, revision), "tags": skill.tags or []} for skill, revision in skills.values()
        ],
        # 已下线的 Skill 只给名称：场景与聊天里仍勾着它时显示「已下线」，不能再新选
        "offlineSkills": [{"id": row.id, "title": row.name} for row in offline],
        "mcpServers": [mcp_option(row) for row in servers if mcp_runnable(row)],
        "web": {key: web[key] for key in ("available", "searchReady", "fetchEnabled", "reason", "provider")},
    }


async def validate_choice(db: AsyncSession, choice: CapabilityChoice, previous: dict | None = None) -> dict:
    """新加入的 Skill 必须已发布、MCP 必须可运行；已在选择中的不重复检查（执行前会再次解析）。"""
    previous = previous or EMPTY_SELECTION
    added_skills = [item for item in choice.skillIds if item not in previous["skillIds"]]
    if added_skills:
        available = await published_skills(db, added_skills)
        missing = [str(item) for item in added_skills if item not in available]
        if missing:
            labels = await skill_unavailable_labels(db, [int(item) for item in missing])
            raise HTTPException(422, f"Skill 不可用：{labels}")
    for server_id in choice.mcpServerIds:
        if server_id in previous["mcpServerIds"]:
            continue
        if not mcp_runnable(await db.get(McpServer, server_id)):
            raise HTTPException(422, f"MCP 服务不可用（需已启用且连接测试通过）：{server_id}")
    if choice.webSearch and not previous["webSearch"] and not (await web_settings_view(db))["available"]:
        raise HTTPException(409, "联网搜索未开启或未配置，请联系管理员在治理中心开启")
    return choice.model_dump()


# —— 每轮解析 ——


async def resolve(db: AsyncSession, meta: dict, selection: dict) -> tuple[dict, dict]:
    """本轮生效的能力：返回 (Runner 配置, 展示摘要)。不可用的能力跳过并记入摘要，不阻断对话。"""
    skills, skill_view, unavailable = [], [], []
    used_names: set[str] = set()
    scenario_skill_ids = set()

    async def add_skill(ref: dict, source: str):
        name = ref["name"]
        if name in used_names:
            name = f"{name[:56]}-{ref['id']}"
        runtime, reason = await _runtime_skill(db, ref, source, name)
        if not runtime:
            unavailable.append(
                {"kind": "skill", "id": ref.get("id"), "title": ref.get("title", ""), "reason": reason}
            )
            return
        used_names.add(name)
        skills.append(runtime)
        skill_view.append(
            {
                "id": ref["id"],
                "name": name,
                "title": runtime["title"],
                "version": ref.get("version"),
                # 本轮实际装配的修订与快照目录名（Runner 用同一算法得到相同的目录名）
                "revisionId": runtime["revisionId"],
                "snapshot": runtime["snapshot"],
                "source": source,
            }
        )

    for ref in meta.get("skills") or []:
        scenario_skill_ids.add(ref.get("id"))
        # 场景冻结在发布时的修订；Skill 下线或删除后从下一轮起跳过，不阻断对话
        row = await db.get(Skill, ref.get("id"))
        if row is None or row.published_revision_id is None:
            unavailable.append(
                {
                    "kind": "skill",
                    "id": ref.get("id"),
                    "title": ref.get("title", ""),
                    "reason": skill_unavailable_reason(row),
                }
            )
            continue
        await add_skill(ref, "scenario")
    chat_skill_ids = [item for item in selection["skillIds"] if item not in scenario_skill_ids]
    published = await published_skills(db, chat_skill_ids)
    for skill_id in chat_skill_ids:
        if skill_id in published:
            await add_skill(skill_ref(*published[skill_id]), "chat")
        else:
            row = await db.get(Skill, skill_id)
            unavailable.append(
                {
                    "kind": "skill",
                    "id": skill_id,
                    "title": row.name if row else "",
                    "reason": skill_unavailable_reason(row),
                }
            )

    mcp, mcp_view, server_names = [], [], set()
    scenario_ids = [ref.get("id") for ref in meta.get("mcpServers") or []]
    ordered = [(item, "scenario") for item in scenario_ids] + [
        (item, "chat") for item in selection["mcpServerIds"] if item not in scenario_ids
    ]
    for server_id, source in ordered:
        row = await db.get(McpServer, server_id)
        if not mcp_runnable(row):
            unavailable.append({"kind": "mcp", "id": server_id, "title": row.name if row else ""})
            continue
        server_name = runtime_server_name(row)
        if server_name in server_names:
            server_name = f"mcp{row.id}"
        try:
            runtime = _runtime_mcp(row, server_name, source)
        except (ValueError, TypeError, AttributeError):
            # 配置无法解密或格式损坏：跳过此服务，不阻断对话
            unavailable.append({"kind": "mcp", "id": server_id, "title": row.name})
            continue
        server_names.add(server_name)
        mcp.append(runtime)
        mcp_view.append(
            {
                "id": row.id,
                "name": row.name,
                "serverName": server_name,
                "transport": row.transport,
                "source": source,
                "tools": len(runtime["tools"]),
                "approvalTools": sum(1 for tool in runtime["tools"] if tool["permission"] == "approval"),
            }
        )

    web, web_view = None, None
    requested = "scenario" if meta.get("webSearch") else ("chat" if selection["webSearch"] else None)
    if requested:
        web = await _runtime_web(db, requested)
        if web:
            web_view = {"search": web["search"], "fetch": web["fetch"], "source": requested}
        else:
            unavailable.append({"kind": "web", "id": None, "title": "联网搜索"})
    return (
        {"skills": skills, "mcp": mcp, "web": web},
        {"skills": skill_view, "mcp": mcp_view, "web": web_view, "unavailable": unavailable},
    )


def summary_is_empty(summary: dict) -> bool:
    return not (summary["skills"] or summary["mcp"] or summary["web"])
