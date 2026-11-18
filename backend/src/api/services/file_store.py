"""会话文件内容仓库：按 SHA-256 存放在服务端磁盘，同一内容只存一份。"""

import hashlib
import os
import re
import tempfile
from pathlib import Path

from ..core.config import settings

SHA256 = re.compile(r"^[0-9a-f]{64}$")


class FileStore:
    def __init__(self, root: Path | None = None):
        self._root = root

    @property
    def root(self) -> Path:
        root = self._root or settings.file_store_dir or settings.data_dir / "session-files"
        return Path(root) / "objects"

    def path(self, sha: str) -> Path:
        if not SHA256.match(sha):
            raise ValueError("无效的内容哈希")
        return self.root / sha[:2] / sha

    def put(self, data: bytes) -> str:
        """写入内容并返回其 SHA-256；已存在时直接复用。先写临时文件再原子改名，避免半截文件。"""
        sha = hashlib.sha256(data).hexdigest()
        target = self.path(sha)
        if target.exists():
            return sha
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(dir=target.parent, prefix=".tmp-")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise
        return sha

    def get(self, sha: str) -> bytes:
        return self.path(sha).read_bytes()

    def exists(self, sha: str) -> bool:
        return bool(sha) and self.path(sha).exists()

    def delete(self, sha: str) -> int:
        """删除一份内容，返回释放的字节数。"""
        target = self.path(sha)
        try:
            size = target.stat().st_size
            target.unlink()
            return size
        except FileNotFoundError:
            return 0

    def all(self) -> list[tuple[str, int, float]]:
        """列出全部内容：(哈希, 字节数, 修改时间)。"""
        if not self.root.exists():
            return []
        out = []
        for item in self.root.glob("??/*"):
            if item.is_file() and SHA256.match(item.name):
                stat = item.stat()
                out.append((item.name, stat.st_size, stat.st_mtime))
        return out


file_store = FileStore()
