#!/usr/bin/env node
/**
 * Forge M0 POC 编排脚本 —— 一条命令端到端验证"Runner 可运行化"：
 *
 *   阶段A  插件树：dsh sdk-minimal + --patch(forge-poc) boot，--dump-config 含 forge-poc，marker 落盘
 *   阶段B  协议握手：stdio JSON-RPC initialize -> serverInfo 为 deepseek-harness-sdk-runtime
 *   阶段C  机制闭环：假模型驱动 agent loop -> echo 放行（真实执行）-> rm -rf 被 tools/pre-execute 拒绝
 *          全程进出帧 + 门控判定写 WAL（audit-exporter 最小形态）
 *
 * 用法：pnpm poc  （或 node scripts/poc.mjs [--boot-only]）
 * 产物：runner/.poc/{marker.txt, wal.jsonl, frames.jsonl}
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, '.poc')
// dsh@0.2.2-rc.1 的 bin 在 Node 20 下不自启动（import.meta.main 问题），走包装器
const DSH_BIN = join(ROOT, 'scripts', 'dsh-launch.mjs')
const PLUGIN_ENTRY = join(ROOT, 'forge-poc-plugin', 'index.js')

const PASS = '✅', FAIL = '❌', SKIP = '⏭️ '
let failures = 0
const report = (ok, stage, extra = '') => {
  console.log(`${ok === null ? SKIP : ok ? PASS : FAIL} ${stage}${extra ? ' —— ' + extra : ''}`)
  if (ok === false) failures += 1
}

async function main() {
  const bootOnly = process.argv.includes('--boot-only')
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  // ---------- 0. 生成带绝对路径的 patch ----------
  const tpl = await readFile(join(ROOT, 'patches', 'forge-poc.patch.yml'), 'utf8')
  const patch = tpl
    .replaceAll('__PLUGIN_PATH__', PLUGIN_ENTRY)
    .replaceAll('__MARKER__', join(OUT, 'marker.txt'))
    .replaceAll('__WAL__', join(OUT, 'wal.jsonl'))
  const patchPath = join(ROOT, 'patches', '.generated.poc.patch.yml')
  await writeFile(patchPath, patch)

  // ---------- 阶段A：插件树装配（dump-config 必须能看到我们的插件）----------
  const dump = await runCollect([DSH_BIN, '--profile', 'sdk-minimal', '--patch', patchPath, '--dump-config'])
  report(dump.code === 0, 'A1. sdk-minimal + forge patch 可启动 dump-config')
  report(dump.stdout.includes('forge-poc'), 'A2. 配置树中出现 forge-poc 插件')

  // ---------- 阶段B/C：拉起 SDK 子进程走 JSON-RPC ----------
  const { DshProcess } = await import('../src/kernel/dsh-process.js')
    .catch(() => import('../src/kernel/dsh-process.mjs'))
    .catch(() => ({ DshProcess: null }))
  if (!DshProcess) {
    report(null, 'B/C. dsh-process 客户端模块缺失，跳过（tsx 环境外用 scripts/contract-check.mjs）')
  } else {
    const frames = []
    const proc = new DshProcess()
    await proc.start({
      binPath: DSH_BIN,
      profile: 'sdk-minimal',
      patchPaths: [patchPath],
      rawFrameSink: (direction, frame) => frames.push({ direction, frame }),
    })

    try {
      const init = await Promise.race([
        proc.request('initialize', {
          cwd: OUT,
          provider: 'forge-fake', // 我们插件注册的假 provider —— 无真实 Key 也能跑全链路
          model: 'fake-1',
          approvalRequests: true,
        }),
        timeout(30000, 'initialize'),
      ])
      const serverName = init?.serverInfo?.name ?? ''
      report(serverName === 'deepseek-harness-sdk-runtime', 'B1. initialize 握手', `server=${serverName} v${init?.serverInfo?.version}`)

      // 审批反向通道：任何 approval/request 一律 deny（跟平台默认 fail-closed 一致）
      proc.hostHandlers.set('approval/request', async (p) => ({ decision: 'denied', reason: 'poc host policy' }))

      if (!bootOnly) {
        proc.request('session/prompt', {
          sessionId: 'poc-session-1',
          contentBlocks: [{ type: 'text', text: 'run the two scripted commands' }],
        }).catch(() => {})
        await sleep(12000) // 等 agent loop 跑完三幕剧本
        await proc.request('session/wait', { sessionId: 'poc-session-1' }).catch(() => {})
        await sleep(2000)
      }

      const wal = await readFile(join(OUT, 'wal.jsonl'), 'utf8').catch(() => '')
      const marker = await readFile(join(OUT, 'marker.txt'), 'utf8').catch(() => '')
      report(marker.includes('mounted'), 'B2. 插件挂载哨兵落盘', marker.trim() || '(无 marker)')
      if (!bootOnly) {
        const allows = (wal.match(/"decision":"allow"/g) ?? []).length
        const denies = (wal.match(/"decision":"deny"/g) ?? []).length
        report(allows >= 1, 'C1. echo 命令经门控【放行】', `allow=${allows}`)
        report(denies >= 1, 'C2. rm -rf 命令经门控【拒绝】', `deny=${denies}`)
        const victimOk = !(await fileExists('/tmp/forge-poc-should-never-run'))
        report(victimOk, 'C3. 被拒绝命令未产生副作用（沙箱内无受害者目录）')
      }
      const notifCount = frames.filter((f) => f.direction === 'in' && f.frame?.method).length
      report(notifCount > 0, 'B3. 会话事件通知流出（session/event 事件流可外接审计）', `notifications=${notifCount}`)
      await writeFile(join(OUT, 'frames.jsonl'), frames.map((f) => JSON.stringify(f)).join('\n'))
    } finally {
      await proc.dispose()
    }
  }

  console.log(`\n产物目录：${OUT}\n${failures === 0 ? '🎉 M0 POC 全部通过' : `⚠️ ${failures} 项未通过（见上方 ❌）`}`)
  process.exit(failures === 0 ? 0 : 1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timeout = (ms, what) => sleep(ms).then(() => Promise.reject(new Error(`${what} timeout`)))
const fileExists = (p) => stat(p).then(() => true).catch(() => false)

function runCollect(argv) {
  return new Promise((resolveP) => {
    const c = spawn(argv[0], argv.slice(1), { env: process.env })
    let stdout = ''
    c.stdout.on('data', (d) => (stdout += d))
    c.stderr.on('data', () => {})
    c.on('close', (code) => resolveP({ code, stdout }))
    setTimeout(() => { c.kill('SIGKILL'); resolveP({ code: -1, stdout }) }, 60000)
  })
}

main().catch((e) => { console.error('POC 编排失败:', e); process.exit(1) })
