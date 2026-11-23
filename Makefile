.PHONY: install setup build serve runner dev dev-backend dev-runner dev-frontend typecheck lint test contracts

install:
	python3 -m pip install -e 'backend[dev]'
	npm --prefix runner ci
	npm --prefix frontend ci

setup:
	python3 scripts/setup-sandbox.py

build:
	npm --prefix runner run build
	npm --prefix frontend run build
	python3 -m compileall -q backend/src

serve:  ## 已构建的 Vue + 正式 FastAPI，默认 :5173
	bash scripts/start-api.sh

runner: ## 正式 Harness Runner，默认 :9000
	bash scripts/start-runner.sh

dev: ## 前后端分离开发：一键启动 Runner + 控制面 + Vite（端口占用自动清理）
	bash scripts/dev.sh

dev-backend: ## 开发模式控制面 :8000；需先初始化账号
	set -a; . ./data/business.env; set +a; cd backend && python3 -m uvicorn src.api.main:app --reload --host 0.0.0.0 --port 8000

dev-runner:
	set -a; . ./data/business.env; set +a; cd runner && npm run dev

dev-frontend:
	npm --prefix frontend run dev

typecheck:
	python3 -m compileall -q backend/src
	npm --prefix runner run typecheck
	npm --prefix frontend run typecheck

lint:
	python3 -m ruff check --select F,E9 backend/src scripts
	python3 -m ruff format --check backend/src scripts
	npm --prefix frontend run format:check
	npm --prefix frontend run check:icons
	npm --prefix frontend run check:colors
	npm --prefix frontend run check:fonts
	npm --prefix frontend run check:antd-tokens
	frontend/node_modules/.bin/prettier --check runner/src runner/forge-runtime-plugin runner/plugin-kit runner/scripts/check-wiring.mjs runner/scripts/check-business.mjs runner/scripts/check-code-projects.mjs runner/scripts/check-workspace.mjs scripts/check-ui-icons.mjs scripts/check-ui-colors.mjs scripts/check-ui-font-sizes.mjs scripts/check-antd-tokens.mjs .github/workflows/checks.yml

contracts: ## 会话清单：由控制面 Pydantic 模型导出 JSON Schema，再生成 Runner 的 TypeScript 类型
	cd backend && python3 -m src.api.core.manifest
	npm --prefix runner run gen:manifest

test: ## 不吞错误；草稿状态单测与隔离协议夹具，不消耗真实模型
	cd backend && python3 -m src.api.core.manifest --check
	npm --prefix frontend test
	npm --prefix runner run contract
	npm --prefix runner test
	python3 scripts/check-preview-auth.py
	python3 scripts/check-business-api.py
