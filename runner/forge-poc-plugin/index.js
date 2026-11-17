/**
 * forge-poc-plugin —— M0 POC 核心插件（纯 Cordis 插件，不改 dsh 一行源码）。
 *
 * 验证三件事：
 *  1.【插件挂载】apply() 即落 marker —— 证明 out-of-tree 插件可进入 dsh 插件树
 *  2.【模型可插拔】ctx.llm.registerAdapter 注册假 provider 'forge-fake'
 *     —— 证明 ent-llm-gateway 机制成立，且企业可在无 API Key 下做全链路行为测试
 *  3.【工具门控】ctx.on('tools/pre-execute') 瀑布（dsh-tools 官方门控点）
 *     自带探针工具 forge_probe：'echo ...' 放行执行，'rm -rf ...' 失败关闭（deny）
 *     每次判定追加 WAL —— 同时证明 audit-exporter 的最小形态成立
 *
 * 已核验 API（dsh@0.2.2-rc.1 源码 .d.ts）：
 *  - ctx.llm.registerAdapter(providers, adapter) -> 卸载句柄
 *  - 'tools/pre-execute'(exec, next)：decision = {kind:'allow|deny|cancel|ask', reason?}
 *  - ctx.tools.register(definition) -> 卸载函数；ToolDefinition = ToolSchema + output + execute
 *  - StreamChunk：block-start/text-delta/tool-call-delta/block-end/usage/finish，
 *    finish.reason 是映射值对象 {kind:'stop'|'tool-calls'|...}
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const name = 'forge-poc'
// Cordis 依赖声明：缺服务不激活、服务消失自动卸载（这正是 dsh 热替换安全性的来源）
export const inject = ['llm', 'tools']

const now = () => new Date().toISOString()

async function wal(config, entry) {
  await appendFile(config.walPath, JSON.stringify({ ts: now(), ...entry }) + '\n').catch(() => {})
}

// ---------------------------------------------------------------------------
// 探针工具：被假模型调用；门控的 allow/deny 判决对象就是它
// ---------------------------------------------------------------------------
function probeTool(config) {
  return {
    name: 'forge_probe',
    description: 'Forge POC probe tool — runs only whitelisted echo commands',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    // 纵深防御：即使门控被绕过，执行体自身也只允许 echo
    execute: async (args) => {
      const cmd = String(args?.command ?? '')
      if (!cmd.startsWith('echo ')) {
        // 若执行到这里说明门控失效 —— 这是必须被 POC 发现的重大事故
        await wal(config, { stage: 'executor-breach', command: cmd })
        throw new Error('executor refuses non-echo command')
      }
      await wal(config, { stage: 'executor-ran', command: cmd })
      return { ran: cmd }
    },
  }
}

// ---------------------------------------------------------------------------
// 假模型适配器：三幕剧本（echo 放行调用 → rm -rf 应被拒 → 收尾文本）
// ---------------------------------------------------------------------------
class FakeAdapter {
  constructor(config) {
    this._config = config
  }
  providerInfo(provider) {
    return { id: provider, name: 'Forge Fake Provider (POC)' }
  }
  // 抽象基类的默认方法，裸 class 需显式给出（registerAdapter 会立即调用）
  providerRetryPolicy() {
    return undefined
  }
  imageRequestPricing() {
    return undefined
  }
  imageRequestTarget(_provider, _model, image) {
    return image
  }
  attributionHeaders() {
    return { 'x-forge-poc': '1' }
  }
  async listModels(provider) {
    return [{ provider, id: 'fake-1', name: 'Fake Model (POC)', inputModalities: ['text'] }]
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: 'Fake Model (POC)', context: { contextWindow: 128000 } }
  }
  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model)
    return { model: resolved, stream: (options) => this._stream(options) }
  }
  async *_stream(options) {
    const results = countToolResults(options?.messages)
    if (results === 0) {
      yield* toolCallChunks(0, 'call-1', 'forge_probe', JSON.stringify({ command: this._config.allowCommand }))
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else if (results === 1) {
      yield* toolCallChunks(0, 'call-2', 'forge_probe', JSON.stringify({ command: this._config.denyCommand }))
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: this._config.finalText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: this._config.finalText } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  }
}

function countToolResults(messages = []) {
  let n = 0
  for (const m of messages) {
    const blocks = Array.isArray(m?.content) ? m.content : []
    if (m?.role === 'tool' || blocks.some((b) => String(b?.type).includes('tool-result'))) n += 1
  }
  return n
}

function* toolCallChunks(index, id, toolName, args) {
  yield { type: 'block-start', index, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index, id, name: toolName, argumentsDelta: args }
  yield { type: 'block-end', index, block: { type: 'tool-call', id, name: toolName, arguments: args } }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------
export async function apply(ctx, config) {
  const disposers = []
  await mkdir(dirname(config.markerPath), { recursive: true })
  await writeFile(config.markerPath, `mounted:${name}\nat:${now()}\n`)

  const adapter = new FakeAdapter(config)
  const handle = ctx.llm?.registerAdapter?.(['forge-fake'], adapter)
  if (handle) disposers.push(() => handle.dispose?.() ?? handle())

  const disposeTool = ctx.tools?.register?.(probeTool(config))
  if (disposeTool) disposers.push(disposeTool)

  const denyRe = new RegExp(config.denyPattern)
  const disposeGate = ctx.on('tools/pre-execute', async (exec, next) => {
    const args = JSON.stringify(exec?.arguments ?? {})
    if (denyRe.test(args)) {
      await wal(config, { stage: 'gate', tool: exec?.name, args, decision: 'deny' })
      return { kind: 'deny', reason: 'forge-policy: matches deny pattern' }
    }
    await wal(config, { stage: 'gate', tool: exec?.name, args, decision: 'allow' })
    return next()
  })
  disposers.push(disposeGate)

  // Cordis 铁律：卸载即清场
  return () => disposers.forEach((d) => d?.())
}
