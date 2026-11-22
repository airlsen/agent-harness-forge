"""Skill 文件清单：SKILL.md 之外的 references/、assets/、scripts/ 文件。

修订表的 reference_files（JSON）保存文件清单，每条记录：
    {"path": "references/rules.md", "storage": "skills/5/files/c3d4-rules.md", "bytes": 1200, "source": "agent"}
- path：Skill 包内的相对路径（一层目录 + 文件名），导出、运行时目录与助手工具都使用它；
- storage：相对 data_dir 的磁盘位置。磁盘文件只写不改，删除只从清单移除，各修订与发布快照互不影响。

早期只有参考资料，记录为 {"filename", "path"(=磁盘位置), "bytes"}；读取时统一转换，不做数据库迁移。
"""

import re
from pathlib import Path

FILE_DIRS: dict[str, frozenset[str]] = {
    "references": frozenset({".md", ".txt"}),
    "assets": frozenset({".md", ".txt", ".json", ".csv", ".yaml", ".yml", ".html"}),
    "scripts": frozenset({".py", ".js", ".sh"}),
}
FILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}")
MAX_FILE_BYTES = 120_000
MAX_FILES = 20
MAX_TOTAL_BYTES = 512_000
SOURCES = {"manual", "agent", "restore"}


def validate_file_path(path: str) -> str:
    """校验并返回规范化的包内路径；不合规时抛出带中文说明的 ValueError。"""
    value = str(path or "").strip()
    if value == "SKILL.md":
        raise ValueError("SKILL.md 是主文档，请直接编辑主文档")
    parts = value.split("/")
    if "\\" in value or len(parts) != 2 or not all(parts):
        raise ValueError("文件路径应为“目录/文件名”，例如 references/rules.md")
    folder, name = parts
    if folder not in FILE_DIRS:
        raise ValueError("文件只能放在 references/、assets/ 或 scripts/ 目录")
    if not FILE_NAME.fullmatch(name):
        raise ValueError(
            "文件名只能使用英文字母、数字、点、下划线和短横线，以字母或数字开头，最长 120 个字符"
        )
    suffix = Path(name).suffix.lower()
    if suffix not in FILE_DIRS[folder]:
        allowed = "、".join(sorted(FILE_DIRS[folder]))
        raise ValueError(f"{folder}/ 只支持 {allowed} 文件")
    return f"{folder}/{name}"


def normalize_entry(entry: object) -> dict | None:
    """把新旧两种记录统一为 {path, storage, bytes, source}；无法识别的记录返回 None。"""
    if not isinstance(entry, dict):
        return None
    if "storage" in entry:
        path, storage = entry.get("path"), entry.get("storage")
    else:  # 早期参考资料：path 是磁盘位置，包内路径由文件名推出
        filename = Path(str(entry.get("filename") or "")).name
        path, storage = (f"references/{filename}" if filename else None), entry.get("path")
    if not isinstance(path, str) or not path or not isinstance(storage, str) or not storage:
        return None
    source = entry.get("source")
    return {
        "path": path,
        "storage": storage,
        "bytes": int(entry.get("bytes") or 0),
        "source": source if source in SOURCES else "manual",
    }


def skill_files(entries: list | None) -> list[dict]:
    """修订的文件清单（规范化、按路径去重，同名以后出现的为准，保留首次出现的顺序）。"""
    files: dict[str, dict] = {}
    for entry in entries or []:
        normalized = normalize_entry(entry)
        if normalized:
            files[normalized["path"]] = normalized
    return list(files.values())


def file_view(entry: dict) -> dict:
    return {"path": entry["path"], "bytes": entry["bytes"], "source": entry["source"]}


def check_capacity(files: list[dict]) -> None:
    if len(files) > MAX_FILES:
        raise ValueError(f"每个 Skill 最多 {MAX_FILES} 个附加文件")
    if sum(item["bytes"] for item in files) > MAX_TOTAL_BYTES:
        raise ValueError(f"附加文件合计不能超过 {MAX_TOTAL_BYTES // 1000} KB")


def storage_path(data_dir: Path, skill_id: int, entry: dict) -> Path:
    """磁盘位置必须落在该 Skill 自己的目录内，防止清单被篡改后读到其他文件。"""
    root = (data_dir / "skills" / str(skill_id)).resolve()
    path = (data_dir / entry["storage"]).resolve()
    if not path.is_relative_to(root):
        raise ValueError("文件位置无效")
    return path


def read_entry(data_dir: Path, skill_id: int, entry: dict) -> str:
    """按字节读取并解码：不做换行转换（read_text 会把 \\r\\n 变成 \\n），保证运行时快照与导出逐字节一致。"""
    return storage_path(data_dir, skill_id, entry).read_bytes().decode("utf-8")
