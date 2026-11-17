#!/usr/bin/env bash
# 正式业务入口，同时服务 frontend/dist；模型密钥不经环境/启动日志输出。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${FORGE_ENV_FILE:-$ROOT/data/business.env}"
if [[ ! -f "$ENV_FILE" ]]; then echo "请先运行 python3 scripts/setup-sandbox.py" >&2; exit 1; fi
set -a
. "$ENV_FILE"
set +a
if [[ "${FORGE_EMBEDDED_PREVIEW:-0}" == "1" ]]; then
  export FORGE_COOKIE_SECURE=true FORGE_COOKIE_SAMESITE=none FORGE_COOKIE_PARTITIONED=true
fi
if [[ ! -f "$ROOT/frontend/dist/index.html" ]]; then echo "请先运行 npm --prefix frontend run build" >&2; exit 1; fi
cd "$ROOT/backend"
exec "${PYTHON:-python3}" -m uvicorn src.api.main:app --host 0.0.0.0 --port "${FORGE_API_PORT:-5173}"
