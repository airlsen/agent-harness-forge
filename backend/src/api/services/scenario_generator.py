"""AI 生成场景：按需求生成名称、介绍、图标、提示词，并从当前可用能力中自动匹配。

流程：整理候选能力（当前空间 + 公共空间里可用的 Skill、MCP、插件工具与联网状态）→ 能力较多时先按
关键词粗筛 → 交给模型挑选 → 服务端逐项校验（不在候选里的丢弃、数量与长度限制、联网需平台开启）。
模型推荐的能力直接勾选到草稿中，由用户确认后保存；不会自动保存或发布。
"""

from __future__ import annotations

import json
import re
from typing import Any

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..schemas.agent_scenario import GENERATE_FIELDS, GenerateScenarioRequest
from . import llm_service
from .capability_service import MAX_SESSION_MCP, MAX_SESSION_SKILLS, options
from .plugin_service import list_plugins
from .settings_service import TOOL_NAMES, get_policy

ICONS = ["sparkles", "code", "file", "chart", "book", "shield"]
SUPPORTED_PLUGIN_RUNTIMES = {"forge-bridge", "forge-remote-worker-v1"}
# 候选太多时先粗筛，避免提示词过长；每类保留与需求最相关的前 N 个
CANDIDATE_LIMITS = {"skills": 30, "mcp": 15, "plugins": 15}
MAX_MISSING = 3
FIELD_LABELS = {
    "name": "name（名称）",
    "description": "description（一句话介绍）",
    "icon": "icon（图标）",
    "prompt": "prompt（提示词）",
    "capabilities": "capabilities（能力）与 missing（缺少的能力）",
}


def _clip(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _grams(text: str) -> set[str]:
    """中英文混合的粗粒度切词：英文按单词，中文按相邻两字。"""
    text = text.lower()
    words = set(re.findall(r"[a-z0-9_]{2,}", text))
    for run in re.findall(r"[\u4e00-\u9fff]+", text):
        words.update(run[i : i + 2] for i in range(max(len(run) - 1, 1)))
    return words


def _shortlist(items: list[dict], query: set[str], limit: int, keep: set[str]) -> list[dict]:
    """数量超过上限时按与需求的词重合度排序，已选中的项始终保留。"""
    if len(items) <= limit:
        return items

    def score(item: dict) -> int:
        return len(query & _grams(item["_text"]))

    kept = [item for item in items if item["ref"] in keep]
    rest = sorted((item for item in items if item["ref"] not in keep), key=score, reverse=True)
    return kept + rest[: max(limit - len(kept), 0)]


async def build_catalog(db: AsyncSession, space_id: int | None) -> dict:
    """当前空间可用的候选能力；ref 是给模型看的短编号，返回时映射回真实编号。"""
    caps = await options(db, space_id)
    policy = await get_policy(db)
    allowed_plugin_tools = set(policy.get("allowedPluginTools", []))
    skills = [
        {
            "ref": f"S{item['id']}",
            "id": item["id"],
            "name": item["title"],
            "desc": _clip(item.get("description"), 200),
            "tags": item.get("tags") or [],
            "_text": f"{item['title']} {item.get('description', '')} {' '.join(item.get('tags') or [])}",
        }
        for item in caps["skills"]
    ]
    mcp = [
        {
            "ref": f"M{item['id']}",
            "id": item["id"],
            "name": item["name"],
            "desc": _clip(item.get("description"), 120),
            "tools": [
                {"name": tool["name"], "desc": _clip(tool.get("description"), 100)}
                for tool in item.get("tools", [])[:20]
            ],
            "_text": " ".join(
                [item["name"], item.get("description", "")]
                + [f"{tool['name']} {tool.get('description', '')}" for tool in item.get("tools", [])]
            ),
        }
        for item in caps["mcpServers"]
    ]
    plugins = []
    for index, row in enumerate((await list_plugins(db, space_id))[0], start=1):
        if (
            row["package"] == "forge-runtime"
            or row["auditStatus"] != "approved"
            or not row["enabled"]
            or not row["isDefault"]
            or row["runtime"] not in SUPPORTED_PLUGIN_RUNTIMES
        ):
            continue
        tools = [
            tool
            for tool in row.get("tools") or []
            if isinstance(tool, dict)
            and tool.get("name")
            and tool["name"] not in TOOL_NAMES
            and ("*" in allowed_plugin_tools or tool["name"] in allowed_plugin_tools)
        ]
        if not tools:
            continue
        plugins.append(
            {
                "ref": f"P{index}",
                "package": row["package"],
                "name": row["displayName"],
                "desc": _clip(row.get("description"), 160),
                "demo": "demo" in (row.get("source") or ""),
                "tools": [
                    {
                        "name": tool["name"],
                        "desc": _clip(tool.get("description") or tool.get("title"), 100),
                    }
                    for tool in tools
                ],
                "_text": " ".join(
                    [row["displayName"], row.get("description") or ""]
                    + [
                        f"{tool['name']} {tool.get('title', '')} {tool.get('description', '')}"
                        for tool in tools
                    ]
                ),
            }
        )
    web = caps["web"]
    return {
        "skills": skills,
        "mcp": mcp,
        "plugins": plugins,
        "web": {"available": bool(web.get("available")), "reason": web.get("reason") or ""},
    }


def _current_refs(catalog: dict, caps: dict) -> set[str]:
    skill_ids = set(caps.get("skill_ids") or [])
    server_ids = set(caps.get("mcp_server_ids") or [])
    packages = set(caps.get("plugin_names") or [])
    return (
        {item["ref"] for item in catalog["skills"] if item["id"] in skill_ids}
        | {item["ref"] for item in catalog["mcp"] if item["id"] in server_ids}
        | {item["ref"] for item in catalog["plugins"] if item["package"] in packages}
    )


def _public(items: list[dict]) -> list[dict]:
    return [
        {key: value for key, value in item.items() if key not in {"_text", "id", "package"}} for item in items
    ]


def _catalog_text(catalog: dict, query: set[str], keep: set[str]) -> str:
    shown = {
        "skills": _public(_shortlist(catalog["skills"], query, CANDIDATE_LIMITS["skills"], keep)),
        "mcp": _public(_shortlist(catalog["mcp"], query, CANDIDATE_LIMITS["mcp"], keep)),
        "plugins": _public(_shortlist(catalog["plugins"], query, CANDIDATE_LIMITS["plugins"], keep)),
    }
    web = catalog["web"]
    web_line = (
        "联网搜索：可用" if web["available"] else f"联网搜索：平台未开启（{web['reason'] or '需管理员配置'}）"
    )
    return json.dumps(shown, ensure_ascii=False, indent=1) + "\n" + web_line


def _draft_text(draft: dict, catalog: dict) -> str:
    caps = draft.get("capabilities") or {}
    refs = _current_refs(catalog, caps)
    plugin_tools = caps.get("plugin_tools") or {}
    selected = {
        "skills": [item["ref"] for item in catalog["skills"] if item["ref"] in refs],
        "mcp": [item["ref"] for item in catalog["mcp"] if item["ref"] in refs],
        "plugins": [
            {"ref": item["ref"], "tools": plugin_tools.get(item["package"], [])}
            for item in catalog["plugins"]
            if item["ref"] in refs
        ],
        "web_search": bool(caps.get("web_search")),
    }
    value = {
        "name": _clip(draft.get("name"), 128),
        "description": _clip(draft.get("description"), 512),
        "icon": draft.get("icon") or "sparkles",
        "prompt": _clip(draft.get("prompt_template"), 6000),
        "capabilities": selected,
    }
    if not any([value["name"], value["description"], value["prompt"], refs, selected["web_search"]]):
        return "（空白，新建场景）"
    return json.dumps(value, ensure_ascii=False, indent=1)


def _picked(value: Any) -> list[dict]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def apply_result(data: dict, draft: dict, catalog: dict, fields: list[str]) -> dict:
    """把模型输出合并进草稿：只采用请求的字段，能力逐项校验后自动勾选。"""
    if not isinstance(data, dict):
        raise ValueError("输出不是 JSON 对象")
    caps_in = dict(draft.get("capabilities") or {})
    result = {
        "name": _clip(draft.get("name"), 128),
        "description": _clip(draft.get("description"), 512),
        "icon": draft.get("icon") if draft.get("icon") in ICONS else "sparkles",
        "prompt_template": str(draft.get("prompt_template") or "")[:16000],
        "capabilities": {
            "plugin_names": list(caps_in.get("plugin_names") or ["forge-runtime"]),
            "plugin_tools": dict(caps_in.get("plugin_tools") or {}),
            "builtin_tool_names": list(caps_in.get("builtin_tool_names") or []),
            "skill_ids": list(caps_in.get("skill_ids") or []),
            "mcp_server_ids": list(caps_in.get("mcp_server_ids") or []),
            "project_ids": list(caps_in.get("project_ids") or []),
            "web_search": bool(caps_in.get("web_search")),
        },
    }
    applied: list[str] = []
    reasons: dict[str, str] = {}
    missing: list[dict] = []
    notices: list[str] = []

    if "name" in fields and _clip(data.get("name"), 128):
        result["name"] = _clip(data.get("name"), 128)
        applied.append("name")
    if "description" in fields and _clip(data.get("description"), 512):
        result["description"] = _clip(data.get("description"), 512)
        applied.append("description")
    if "icon" in fields and data.get("icon") in ICONS:
        result["icon"] = data["icon"]
        applied.append("icon")
    if "prompt" in fields and str(data.get("prompt") or "").strip():
        result["prompt_template"] = str(data["prompt"]).strip()[:16000]
        applied.append("prompt")

    if "capabilities" in fields:
        caps = data.get("capabilities") if isinstance(data.get("capabilities"), dict) else {}
        skills = {item["ref"]: item for item in catalog["skills"]}
        servers = {item["ref"]: item for item in catalog["mcp"]}
        plugins = {item["ref"]: item for item in catalog["plugins"]}
        skill_ids: list[int] = []
        for pick in _picked(caps.get("skills")):
            item = skills.get(str(pick.get("ref")))
            if item and item["id"] not in skill_ids and len(skill_ids) < MAX_SESSION_SKILLS:
                skill_ids.append(item["id"])
                reasons[f"skill:{item['id']}"] = _clip(pick.get("reason"), 80)
        server_ids: list[int] = []
        for pick in _picked(caps.get("mcp")):
            item = servers.get(str(pick.get("ref")))
            if item and item["id"] not in server_ids and len(server_ids) < MAX_SESSION_MCP:
                server_ids.append(item["id"])
                reasons[f"mcp:{item['id']}"] = _clip(pick.get("reason"), 80)
        plugin_names = ["forge-runtime"]
        plugin_tools: dict[str, list[str]] = {}
        bound: set[str] = set()
        for pick in _picked(caps.get("plugins")):
            item = plugins.get(str(pick.get("ref")))
            if not item or item["package"] in plugin_tools:
                continue
            available = [tool["name"] for tool in item["tools"]]
            wanted = pick.get("tools") if isinstance(pick.get("tools"), list) else []
            tools = [name for name in dict.fromkeys(str(x) for x in wanted) if name in available]
            # 没写工具时用该插件全部可用工具；同名工具只能绑定一次
            tools = [name for name in (tools or available) if name not in bound]
            if not tools:
                continue
            bound.update(tools)
            plugin_names.append(item["package"])
            plugin_tools[item["package"]] = tools
            reasons[f"plugin:{item['package']}"] = _clip(pick.get("reason"), 80)
        # 约定格式为 {"enabled": bool, "reason": str}；模型偶尔直接返回 true/false，一并兼容
        raw_web = caps.get("web_search", caps.get("web"))
        web = raw_web if isinstance(raw_web, dict) else {"enabled": raw_web is True}
        web_wanted = bool(web.get("enabled"))
        if web_wanted and catalog["web"]["available"]:
            reasons["web"] = _clip(web.get("reason"), 80)
        elif web_wanted:
            notices.append("建议开启联网搜索，但平台尚未开启；需管理员在治理中心配置后再勾选。")
        result["capabilities"].update(
            skill_ids=skill_ids,
            mcp_server_ids=server_ids,
            plugin_names=plugin_names,
            plugin_tools=plugin_tools,
            web_search=web_wanted and catalog["web"]["available"],
        )
        applied.append("capabilities")
        for item in _picked(data.get("missing"))[:MAX_MISSING]:
            name = _clip(item.get("name"), 40)
            if name:
                missing.append({"name": name, "reason": _clip(item.get("reason"), 120)})

    if not applied:
        raise ValueError("没有生成任何需要的字段")
    return {"draft": result, "applied": applied, "reasons": reasons, "missing": missing, "notices": notices}


async def generate(db: AsyncSession, req: GenerateScenarioRequest, space_id: int | None) -> dict:
    draft = req.draft or {}
    fields = [name for name in GENERATE_FIELDS if name in (req.fields or GENERATE_FIELDS)]
    if not req.requirement.strip() and not any(
        str(draft.get(key) or "").strip() for key in ("name", "description", "prompt_template")
    ):
        raise HTTPException(422, "请先用一句话描述想要的场景，或填写场景名称、介绍、提示词中的任意一项")
    catalog = await build_catalog(db, space_id)
    requirement = req.requirement.strip()
    query = _grams(" ".join([requirement, str(draft.get("name") or ""), str(draft.get("description") or "")]))
    keep = _current_refs(catalog, draft.get("capabilities") or {})
    variables = {
        "icons": "、".join(ICONS),
        "fields": "、".join(FIELD_LABELS[name] for name in fields),
        "requirement": requirement or "（未填写，请参考当前草稿）",
        "draft": _draft_text(draft, catalog),
        "catalog": _catalog_text(catalog, query, keep),
    }
    output, result = await llm_service.run_task(
        db,
        "scenario.generate",
        variables,
        model_id=req.modelId,
        validate=lambda data: apply_result(data, draft, catalog, fields),
    )
    return {**output, "model": result.model, "usage": result.usage, "latencyMs": result.latency_ms}
