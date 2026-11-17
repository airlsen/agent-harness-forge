/**
 * dsh-process：把 dsh sdk-minimal profile 作为子进程拉起，走 stdio 上的
 * 换行分隔 JSON-RPC 2.0 通信（协议：@deepseek-ai/dsh-sdk-protocol，源码已核验）。
 *
 * 服务端身份：deepseek-harness-sdk-runtime
 * 方法面（已核验）：initialize / session/prompt / session/query / session/resume / session/wait
 * 反向调用（host 应答）：approval/request、user-question/ask
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface DshSpawnOptions {
  /** dsh 可执行入口（runner/node_modules/.bin/dsh 或打包后的 lib/bin.js） */
  binPath: string
  profile: string // 'sdk-minimal'
  patchPaths: string[] // --patch 覆盖层（我们的 forge 插件由此进入插件树）
  env?: NodeJS.ProcessEnv
  /** 所有进出帧的原始落盘（POC 期等同 audit-exporter 的最小外部形态） */
  rawFrameSink?: (direction: 'out' | 'in', frame: unknown) => void
}

export class DshProcess {
  private child: ChildProcess | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private notificationHandlers: Array<(method: string, params: unknown) => void> = []

  /** 反向请求处理（approval/request 等），value: (params) => result */
  hostHandlers = new Map<string, (params: any) => Promise<unknown> | unknown>()

  async start(opts: DshSpawnOptions): Promise<void> {
    const args = ['--profile', opts.profile]
    for (const p of opts.patchPaths) args.push('--patch', p)
    // SDK server 走 stdio：必须保证 stdout 纯 JSON-RPC，stderr 自由落日志
    this.child = spawn(opts.binPath, args, {
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const rl = createInterface({ input: this.child.stdout! })
    rl.on('line', (line) => this.onLine(opts, line))
    this.child.on('exit', (code) => {
      const err = new Error(`dsh exited with code ${code}`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })
  }

  private onLine(opts: DshSpawnOptions, line: string) {
    let frame: any
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    opts.rawFrameSink?.('in', frame)
    if ('id' in frame && 'method' in frame) {
      // 服务端反向请求（approval/request / user-question/ask）——Runner 作为 host 应答
      const handler = this.hostHandlers.get(frame.method)
      const respond = async () => {
        try {
          const result = handler ? await handler(frame.params) : undefined
          this.send({ jsonrpc: '2.0', id: frame.id, result })
        } catch (e) {
          this.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: String(e) } })
        }
      }
      void respond()
    } else if ('id' in frame) {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      if (frame.error) p.reject(new Error(frame.error.message ?? 'jsonrpc error'))
      else p.resolve(frame.result)
    } else if ('method' in frame) {
      for (const h of this.notificationHandlers) h(frame.method, frame.params)
    }
  }

  private send(frame: unknown) {
    this.child?.stdin?.write(JSON.stringify(frame) + '\n')
  }

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as any, reject })
      this.send({ jsonrpc: '2.0', method, id, params })
    })
  }

  onNotification(handler: (method: string, params: any) => void): () => void {
    this.notificationHandlers.push(handler)
    return () => {
      const i = this.notificationHandlers.indexOf(handler)
      if (i >= 0) this.notificationHandlers.splice(i, 1)
    }
  }

  async dispose(): Promise<void> {
    this.child?.kill('SIGTERM')
    this.child = null
  }
}
