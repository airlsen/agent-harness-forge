# Forge Control Plane · FastAPI

正式入口 `src.api.main:app`。本版支持本地账号注册和登录，资源仍为单工作空间共享，默认单 worker；尚无多租户 OIDC/RBAC。

核心：数据库持久化可撤销登录会话和 CSRF、SQLite 持久化、场景版本和 Bundle 装配、模型密钥加密、后台执行泵、审批工单、SSE / 只读轨迹 / 导出、构建后的 Vue SPA 静态服务。

```bash
# 仓库根目录
python3 -m pip install -e 'backend[dev]'
python3 scripts/setup-sandbox.py
make build
bash scripts/start-api.sh       # 正式同源前后端 :5173
# 另一个终端 bash scripts/start-runner.sh

make dev-backend                # API 开发 :8000，需配套 Vite
```

- 业务配置默认在 `data/business.env`，启动脚本自动加载。没有内部 Token 或初始化认证文件时拒绝启动。
- 首次启动把原 `data/auth.json` 管理员密码摘要迁入账号表；旧浏览器 Cookie 需重新登录。注册默认开启，可通过 `FORGE_REGISTRATION_ENABLED=false` 关闭。配置 `FORGE_REGISTRATION_REQUIRE_EMAIL_VERIFICATION=true` 时，还需配置 `FORGE_SMTP_HOST`、`FORGE_SMTP_FROM`、`FORGE_PUBLIC_BASE_URL`；可用 `FORGE_REGISTRATION_EMAIL_DOMAINS` 限制邮箱域名。具体变量见 `.env.example`。
- 新账号仅有独立登录身份；会话、空间、技能、模型配置等仍共享，尚不适合对不互信的用户开放注册。
- 模型通过登录后的模型中心管理；列表与详情不回传原文密钥，管理员编辑时点击查看才单独取回；不进入可导出的 Bundle。
- 普通部署默认只用 HttpOnly Cookie；`FORGE_PREVIEW_HEADER_AUTH=true` 额外开启短时 Header 兼容认证。仍校验密码和 CSRF；数据库只存令牌摘要，退出 / 1 小时到期后失效。不是生产 OIDC，不能视为 HttpOnly 会话。
- 后台任务 / 会话锁仍在单进程，不要开启多个 uvicorn worker。
- SQLite `create_all` 尚不是数据库迁移体系，PostgreSQL override 尚未实测。
- Redis、S3、OIDC、企业 RBAC、WORM 尚未接入。

验收命令：`python3 scripts/check-business-api.py`；可加 `--browser` 启动隔离的完整执行 UI 检查。所有协议夹具为测试专用，不是业务假模型。

完整部署与恢复语义见 `docs/06-沙箱预览部署.md`。
