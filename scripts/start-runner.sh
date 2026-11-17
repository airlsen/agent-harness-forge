#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${FORGE_ENV_FILE:-$ROOT/data/business.env}"
if [[ ! -f "$ENV_FILE" ]]; then echo "请先运行 python3 scripts/setup-sandbox.py" >&2; exit 1; fi
set -a
. "$ENV_FILE"
set +a
# 重启工具不会继承先前 shell 的 PATH；优先使用本沙箱安装的新版 Node。
# 其他部署可显式设置 FORGE_NODE_BIN=/path/to/node。
NODE_BIN="${FORGE_NODE_BIN:-node}"
if [[ -z "${FORGE_NODE_BIN:-}" && -x "$HOME/.local/node/bin/node" ]]; then
  NODE_BIN="$HOME/.local/node/bin/node"
fi
"$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 9)) { console.error("Forge Runner 需要 Node >=24.9.0；请设置 FORGE_NODE_BIN 或安装新版 Node"); process.exit(1); }'
cd "$ROOT/runner"
exec "$NODE_BIN" --import tsx src/server.ts
