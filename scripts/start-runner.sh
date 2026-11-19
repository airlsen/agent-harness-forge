#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${FORGE_ENV_FILE:-$ROOT/data/business.env}"
if [[ ! -f "$ENV_FILE" ]]; then echo "请先运行 python3 scripts/setup-sandbox.py" >&2; exit 1; fi
set -a
. "$ENV_FILE"
set +a
# 端口被占用时自动结束旧进程再重启，避免人工清理。
# 先 SIGTERM 优雅退出，超时再 SIGKILL；找不到 lsof 时跳过（不阻断启动）。
kill_port() {
  local port="$1" pid pids targets=()
  if ! command -v lsof >/dev/null 2>&1; then
    echo "未找到 lsof，跳过端口清理" >&2
    return 0
  fi
  pids="$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0
  for pid in $pids; do
    [[ "$pid" == "$$" ]] && continue
    targets+=("$pid")
  done
  [[ ${#targets[@]} -eq 0 ]] && return 0
  echo "端口 $port 已被占用（PID: ${targets[*]}），结束旧进程后重启..." >&2
  # 先唤醒可能被 Ctrl+Z 挂起的进程，否则 SIGTERM 无法被处理。
  kill -CONT "${targets[@]}" 2>/dev/null || true
  kill "${targets[@]}" 2>/dev/null || true
  local i
  for i in {1..25}; do
    [[ -z "$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null || true)" ]] && return 0
    sleep 0.2
  done
  echo "旧进程未在限时内退出，强制结束..." >&2
  kill -9 "${targets[@]}" 2>/dev/null || true
  for i in {1..25}; do
    [[ -z "$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null || true)" ]] && return 0
    sleep 0.2
  done
  echo "端口 $port 仍被占用，无法启动。" >&2
  return 1
}
# 重启工具不会继承先前 shell 的 PATH；优先使用本沙箱安装的新版 Node。
# 其他部署可显式设置 FORGE_NODE_BIN=/path/to/node。
NODE_BIN="${FORGE_NODE_BIN:-node}"
if [[ -z "${FORGE_NODE_BIN:-}" && -x "$HOME/.local/node/bin/node" ]]; then
  NODE_BIN="$HOME/.local/node/bin/node"
fi
"$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 9)) { console.error("Forge Runner 需要 Node >=24.9.0；请设置 FORGE_NODE_BIN 或安装新版 Node"); process.exit(1); }'
kill_port "${PORT:-9000}"
cd "$ROOT/runner"
exec "$NODE_BIN" --import tsx src/server.ts
