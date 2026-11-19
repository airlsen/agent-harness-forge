#!/usr/bin/env bash
# 正式业务入口，同时服务 frontend/dist；模型密钥不经环境/启动日志输出。
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
if [[ "${FORGE_EMBEDDED_PREVIEW:-0}" == "1" ]]; then
  export FORGE_COOKIE_SECURE=true FORGE_COOKIE_SAMESITE=none FORGE_COOKIE_PARTITIONED=true
  export FORGE_PREVIEW_HEADER_AUTH=true
fi
# 前端产物缺失或源码比产物新时自动重新打包；FORGE_SKIP_FRONTEND_BUILD=1 可跳过。
if [[ "${FORGE_SKIP_FRONTEND_BUILD:-0}" != "1" ]]; then
  src_newer="$(find "$ROOT/frontend/src" -newer "$ROOT/frontend/dist/index.html" -print 2>/dev/null | head -n1)"
  if [[ ! -f "$ROOT/frontend/dist/index.html" || -n "$src_newer" ]]; then
    echo "前端产物缺失或源码已更新，重新打包 frontend..." >&2
    npm --prefix "$ROOT/frontend" run build
  fi
fi
kill_port "${FORGE_API_PORT:-5173}"
cd "$ROOT/backend"
exec "${PYTHON:-python3}" -m uvicorn src.api.main:app --host 0.0.0.0 --port "${FORGE_API_PORT:-5173}"
