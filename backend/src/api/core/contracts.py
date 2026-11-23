"""控制面与 Runner 共用的平台契约（仓库根目录 contracts/platform.json，唯一来源）。

内置工具目录（平台策略可管控的工具）与能力上限只在契约文件里维护一份：
控制面据此展示与校验，Runner 据此装配与限额，两端不再各自手抄。
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
    """平台策略可管控的内置工具（展示字段）。"""
    return [{field: tool[field] for field in TOOL_FIELDS} for tool in platform_contract()["tools"]]


def limit(name: str) -> int:
    """读取契约中的能力上限（缺失时直接报错，避免两端悄悄不一致）。"""
    value = platform_contract().get("limits", {}).get(name)
    if not isinstance(value, int) or value <= 0:
        raise RuntimeError(f"平台契约缺少上限 {name}")
    return value
