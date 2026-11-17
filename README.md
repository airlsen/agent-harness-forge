# AgentHarness Forge

> **企业级 Agent 运行与治理平台** —— 基于 DeepSeek Harness（dsh, MIT）插件化底座构建。
> Agent = Model + Harness。模型是可替换的耗材，Harness 与企业治理是资产。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Backend](https://img.shields.io/badge/backend-FastAPI%20%C2%B7%20Python%203.12-009688)](backend/)
[![Runner](https://img.shields.io/badge/runner-dsh%20%C2%B7%20Cordis%20%C2%B7%20TypeScript-3178c6)](runner/)
[![Frontend](https://img.shields.io/badge/frontend-Vue3%20%C2%B7%20Vite%20%C2%B7%20ElementPlus-42b883)](frontend/)

## 这是什么

面向企业的多租户 Agent 平台（ 数字员工运行与治理平台 ）：
业务人员用**场景**干活，开发者用**插件/技能**扩展，管理员用**审计与策略**兜底。
底座为 DeepSeek Harness —— everything-is-a-plugin（Cordis），模型无关，DeepSeek 模型一等公民，可完全私有化。

## 仓库结构（monorepo）

```
agent-harness-forge/
├── docs/                  # 产品与技术方案（先读这里）
│   ├── 01-产品方案.md      # 定位 / 角色 / 功能地图 / 版本规划
│   ├── 02-技术方案.md      # 三平面架构 / ADR / 插件清单 / 数据模型 / 风险
│   ├── 03-后端架构分析.md   # backend(FastAPI) + runner(TS) 拆解
│   └── 04-前端架构分析.md   # Vue3 平移策略与组件设计
├── backend/               # 控制面：FastAPI · 租户/RBAC/场景装配/调度/审计/配额
├── runner/                # 执行内核适配层：TS · AgentKernel 端口 + dsh 实现 + 平台插件
├── frontend/              # 工作台 + 场景中心 + 治理/审计界面（Vue3）
└── Makefile               # 常用开发命令
```

## 三条架构铁律（摘自 02-技术方案）

1. **永不 fork dsh** —— 企业能力 = Cordis 插件 + profile patch；dsh 版本 pin + 插件契约测试进 CI。
2. **场景 = Bundle（不可变快照）** —— 会话启动即锁定装配版本，审计可复现。
3. **Session Log 是唯一事实源** —— 审计、回放、计量、评测全部从 append-only 事件流生长。

## 快速开始（开发）

```bash
make dev-backend    # uvicorn backend/src/api/main.py:app --reload (Python 3.12)
make dev-runner     # pnpm -C runner dev (tsx watch，需 Node 20+)
make dev-frontend   # pnpm -C frontend dev (vite)
```

依赖：PostgreSQL 16 · Redis 7 · MinIO(S3) ·（P1）Kafka。dsh 以开发者预览版接入：`npx @deepseek-ai/dsh web` 可先本地体验内核行为。

## 路线图

- **M0（2w）技术验证**：dsh 深读 POC · 3 个刺探插件 · headless 嵌入 · 压测
- **M1–M3（8w）MVP**：工作台 / 场景中心 / 治理 / 审计最小闭环
- **V1**：团队空间与上架 · 版本化 · 知识库 · 定时任务 · 插件市场
- **V2**：PTC 批量产品化 · 多 Agent 编排 · replay 评测驱动优化
