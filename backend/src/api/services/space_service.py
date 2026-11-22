"""空间：资源归属、列表过滤、移动与删除转移。

规则（详见 docs/13-空间设计方案.md）：
- 公共空间（id=1）内置，不能删除或改名；它的内容在每个空间可见、可用。
- 其他空间只看到「本空间 + 公共」的场景、Skill、MCP、插件；会话只看本空间。
- 模型、执行策略、联网配置、代码项目、运行状态是全局的，不分空间。
- 基础工具：每个空间各自开关（默认全开）；生效 = 执行策略允许 且 本空间开启，空间只能收紧。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select, text, true, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import get_session
from ..models.agent_scenario import AgentScenario, AgentScenarioVersion
from ..models.agent_session import AgentSession
from ..models.registry import McpServer, PluginRegistry
from ..models.skill import Skill
from ..models.space import PUBLIC_SPACE_ID, Space
from .settings_service import TOOLS, TOOL_NAMES, get_policy

SPACE_HEADER = "X-Forge-Space"
PUBLIC_NAME = "公共"
PUBLIC_COLOR = "gray"
SPACE_COLORS = ("orange", "blue", "green", "purple", "red", "cyan", "yellow", "pink")
MAX_NAME = 20
MAX_DESCRIPTION = 100
RESOURCE_KINDS = ("scenario", "skill", "mcp", "plugin")
KIND_LABELS = {"scenario": "场景", "skill": "Skill", "mcp": "MCP 服务", "plugin": "插件"}


# —— 公共空间与当前空间 ——


async def ensure_public_space(db: AsyncSession) -> Space:
    """公共空间固定为 id=1；不存在时创建（启动时与首次访问空间接口时调用）。"""
    row = await db.get(Space, PUBLIC_SPACE_ID)
    if row:
        if not row.is_public:
            row.is_public = True
            await db.commit()
        return row
    row = Space(id=PUBLIC_SPACE_ID, name=PUBLIC_NAME, color=PUBLIC_COLOR, description="", is_public=True)
    # 极少见：已有同名的普通空间（手工数据），先让出名称
    clash = await db.scalar(select(Space).where(Space.name == PUBLIC_NAME))
    if clash:
        clash.name = f"{PUBLIC_NAME}-{clash.id}"
        await db.flush()
    db.add(row)
    await db.flush()
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        # 显式写入 id=1 不会推进序列，手动对齐，避免下一次新建冲突
        await db.execute(
            text("SELECT setval(pg_get_serial_sequence('space', 'id'), (SELECT MAX(id) FROM space))")
        )
    await db.commit()
    return row


async def resolve_space_id(db: AsyncSession, raw: str | None) -> int | None:
    """请求头里的当前空间。没有请求头：None（不过滤，兼容旧客户端与脚本）；
    空间不存在（已删除）或格式不对：回到公共空间。"""
    if raw is None or raw == "":
        return None
    try:
        space_id = int(raw)
    except ValueError:
        return PUBLIC_SPACE_ID
    if space_id == PUBLIC_SPACE_ID:
        return PUBLIC_SPACE_ID
    return space_id if await db.get(Space, space_id) else PUBLIC_SPACE_ID


async def current_space(request: Request, db: AsyncSession = Depends(get_session)) -> int | None:
    """FastAPI 依赖：当前空间编号（见 resolve_space_id）。"""
    return await resolve_space_id(db, request.headers.get(SPACE_HEADER))


def visible_ids(space_id: int | None) -> set[int] | None:
    """在这个空间能看到的空间：本空间 + 公共；None 表示不过滤。"""
    if space_id is None:
        return None
    return {space_id, PUBLIC_SPACE_ID}


def visible_filter(column, space_id: int | None):
    ids = visible_ids(space_id)
    return true() if ids is None else column.in_(sorted(ids))


def is_visible(resource_space: int | None, space_id: int | None) -> bool:
    ids = visible_ids(space_id)
    return ids is None or (resource_space or PUBLIC_SPACE_ID) in ids


def target_space(space_id: int | None) -> int:
    """新建内容放在哪个空间：当前空间，没有时放公共。"""
    return space_id or PUBLIC_SPACE_ID


async def require_space(db: AsyncSession, space_id: int) -> Space:
    if space_id == PUBLIC_SPACE_ID:
        return await ensure_public_space(db)
    row = await db.get(Space, space_id)
    if not row:
        raise HTTPException(404, "空间不存在或已被删除")
    return row


def space_brief(row: Space | None) -> dict:
    if row is None:
        return {"id": PUBLIC_SPACE_ID, "name": PUBLIC_NAME, "color": PUBLIC_COLOR, "isPublic": True}
    return {"id": row.id, "name": row.name, "color": row.color, "isPublic": bool(row.is_public)}


async def space_map(db: AsyncSession) -> dict[int, dict]:
    rows = (await db.scalars(select(Space))).all()
    result = {row.id: space_brief(row) for row in rows}
    result.setdefault(PUBLIC_SPACE_ID, space_brief(None))
    return result


def attach_space(view: dict, space_id: int | None, spaces: dict[int, dict]) -> dict:
    """列表/详情返回所属空间（编号、名称、颜色），前端用来显示「公共」标记与空间列。"""
    key = space_id or PUBLIC_SPACE_ID
    view["spaceId"] = key
    view["spaceInfo"] = spaces.get(key) or space_brief(None)
    return view


# —— 基础工具开关 ——


async def disabled_tools(db: AsyncSession, space_id: int | None) -> set[str]:
    if space_id is None:
        return set()
    row = await db.get(Space, space_id)
    return set(row.disabled_tools or []) if row else set()


async def effective_policy(db: AsyncSession, space_id: int | None) -> dict:
    """会话使用的执行策略：在全局执行策略上去掉本空间关闭的基础工具（空间只能收紧，不能放宽）。"""
    policy = await get_policy(db)
    off = await disabled_tools(db, space_id)
    if not off:
        return policy
    return {**policy, "allowedTools": [name for name in policy.get("allowedTools", []) if name not in off]}


async def tool_states(db: AsyncSession, space_id: int | None) -> list[dict]:
    """基础工具清单 + 本空间是否启用 + 执行策略是否允许。"""
    policy = await get_policy(db)
    allowed = set(policy.get("allowedTools", []))
    off = await disabled_tools(db, space_id)
    return [
        {
            **tool,
            "policyAllowed": tool["name"] in allowed,
            "spaceEnabled": tool["name"] not in off,
            # 真正可用：策略允许 且 本空间开启
            "available": tool["name"] in allowed and tool["name"] not in off,
        }
        for tool in TOOLS
    ]


# —— 场景依赖 ——


@dataclass
class ScenarioDeps:
    row: AgentScenario
    skills: set[int] = field(default_factory=set)
    mcp: set[int] = field(default_factory=set)
    plugins: set[str] = field(default_factory=set)
    tools: set[str] = field(default_factory=set)


def _deps_from_version(deps: ScenarioDeps, bundle_json: dict) -> None:
    payload = bundle_json.get("payload") or {}
    caps = payload.get("capabilities") or {}
    meta = (bundle_json.get("bundle") or {}).get("meta") or {}
    deps.skills.update(item for item in caps.get("skill_ids") or [] if isinstance(item, int))
    deps.skills.update(
        ref.get("id")
        for ref in meta.get("skills") or []
        if isinstance(ref, dict) and isinstance(ref.get("id"), int)
    )
    deps.mcp.update(item for item in caps.get("mcp_server_ids") or [] if isinstance(item, int))
    deps.mcp.update(
        ref.get("id")
        for ref in meta.get("mcpServers") or []
        if isinstance(ref, dict) and isinstance(ref.get("id"), int)
    )
    deps.plugins.update(
        str(item) for item in caps.get("plugin_names") or [] if item and item != "forge-runtime"
    )
    deps.plugins.update(
        str(binding.get("package"))
        for binding in meta.get("pluginBindings") or []
        if isinstance(binding, dict) and binding.get("package")
    )
    deps.tools.update(str(item) for item in caps.get("builtin_tool_names") or [])


async def scenario_dependencies(
    db: AsyncSession, scenario_ids: list[int] | None = None
) -> list[ScenarioDeps]:
    """未删除场景在「当前配置」与「已发布版本」里用到的 Skill、MCP、插件、基础工具。"""
    statement = select(AgentScenario).where(AgentScenario.status != "deleted").order_by(AgentScenario.id)
    if scenario_ids is not None:
        if not scenario_ids:
            return []
        statement = statement.where(AgentScenario.id.in_(scenario_ids))
    rows = (await db.scalars(statement)).all()
    if not rows:
        return []
    versions = (
        await db.scalars(
            select(AgentScenarioVersion).where(AgentScenarioVersion.scenario_id.in_([row.id for row in rows]))
        )
    ).all()
    by_id = {row.id: ScenarioDeps(row) for row in rows}
    for version in versions:
        deps = by_id[version.scenario_id]
        if version.version in {deps.row.current_version, deps.row.published_version} - {0, None}:
            _deps_from_version(deps, version.bundle_json or {})
    return list(by_id.values())


def _uses(deps: ScenarioDeps, kind: str, key) -> bool:
    return {
        "skill": key in deps.skills,
        "mcp": key in deps.mcp,
        "plugin": key in deps.plugins,
    }[kind]


def scenario_label(row: AgentScenario, spaces: dict[int, dict]) -> dict:
    info = spaces.get(row.space_id or PUBLIC_SPACE_ID) or space_brief(None)
    return {"id": row.id, "name": row.name, "spaceId": info["id"], "spaceName": info["name"]}


async def tool_usage(db: AsyncSession, space_id: int, tool: str) -> list[dict]:
    """本空间里用到这个基础工具的场景（关闭前提示）。"""
    spaces = await space_map(db)
    return [
        scenario_label(deps.row, spaces)
        for deps in await scenario_dependencies(db)
        if (deps.row.space_id or PUBLIC_SPACE_ID) == space_id and tool in deps.tools
    ]


async def set_tool_enabled(db: AsyncSession, space_id: int, tool: str, enabled: bool) -> list[dict]:
    if tool not in TOOL_NAMES:
        raise HTTPException(404, "基础工具不存在")
    row = await require_space(db, space_id)
    if enabled:
        policy = await get_policy(db)
        if tool not in policy.get("allowedTools", []):
            raise HTTPException(409, "执行策略未允许这个工具，空间里不能开启；请先在「执行策略」中允许")
    off = [name for name in (row.disabled_tools or []) if name != tool and name in TOOL_NAMES]
    if not enabled:
        off.append(tool)
    row.disabled_tools = sorted(set(off))
    await db.commit()
    return await tool_states(db, space_id)


# —— Skill 重名 ——


async def skill_name_conflicts(
    db: AsyncSession, names: dict[int, str], target: int, exclude: set[int] | None = None
) -> list[dict]:
    """放进 target 空间后会重名的 Skill。

    规则：在任何空间里能同时看到的 Skill 不能重名——
    放进普通空间：不能和本空间、公共空间的 Skill 重名；放进公共空间：不能和任何空间的 Skill 重名。
    names 为 {skill_id: 名称}（新建时 id 用 0）；exclude 为一起移动、不参与比较的 Skill。
    """
    if not names:
        return []
    exclude = set(exclude or set()) | set(names)
    statement = select(Skill)
    if target != PUBLIC_SPACE_ID:
        statement = statement.where(Skill.space_id.in_([target, PUBLIC_SPACE_ID]))
    others = [row for row in (await db.scalars(statement)).all() if row.id not in exclude]
    taken: dict[str, Skill] = {}
    for row in others:
        taken.setdefault(row.name.strip().casefold(), row)
    spaces = await space_map(db)
    conflicts = []
    for skill_id, name in names.items():
        other = taken.get(name.strip().casefold())
        if other:
            info = spaces.get(other.space_id or PUBLIC_SPACE_ID) or space_brief(None)
            conflicts.append(
                {"id": skill_id, "name": name, "conflictId": other.id, "conflictSpace": info["name"]}
            )
    return conflicts


async def ensure_skill_name_free(db: AsyncSession, name: str, target: int, skill_id: int = 0) -> None:
    conflicts = await skill_name_conflicts(db, {skill_id: name}, target)
    if conflicts:
        raise HTTPException(
            409, f"「{conflicts[0]['conflictSpace']}」空间已有同名 Skill「{name}」，请换一个名称"
        )


async def ensure_caps_visible(db: AsyncSession, space_id: int, skill_ids, mcp_ids, plugin_ids) -> None:
    """场景只能使用本空间和公共空间的 Skill、MCP、插件。"""
    visible = {space_id, PUBLIC_SPACE_ID}
    spaces = await space_map(db)
    hidden = []
    for skill_id in dict.fromkeys(skill_ids or []):
        row = await db.get(Skill, skill_id)
        if row and (row.space_id or PUBLIC_SPACE_ID) not in visible:
            hidden.append(f"Skill「{row.name}」（{spaces.get(row.space_id, {}).get('name', '其他')}空间）")
    for server_id in dict.fromkeys(mcp_ids or []):
        row = await db.get(McpServer, server_id)
        if row and (row.space_id or PUBLIC_SPACE_ID) not in visible:
            hidden.append(f"MCP「{row.name}」（{spaces.get(row.space_id, {}).get('name', '其他')}空间）")
    for plugin_id in dict.fromkeys(item for item in plugin_ids or [] if item and item != "forge-runtime"):
        row = await db.scalar(select(PluginRegistry).where(PluginRegistry.plugin_id == plugin_id).limit(1))
        if row and (row.space_id or PUBLIC_SPACE_ID) not in visible:
            hidden.append(
                f"插件「{row.display_name or plugin_id}」（{spaces.get(row.space_id, {}).get('name', '其他')}空间）"
            )
    if hidden:
        raise HTTPException(422, "以下内容不在本空间或公共空间，不能使用：" + "、".join(hidden))


# —— 移动 ——


async def _resource(db: AsyncSession, kind: str, resource_id: str):
    """返回 (数据行列表, 名称, 当前空间)。插件按 plugin_id 一起移动全部版本。"""
    if kind == "plugin":
        rows = (await db.scalars(select(PluginRegistry).where(PluginRegistry.plugin_id == resource_id))).all()
        if not rows:
            raise HTTPException(404, "插件不存在")
        return rows, rows[0].display_name or resource_id, rows[0].space_id or PUBLIC_SPACE_ID
    try:
        key = int(resource_id)
    except ValueError as error:
        raise HTTPException(404, f"{KIND_LABELS[kind]}不存在") from error
    model = {"scenario": AgentScenario, "skill": Skill, "mcp": McpServer}[kind]
    row = await db.get(model, key)
    if not row or (kind == "scenario" and row.status == "deleted"):
        raise HTTPException(404, f"{KIND_LABELS[kind]}不存在")
    return [row], row.name, row.space_id or PUBLIC_SPACE_ID


async def move_check(db: AsyncSession, kind: str, resource_id: str, target: int) -> dict:
    """移动前检查：返回 {blockers: [...], conflicts: [...]}，两者都为空才能移动。"""
    if kind not in RESOURCE_KINDS:
        raise HTTPException(422, "不支持移动的内容类型")
    await require_space(db, target)
    rows, name, source = await _resource(db, kind, resource_id)
    spaces = await space_map(db)
    blockers: list[dict] = []
    conflicts: list[dict] = []
    if kind == "scenario":
        # 场景移走后，它用到的 Skill / MCP / 插件必须在目标空间可用（目标空间或公共）
        [deps] = await scenario_dependencies(db, [rows[0].id]) or [ScenarioDeps(rows[0])]
        visible = {target, PUBLIC_SPACE_ID}
        for skill_id in sorted(deps.skills):
            skill = await db.get(Skill, skill_id)
            if skill and (skill.space_id or PUBLIC_SPACE_ID) not in visible:
                blockers.append(
                    {
                        "kind": "skill",
                        "id": skill.id,
                        "name": skill.name,
                        "spaceName": spaces.get(skill.space_id, {}).get("name", ""),
                    }
                )
        for server_id in sorted(deps.mcp):
            server = await db.get(McpServer, server_id)
            if server and (server.space_id or PUBLIC_SPACE_ID) not in visible:
                blockers.append(
                    {
                        "kind": "mcp",
                        "id": server.id,
                        "name": server.name,
                        "spaceName": spaces.get(server.space_id, {}).get("name", ""),
                    }
                )
        for plugin_id in sorted(deps.plugins):
            plugin = await db.scalar(
                select(PluginRegistry).where(PluginRegistry.plugin_id == plugin_id).limit(1)
            )
            if plugin and (plugin.space_id or PUBLIC_SPACE_ID) not in visible:
                blockers.append(
                    {
                        "kind": "plugin",
                        "id": plugin_id,
                        "name": plugin.display_name or plugin_id,
                        "spaceName": spaces.get(plugin.space_id, {}).get("name", ""),
                    }
                )
    elif target != PUBLIC_SPACE_ID:
        # 移入公共空间总是可以；移到普通空间时，其他空间里仍在用它的场景会失去它
        key = resource_id if kind == "plugin" else rows[0].id
        for deps in await scenario_dependencies(db):
            if (deps.row.space_id or PUBLIC_SPACE_ID) != target and _uses(deps, kind, key):
                blockers.append({"kind": "scenario", **scenario_label(deps.row, spaces)})
    if kind == "skill":
        conflicts = await skill_name_conflicts(db, {rows[0].id: rows[0].name}, target)
    return {
        "kind": kind,
        "id": resource_id,
        "name": name,
        "from": spaces.get(source) or space_brief(None),
        "to": spaces.get(target) or space_brief(None),
        "blockers": blockers,
        "conflicts": conflicts,
    }


async def move_resource(db: AsyncSession, kind: str, resource_id: str, target: int) -> dict:
    check = await move_check(db, kind, resource_id, target)
    if check["blockers"]:
        names = "、".join(f"「{item['name']}」" for item in check["blockers"])
        if kind == "scenario":
            raise HTTPException(
                409, f"目标空间里用不到这个场景依赖的内容，请先把它们移到目标空间或公共空间：{names}"
            )
        raise HTTPException(409, f"以下其他空间的场景仍在使用它，移走后将无法使用：{names}")
    if check["conflicts"]:
        conflict = check["conflicts"][0]
        raise HTTPException(
            409, f"「{conflict['conflictSpace']}」空间已有同名 Skill「{conflict['name']}」，请先改名"
        )
    rows, _, _ = await _resource(db, kind, resource_id)
    for row in rows:
        row.space_id = target
    # 已有会话留在原空间，不随场景移动
    await db.commit()
    return check


# —— 空间增删改查 ——


class SpaceInput(BaseModel):
    name: str = Field(default="", max_length=MAX_NAME * 4)
    color: str = Field(default="", max_length=16)
    description: str = Field(default="", max_length=MAX_DESCRIPTION * 4)

    @field_validator("name", "description")
    @classmethod
    def strip(cls, value: str) -> str:
        return value.strip()


def _validate(payload: SpaceInput, *, need_name: bool = True) -> None:
    if need_name:
        if not payload.name:
            raise HTTPException(422, "请填写空间名称")
        if len(payload.name) > MAX_NAME:
            raise HTTPException(422, f"空间名称最多 {MAX_NAME} 个字")
        if "\n" in payload.name or not payload.name.isprintable():
            raise HTTPException(422, "空间名称不能包含换行或控制字符")
    if len(payload.description) > MAX_DESCRIPTION:
        raise HTTPException(422, f"空间说明最多 {MAX_DESCRIPTION} 个字")
    if payload.color and payload.color not in SPACE_COLORS:
        raise HTTPException(422, "不支持的空间颜色")


async def _name_taken(db: AsyncSession, name: str, exclude: int | None = None) -> bool:
    rows = (await db.scalars(select(Space))).all()
    return any(row.name.casefold() == name.casefold() and row.id != exclude for row in rows)


async def _counts(db: AsyncSession) -> dict[int, dict]:
    counts: dict[int, dict] = {}

    def bump(space_id, key, value):
        counts.setdefault(
            space_id or PUBLIC_SPACE_ID, {"scenarios": 0, "skills": 0, "mcp": 0, "plugins": 0, "sessions": 0}
        )[key] += value

    for space_id, value in (
        await db.execute(
            select(AgentScenario.space_id, func.count())
            .where(AgentScenario.status != "deleted")
            .group_by(AgentScenario.space_id)
        )
    ).all():
        bump(space_id, "scenarios", value)
    for space_id, value in (
        await db.execute(select(Skill.space_id, func.count()).group_by(Skill.space_id))
    ).all():
        bump(space_id, "skills", value)
    for space_id, value in (
        await db.execute(select(McpServer.space_id, func.count()).group_by(McpServer.space_id))
    ).all():
        bump(space_id, "mcp", value)
    for space_id, value in (
        await db.execute(
            select(PluginRegistry.space_id, func.count(func.distinct(PluginRegistry.plugin_id))).group_by(
                PluginRegistry.space_id
            )
        )
    ).all():
        bump(space_id, "plugins", value)
    for space_id, value in (
        await db.execute(
            select(AgentSession.space_id, func.count())
            .where(AgentSession.status != "archived")
            .group_by(AgentSession.space_id)
        )
    ).all():
        bump(space_id, "sessions", value)
    return counts


def _view(row: Space, counts: dict | None = None) -> dict:
    empty = {"scenarios": 0, "skills": 0, "mcp": 0, "plugins": 0, "sessions": 0}
    return {
        **space_brief(row),
        "description": row.description or "",
        "counts": counts or empty,
        "disabledTools": list(row.disabled_tools or []),
        "createdAt": row.created_at.isoformat() if row.created_at else None,
    }


def _sort_key(row: Space):
    # 公共在最前，其余按名称
    return (0 if row.is_public else 1, row.name.casefold())


async def list_spaces(db: AsyncSession) -> list[dict]:
    await ensure_public_space(db)
    rows = sorted((await db.scalars(select(Space))).all(), key=_sort_key)
    counts = await _counts(db)
    return [_view(row, counts.get(row.id)) for row in rows]


async def get_space(db: AsyncSession, space_id: int) -> dict:
    row = await require_space(db, space_id)
    return _view(row, (await _counts(db)).get(row.id))


async def create_space(db: AsyncSession, payload: SpaceInput) -> dict:
    _validate(payload)
    await ensure_public_space(db)
    if payload.name.casefold() == PUBLIC_NAME.casefold() or await _name_taken(db, payload.name):
        raise HTTPException(409, f"已有名为「{payload.name}」的空间")
    color = payload.color
    if not color:
        used = {row.color for row in (await db.scalars(select(Space))).all()}
        # 自动挑一个还没用过的颜色；都用过了就按数量轮换
        color = (
            next((item for item in SPACE_COLORS if item not in used), None)
            or SPACE_COLORS[len(used) % len(SPACE_COLORS)]
        )
    row = Space(
        name=payload.name, color=color, description=payload.description, is_public=False, disabled_tools=[]
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _view(row)


async def update_space(db: AsyncSession, space_id: int, payload: SpaceInput) -> dict:
    row = await require_space(db, space_id)
    if row.is_public:
        # 公共空间只能修改说明
        if payload.name and payload.name != row.name:
            raise HTTPException(409, "公共空间不能改名")
        if payload.color and payload.color != row.color:
            raise HTTPException(409, "公共空间不能修改颜色")
        _validate(payload, need_name=False)
        row.description = payload.description
    else:
        _validate(payload)
        if payload.name.casefold() == PUBLIC_NAME.casefold() or await _name_taken(db, payload.name, row.id):
            raise HTTPException(409, f"已有名为「{payload.name}」的空间")
        row.name = payload.name
        row.description = payload.description
        if payload.color:
            row.color = payload.color
    await db.commit()
    await db.refresh(row)
    return _view(row, (await _counts(db)).get(row.id))


async def delete_check(db: AsyncSession, space_id: int, target: int | None) -> dict:
    """删除前检查：空间里的内容数量；转移到 target 时需要先改名的 Skill。"""
    row = await require_space(db, space_id)
    if row.is_public:
        raise HTTPException(409, "公共空间不能删除")
    counts = (await _counts(db)).get(row.id) or {
        "scenarios": 0,
        "skills": 0,
        "mcp": 0,
        "plugins": 0,
        "sessions": 0,
    }
    empty = not any(counts.values())
    conflicts: list[dict] = []
    target_brief = None
    if target is not None:
        if target == space_id:
            raise HTTPException(422, "不能转移到要删除的空间本身")
        target_brief = space_brief(await require_space(db, target))
        skills = (await db.scalars(select(Skill).where(Skill.space_id == space_id))).all()
        conflicts = await skill_name_conflicts(
            db, {skill.id: skill.name for skill in skills}, target, exclude={skill.id for skill in skills}
        )
    return {"space": _view(row, counts), "empty": empty, "target": target_brief, "conflicts": conflicts}


async def delete_space(db: AsyncSession, space_id: int, target: int | None) -> dict:
    """删除空间。有内容时必须全部转移到 target（默认公共）；不提供连内容一起删除。"""
    check = await delete_check(db, space_id, target if target is not None else PUBLIC_SPACE_ID)
    if check["conflicts"]:
        names = "、".join(f"「{item['name']}」" for item in check["conflicts"])
        raise HTTPException(409, f"目标空间已有同名 Skill，请先改名：{names}")
    destination = target if target is not None else PUBLIC_SPACE_ID
    for model in (AgentScenario, Skill, McpServer, PluginRegistry, AgentSession):
        await db.execute(update(model).where(model.space_id == space_id).values(space_id=destination))
    # 基础工具开关随空间一起删除
    row = await db.get(Space, space_id)
    await db.delete(row)
    await db.commit()
    return {"deleted": True, "movedTo": check["target"], "counts": check["space"]["counts"]}


__all__ = [
    "PUBLIC_SPACE_ID",
    "SPACE_HEADER",
    "SpaceInput",
    "attach_space",
    "current_space",
    "ensure_public_space",
    "is_visible",
    "target_space",
    "visible_filter",
]
