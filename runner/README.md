# runner/ · 执行内核适配层（TS）

AgentKernel 端口（`src/kernel/types.ts`）+ dsh 实现 + 平台 Cordis 插件包（`src/plugins/`）。
与控制面（backend/）的通信只有 HTTP 契约；**禁止把 cordis/dsh 类型泄漏给控制面**。

## 开发

```bash
pnpm install
pnpm dev          # tsx watch，:9000
pnpm test:contract  # dsh 插件 API 契约测试（升级 dsh 版本必跑，ADR-1 风险阀门）
```

## M0 POC 任务（docs/02-技术方案 §十二）

1. headless profile 拉起 dsh，插件树挂载成功（`--dump-config` 验证）
2. 三个刺探插件写通：policy（tools/* 拦截）/ approval-bridge（门控挂起）/ ent-llm-gateway（ctx.llm → 网关）
3. fork/replay 行为验证（resume/fork/replay 共用事件流）
4. 单 Runner 20 并发会话压测，校准 SessionRegistry 容量
