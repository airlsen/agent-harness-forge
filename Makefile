.PHONY: install setup build serve runner dev-backend dev-runner dev-frontend typecheck lint test

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
	frontend/node_modules/.bin/prettier --check runner/src runner/forge-runtime-plugin runner/scripts/check-business.mjs runner/scripts/check-workspace.mjs scripts/check-ui-icons.mjs .github/workflows/checks.yml

test: ## 不吞错误；草稿状态单测与隔离协议夹具，不消耗真实模型
	npm --prefix frontend test
	npm --prefix runner run contract
	npm --prefix runner test
	python3 scripts/check-preview-auth.py
	python3 scripts/check-business-api.py
