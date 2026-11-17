# AgentHarness Forge

基于 **DeepSeek Harness（dsh）插件架构**的 Agent 工作空间。模型是可替换的出口；场景、工具边界、执行记录属于平台。

> **当前交付：v0.2 单工作空间业务版 / 沙箱部署。** 已实现下表中的业务闭环，不是原生 `dsh web`，也不是 M0 固定脚本验证面板。`docs/01`–`04` 是目标设计，不应当作已全部实现的功能清单。

## 当前可以使用

| 模块 | 本版实现 |
|---|---|
| 登录与导航 | 本地管理员、HttpOnly Cookie 优先、CSRF；预览 Cookie 被阻断时使用 1 小时标签页兼容会话 |
| Agent 工作台 | 场景选择、自由文本任务、Markdown / SSE、最近会话、文本附件、中止 |
| 场景中心 | 4 个官方只读模板；个人场景创建 / 复制 / 编辑 / 软删除、不可变版本、模型试运行与发布门槛 |
| 能力中心 | 实际安装的 dsh / Forge Runtime 组件与 4 个工具；Skill / MCP 明确标记尚未接入 |
| 模型中心 | OpenAI-compatible Chat Completions Base URL、模型 ID、加密密钥、真实 HTTP 连接测试、可选价格 |
| 治理 | 场景授权与平台白名单取交集、写入逐次审批、审批超时拒绝、输出 / 请求限额 |
| 轨迹与产物 | 数据库持久化消息和原始事件、只读查看 / 筛选 / 导出、工作区文本文件预览下载 |

**没有配置模型时明确显示「模型未配置」，不使用假模型或固定脚本代替业务执行。** 自动化测试使用独立的协议夹具；不会把夹具连接写进用户工作空间。

## 运行结构

```text
浏览器 :5173 ── Vue 构建产物 + 同源 /api（FastAPI）
                         │ 内部 Bearer Token
                         ▼
                    Runner :9000
                         │ 每会话独立 dsh sdk-minimal 进程
                         ▼
             forge-runtime 插件（模型适配器 / 工具 / 门控）
                         │
                         ▼
                 用户配置的真实模型服务
```

- 不 fork dsh；版本固定为 `@deepseek-ai/dsh@0.2.2-rc.1`。
- 会话锁定场景版本、策略、模型和价格；模型凭据的加密快照不进入 Bundle / 导出接口。
- 工具仅有 `current_time`、`workspace_list`、`workspace_read`、`workspace_write`。不开放任意 Shell / 外部网络工具 / 外部插件安装。
- 默认 SQLite（WAL），本地工作区；**不是容器级安全沙箱，不具备多租户生产隔离**。

## 快速开始

需要 **Node >= 24.9.0、Python >= 3.12**。沙箱实测 Node 26.13.1 / Python 3.13。安装依赖与运行进程不保证跨沙箱恢复保留。

```bash
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -e 'backend[dev]'
npm --prefix runner ci
npm --prefix frontend ci
python3 scripts/setup-sandbox.py
make build

# 终端 1：正式 Runner
bash scripts/start-runner.sh

# 终端 2：正式前后端，同源 :5173
bash scripts/start-api.sh
```

管理员凭据保存在 **`data/admin-login.txt`**（0600）；内部通信配置在 `data/business.env`（0600）。初始化脚本不输出密码，重复执行不覆盖。`data/`、Runner 数据、密钥和数据库全部被 Git 忽略，勿手动强制加入版本库。

登录后进入「模型中心」填写自己的 Base URL、模型 ID、API Key → 保存 → 测试连接 → 返回工作台。测试和真实执行会消耗你配置的服务额度。修改模型 / 价格 / 策略只影响新会话。

### 开发与测试

```bash
make dev-runner     # 正式业务 Runner，:9000
make dev-backend    # API 开发服务，:8000
make dev-frontend   # Vite，:5173；相对 /api 代理至 :8000

make typecheck
make lint
make test           # 契约 + 隔离 Runner/API 测试；不请求外部模型

# 可选浏览器回归
python3 -m playwright install --with-deps chromium
python3 scripts/check-business-api.py --browser   # 临时隔离业务栈的执行 UI
python3 scripts/check-business-ui.py              # 当前无模型部署的实际页面（临时创建/删除测试场景）
python3 scripts/check-iframe-auth.py              # 本地双 TLS 域 Cookie 登录
python3 scripts/check-iframe-auth.py --block-cookies  # 强制剥离全部 Cookie 的预览登录
python3 scripts/check-business-api.py --browser --cookie-blocked  # 无 Cookie 的完整执行 UI

# 历史 M0：只验证插件拦截，不等于产品验收
npm --prefix runner run poc
```

## 仓库导航

```text
backend/src/api/             正式控制面、认证、场景/会话/审批/审计 API
runner/src/kernel/          AgentKernel 与 dsh JSON-RPC 适配
runner/forge-runtime-plugin 正式模型出口和受限工具插件
runner/forge-poc-plugin/     历史 M0 安全探针（非业务运行）
frontend/src/               Vue Router / Pinia / 七个业务页面
scripts/                    初始化、启动、隔离集成与浏览器回归
.github/workflows/          构建与隔离测试工作流（须推送后才会执行）
docs/01–04                  目标产品与架构设计
docs/05                     历史 M0 验证报告
docs/06                     当前部署、恢复和安全边界
docs/07                     本次业务版代码与验收清单
```

## 明确未完成

OIDC / 企业 RBAC / 多租户与团队空间；Skill / MCP / 项目 / 知识库挂载；AI Creative 场景生成；结构化输入表单；原生 fork / 执行分叉；跨 Runner 重启的会话执行恢复；生产容器隔离、S3 / WORM / SIEM、Redis 调度、数据库迁移和 20 会话压测。

已存储事件的只读查看 **不等于重新执行或原生 fork/replay**。Runner 重启后可以读取仍在本地磁盘上的历史产物，但继续执行需创建新会话。沙箱会休眠，不是长期在线的生产托管。

详见 [部署说明](docs/06-沙箱预览部署.md) 与 [业务验收](docs/07-业务版实现与验收.md)。
