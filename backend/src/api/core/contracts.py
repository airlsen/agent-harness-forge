"""控制面与 Runner 共用的平台契约（仓库根目录 contracts/platform.json，唯一来源）。

内置工具目录与能力上限只在契约文件里维护一份：控制面据此展示与校验，Runner 据此装配与限额，
两端不再各自手抄。带 follows 的附属工具（如修改 edit、交付声明 present）随被跟随的工具一同开放，
不在平台策略中单独管控，但名称同样保留给平台。
renamed 记录已下线的旧工具名 → 新名（空串表示能力已由运行时自动提供），读取旧数据时据此换新。
"""

import json
from functools import lru_cache

from .config import ROOT

PLATFORM_CONTRACT = ROOT / "contracts" / "platform.json"
# 对外（治理中心、场景编辑器）展示的工具字段；group / provider 只供 Runner 装配与契约检查使用
TOOL_FIELDS = ("name", "title", "description", "permission", "icon")


@lru_cache
def platform_contract() -> dict:
    data = json.loads(PLATFORM_CONTRACT.read_text(encoding="utf-8"))
    tools = data.get("tools")
    if not isinstance(tools, list) or not tools:
        raise RuntimeError(f"平台契约缺少工具目录：{PLATFORM_CONTRACT}")
    for tool in tools:
        missing = [field for field in (*TOOL_FIELDS, "group", "provider") if not tool.get(field)]
        if missing:
            raise RuntimeError(f"平台契约中的工具 {tool.get('name')!r} 缺少字段：{', '.join(missing)}")
    return data


def builtin_tools() -> list[dict]:
    """平台策略可管控的内置工具（展示字段，不含附属工具）。"""
    tools = platform_contract()["tools"]
    return [{field: tool[field] for field in TOOL_FIELDS} for tool in tools if not tool.get("follows")]


def platform_tool_names() -> set[str]:
    """平台保留的全部工具名（含附属工具与已下线的旧名）：受管插件的工具不得与之重名。"""
    return {tool["name"] for tool in platform_contract()["tools"]} | set(renamed_tools())


def renamed_tools() -> dict[str, str]:
    """已下线的旧工具名 → 新名（空串表示能力已由运行时自动提供、不再是工具）。"""
    renamed = platform_contract().get("renamed") or {}
    if not isinstance(renamed, dict):
        raise TypeError(f"平台契约的 renamed 应为对象：{PLATFORM_CONTRACT}")
    return renamed


def canonical_tools(names) -> list[str]:
    """工具名换成当前名称：旧名按 renamed 换新、已由运行时提供的去掉，其余原样保留；去重并保持顺序。"""
    renamed = renamed_tools()
    out = [renamed.get(name, name) if isinstance(name, str) else name for name in names or []]
    return list(dict.fromkeys(name for name in out if name))


def limit(name: str) -> int:
    """读取契约中的能力上限（缺失时直接报错，避免两端悄悄不一致）。"""
    value = platform_contract().get("limits", {}).get(name)
    if not isinstance(value, int) or value <= 0:
        raise RuntimeError(f"平台契约缺少上限 {name}")
    return value
