#!/usr/bin/env node
/** M0 POC：CLI 与网页预览共用的真实验证脚本。只调用安全探针，不执行任意 shell。 */
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(process.env.FORGE_POC_OUT || join(ROOT, '.poc'))
const PREVIEW_ROOT = join(ROOT, 'data', 'preview', 'runs') + sep
if (OUT !== join(ROOT, '.poc') && !OUT.startsWith(PREVIEW_ROOT)) {
  throw new Error('FORGE_POC_OUT must be inside runner/data/preview/runs/')
}
const DSH_BIN = join(ROOT, 'scripts', 'dsh-launch.mjs')
const PLUGIN_ENTRY = join(ROOT, 'forge-poc-plugin', 'index.js')
const state = { startedAt: new Date().toISOString(), finishedAt: null, checks: [], error: null }
let failures = 0
function saveReport() { writeFileSync(join(OUT, 'report.json'), JSON.stringify(state, null, 2)) }
function report(ok, id, label, detail = '') {
  state.checks.push({ id, label, ok, detail, at: new Date().toISOString() })
  if (ok === false) failures += 1
  saveReport()
  console.log(`${ok === null ? '⏭️' : ok ? '✅' : '❌'} ${id}. ${label}${detail ? ' —— ' + detail : ''}`)
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 9)) throw new Error('dsh requires Node >= 24.9.0')
  const bootOnly = process.argv.includes('--boot-only')
  if (OUT === join(ROOT, '.poc')) await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  saveReport()
  const victim = join(OUT, 'protected-victim')
  const sentinel = join(victim, 'sentinel.txt')
  const sentinelText = 'FORGE_SENTINEL_MUST_SURVIVE\n'
  await mkdir(victim, { recursive: true })
  await writeFile(sentinel, sentinelText)

  const tpl = await readFile(join(ROOT, 'patches', 'forge-poc.patch.yml'), 'utf8')
  const patch = tpl.replaceAll('__PLUGIN_PATH__', PLUGIN_ENTRY)
    .replaceAll('__MARKER__', join(OUT, 'marker.txt'))
    .replaceAll('__WAL__', join(OUT, 'wal.jsonl'))
    .replace('rm -rf /tmp/forge-poc-should-never-run', `rm -rf ${victim}`)
  const patchPath = join(OUT, 'poc.patch.yml')
  await writeFile(patchPath, patch)
  const dump = await runCollect([DSH_BIN, '--profile', 'sdk-minimal', '--patch', patchPath, '--dump-config'])
  await writeFile(join(OUT, 'config.yml'), dump.stdout)
  report(dump.code === 0 && !dump.stderr.includes('dsh:'), 'A1', 'sdk-minimal + forge patch 配置装配')
  report(dump.stdout.includes('forge-poc'), 'A2', '配置树包含 out-of-tree 插件')

  const { DshProcess } = await import('../src/kernel/dsh-process.ts')
  const frames = []
  const proc = new DshProcess()
  proc.hostHandlers.set('approval/request', async () => ({ decision: 'denied', reason: 'poc host policy' }))
  await proc.start({
    binPath: DSH_BIN, profile: 'sdk-minimal', patchPaths: [patchPath],
    rawFrameSink(direction, frame) {
      const record = { direction, frame }
      frames.push(record)
      appendFileSync(join(OUT, 'frames.jsonl'), JSON.stringify(record) + '\n')
    },
  })
  try {
    const init = await withTimeout(proc.request('initialize', {
      cwd: OUT, provider: 'forge-fake', model: 'fake-1', approvalRequests: true,
    }), 30000, 'initialize')
    const server = init?.serverInfo
    report(server?.name === 'deepseek-harness-sdk-runtime', 'B1', 'stdio JSON-RPC initialize 握手', `${server?.name} v${server?.version}`)
    const marker = await readFile(join(OUT, 'marker.txt'), 'utf8').catch(() => '')
    report(marker.includes('mounted:forge-poc'), 'B2', '插件 apply 挂载哨兵落盘', marker.trim().replaceAll('\n', ' · '))
    if (!bootOnly) {
      const sessionId = `poc-${Date.now()}`
      await withTimeout(proc.request('session/prompt', {
        sessionId, contentBlocks: [{ type: 'text', text: 'run the two scripted commands' }],
      }), 20000, 'session/prompt')
      await withTimeout(proc.request('session/wait', { sessionId }), 20000, 'session/wait')
      const entries = parseLines(await readFile(join(OUT, 'wal.jsonl'), 'utf8').catch(() => ''))
      const allows = entries.filter((e) => e.decision === 'allow')
      const denies = entries.filter((e) => e.decision === 'deny')
      const executed = entries.filter((e) => e.stage === 'executor-ran')
      report(allows.length === 1, 'C1', 'echo 探针调用经门控放行', `allow=${allows.length}`)
      report(denies.length === 1, 'C2', 'rm -rf 探针调用经门控拒绝', `deny=${denies.length}`)
      report(await readFile(sentinel, 'utf8').catch(() => '') === sentinelText, 'C3', '预先创建的受保护哨兵文件保持不变')
      report(executed.length === 1 && executed[0].command === 'echo hello-forge'
        && !entries.some((e) => e.stage === 'executor-breach'), 'C4', '仅放行调用进入探针执行体，拒绝调用未进入', '安全探针不执行真实 shell；以 WAL 核验门控边界')
    }
    const events = frames.filter((f) => f.direction === 'in' && f.frame?.method === 'session.event')
    report(bootOnly ? null : events.length > 0, 'B3', '会话事件流可外接审计', `session.event=${events.length}`)
  } finally {
    await proc.dispose()
  }
  state.finishedAt = new Date().toISOString()
  saveReport()
  console.log(`\n产物目录：${OUT}\n${failures === 0 ? '🎉 M0 POC 全部通过' : `⚠️ ${failures} 项未通过`}`)
  process.exit(failures === 0 ? 0 : 1)
}
function parseLines(text) {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
  })]).finally(() => clearTimeout(timer))
}
function runCollect(argv) {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, argv, { env: process.env })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.once('error', (e) => { clearTimeout(timer); reject(e) })
    child.once('close', (code) => { clearTimeout(timer); resolveP({ code, stdout, stderr }) })
  })
}
main().catch(async (e) => {
  state.error = String(e)
  state.finishedAt = new Date().toISOString()
  await mkdir(OUT, { recursive: true }).catch(() => {})
  saveReport()
  console.error('POC 编排失败:', e)
  process.exit(1)
})
