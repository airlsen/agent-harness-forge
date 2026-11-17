.PHONY: dev-backend dev-runner dev-frontend lint test

dev-backend:        ## 启动控制面（FastAPI, :8000）
	cd backend && uvicorn src.api.main:app --reload --port 8000

dev-runner:         ## 启动执行内核适配层（tsx watch, :9000）
	pnpm -C runner dev

dev-frontend:       ## 启动前端（vite, :5173）
	pnpm -C frontend dev

lint:               ## 全仓 lint
	cd backend && ruff check src || true
	pnpm -C runner lint || true
	pnpm -C frontend lint || true

test:               ## 全仓测试
	cd backend && pytest -q || true
	pnpm -C runner test || true
