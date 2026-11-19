#!/usr/bin/env bash
# 前后端分离开发启动：三个进程各司其职，端口被占用时先杀掉旧进程再启动。
#   Runner  :9000 —— 执行内核（tsx watch，改 TS 自动重启），只服务 Runner
#   控制面  :8000 —— 只跑 FastAPI API（uvicorn --reload，改 Python 自动重启），不再服务前端静态文件
#   前端    :5173 —— 只跑 Vite dev server（HMR 热更），/api 经 proxy 转发到 :8000
# 用法：bash scripts/dev.sh   （Ctrl+C 一次性停掉全部）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${FORGE_ENV_FILE:-$ROOT/data/business.env}"

# 三个端口相互耦合（backend 的 runner_endpoints 默认指向 :9000、callback_base_url 默认 :8000、
# vite proxy 指向 :8000），如非必要请保持默认值。
RUNNER_PORT="${FORGE_RUNNER_PORT:-9000}"
BACKEND_PORT="${FORGE_DEV_BACKEND_PORT:-8000}"
FRONTEND_PORT="${FORGE_DEV_FRONTEND_PORT:-5173}"

PYTHON="${PYTHON:-python3}"
# 重启工具不会继承先前 shell 的 PATH；优先使用本沙箱安装的新版 Node。
NODE_BIN="${FORGE_NODE_BIN:-node}"
if [[ -z "${FORGE_NODE_BIN:-}" && -x "$HOME/.local/node/bin/node" ]]; then
  NODE_BIN="$HOME/.local/node/bin/node"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "请先运行 python3 scripts/setup-sandbox.py 生成 $ENV_FILE" >&2
  exit 1
fi
"$NODE_BIN" -e 'const [m,n]=process.versions.node.split(".").map(Number); if(m<24||(m===24&&n<9)){console.error("Forge Runner 需要 Node >=24.9.0；请设置 FORGE_NODE_BIN 或安装新版 Node"); process.exit(1);}'

# 端口被占用时自动结束旧进程再重启，避免人工清理。
# 先 SIGTERM 优雅退出，超时再 SIGKILL；找不到 lsof 时跳过（不阻断启动）。
kill_port() {
  local port="$1" pid pids targets=()
  if ! command -v lsof >/dev/null 2>&1; then
    echo "未找到 lsof，跳过端口 $port 清理" >&2
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
  kill -CONT "${targets[@]}" 2>/dev/null || true
  kill "${targets[@]}" 2>/dev/null || true
  local i
  for i in {1..25}; do
    [[ -z "$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null || true)" ]] && return 0
    sleep 0.2
  done
  echo "端口 $port 旧进程未在限时内退出，强制结束..." >&2
  kill -9 "${targets[@]}" 2>/dev/null || true
  for i in {1..25}; do
    [[ -z "$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null || true)" ]] && return 0
    sleep 0.2
  done
  echo "端口 $port 仍被占用，无法启动。" >&2
  return 1
}

for p in "$RUNNER_PORT" "$BACKEND_PORT" "$FRONTEND_PORT"; do
  kill_port "$p"
done

PIDS=()
cleanup() {
  echo "" >&2
  echo "正在停止开发进程..." >&2
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

# 1) Runner —— 执行内核，只服务 Runner（:9000）
(
  set -a; . "$ENV_FILE"; set +a
  export PORT="$RUNNER_PORT"
  cd "$ROOT/runner"
  exec "$NODE_BIN" node_modules/.bin/tsx watch src/server.ts
) &
PIDS+=("$!")
echo "Runner     → http://127.0.0.1:$RUNNER_PORT  (tsx watch)"

# 2) 控制面 —— 只跑 API（:8000），不服务前端
(
  set -a; . "$ENV_FILE"; set +a
  cd "$ROOT/backend"
  exec "$PYTHON" -m uvicorn src.api.main:app --reload --host 0.0.0.0 --port "$BACKEND_PORT"
) &
PIDS+=("$!")
echo "控制面 API → http://127.0.0.1:$BACKEND_PORT  (uvicorn --reload)"

# 3) 前端 —— 只跑 Vite dev server（:5173），/api 经 proxy 转发到控制面
(
  cd "$ROOT/frontend"
  exec "$NODE_BIN" node_modules/.bin/vite --port "$FRONTEND_PORT"
) &
PIDS+=("$!")
echo "前端 Vite  → http://localhost:$FRONTEND_PORT  (HMR)"

echo ""
echo "浏览器访问 http://localhost:$FRONTEND_PORT"
echo "Ctrl+C 停止全部进程"
echo ""

wait
