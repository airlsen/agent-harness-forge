# runner/ · 执行内核适配层（TS）

AgentKernel 端口（`src/kernel/types.ts`）+ dsh 实现 + 平台 Cordis 插件包。
与控制面（backend/）仅经 HTTP 契约通信；**禁止把 cordis/dsh 类型泄漏给控制面**。

## ⚠️ 运行时要求

- **Node.js ≥ 24.9.0**（dsh `engines` 硬要求；推荐 Node 26 LTS）
- dsh 版本锁定：`@deepseek-ai/dsh@0.2.2-rc.1`（Developer Preview，升级必须过契约检查）

## 命令

```bash
npm install
npx tsx scripts/contract-check.mjs   # dsh 插件 API 契约（19 项，升级 dsh 必跑）
npx tsx scripts/poc.mjs              # M0 端到端验证（9 项断言，产物在 .poc/）
pnpm dev                             # Runner HTTP server（tsx watch, :9000）
```

## M0 已验证（2026-11-17，全绿）

sdk-minimal profile 嵌入、插件 patch 叠加、JSON-RPC 握手（`deepseek-harness-sdk-runtime`）、
`ctx.llm.registerAdapter` 假模型驱动、`tools/pre-execute` 门控放行/拒绝、会话事件流外拉（session.event/status）。
详见 `docs/05-M0-技术验证报告.md`。

## 关键文件

| 文件 | 说明 |
|---|---|
| `src/kernel/types.ts` | AgentKernel 端口契约（控制面唯一依赖面） |
| `src/kernel/dsh-process.ts` | dsh 子进程启动 + stdio 换行 JSON-RPC 客户端 |
| `src/kernel/dsh-kernel.ts` | AgentKernel 的 dsh 实现（M1 接 session/prompt → KernelEvent 扇出） |
| `forge-poc-plugin/` | M0 插件：假模型适配器 + forge_probe 探针 + tools/pre-execute 门控 + WAL |
| `patches/forge-poc.patch.yml` | 插件进入插件树的 patch 模板（POC 脚本自动生成绝对路径版） |
| `scripts/dsh-launch.mjs` | bin 自启动问题 workaround（dsh@0.2.2-rc.1 的 import.meta.main 缺陷） |
| `scripts/poc.mjs` / `scripts/contract-check.mjs` | M0 验证编排 / 契约检查 |
