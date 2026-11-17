#!/usr/bin/env node
/**
 * dsh 启动包装器（M0 必需的 workaround）：
 * @deepseek-ai/dsh@0.2.2-rc.1 的 bin.js 用 `if (import.meta.main)` 自启动，
 * Node 20 不设该字段 → 直接跑 bin 会静默退出。此包装器显式调用 runCli()。
 * 上游修复后删除本文件、把 binPath 换回 node_modules/.bin/dsh。
 */
import { runCli } from '@deepseek-ai/dsh/lib/bin.js'

await runCli()
