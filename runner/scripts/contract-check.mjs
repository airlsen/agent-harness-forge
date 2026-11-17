#!/usr/bin/env node
/**
 * dsh 插件契约检查（ADR-1 风险阀门）：升级 dsh 版本前后各跑一次。
 * 校验"我们依赖的官方扩展点仍存在且形状未变"。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = join(ROOT, 'node_modules', '@deepseek-ai')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`)
  ok ? pass++ : fail++
}

// 1. 关键包在位
for (const pkg of ['dsh', 'dsh-sdk-protocol', 'dsh-sdk-minimal', 'dsh-headless', 'dsh-tools', 'dsh-llm', 'dsh-user-approval']) {
  const exists = await readFile(join(DSH, pkg, 'package.json'), 'utf8').then(() => true).catch(() => false)
  check(`包在位 @deepseek-ai/${pkg}`, exists)
}

// 2. 扩展点形状（源码级）
const toolsEvents = await readFile(join(DSH, 'dsh-tools/lib/types/events.d.ts'), 'utf8').catch(() => '')
check("'tools/pre-execute' 瀑布存在", toolsEvents.includes("'tools/pre-execute'"))
check("'tools/execute' 瀑布存在", toolsEvents.includes("'tools/execute'"))

const llmIdx = await readFile(join(DSH, 'dsh-llm/lib/types/index.d.ts'), 'utf8').catch(() => '')
check('ctx.llm.registerAdapter 存在', llmIdx.includes('registerAdapter'))
check('LlmAdapter 抽象类存在', llmIdx.includes('abstract class LlmAdapter'))

const approval = await readFile(join(DSH, 'dsh-user-approval/lib/types/index.d.ts'), 'utf8').catch(() => '')
check('ctx.approval 服务存在', approval.includes('approval: ApprovalService'))
check('审批策略 ask/never 存在', approval.includes("'ask'") && approval.includes("'never'"))

const proto = await readFile(join(DSH, 'dsh-sdk-protocol/lib/types/types.d.ts'), 'utf8').catch(() => '')
for (const m of ['session/prompt', 'session/query', 'session/resume', 'session/wait', 'approval/request']) {
  check(`SDK 方法 ${m}`, proto.includes(`'${m}'`))
}
check('服务端身份 deepseek-harness-sdk-runtime', proto.includes('deepseek-harness-sdk-runtime'))

console.log(`\n契约检查：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
