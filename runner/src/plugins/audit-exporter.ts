/**
 * audit-exporter：审计事实源插件。
 *
 * 挂载点：`session/event` 事件流（dsh 不变量：到达模型请求的一切可从日志重建）。
 * 职责：全量事件扇出到审计管道（MVP 直接 POST 控制面 / 落文件，P1 接 Kafka），
 * 前端 SSE 与审计消费同一条已脱敏流 —— 用户看到的 = 审计留的。
 */

export const name = 'audit-exporter'

interface AuditConfig {
  sink: 'http' | 'kafka' | 'file'
  endpoint: string
}

export function apply(ctx: any, config: AuditConfig) {
  let seq = 0
  return ctx.on?.('session/event', async (event: any) => {
    const envelope = { seq: ++seq, ts: Date.now(), event }
    // TODO(M2): dlp-redactor 串联后投递；失败重试 + 本地 WAL 防丢
    await emit(config, envelope)
  })
}

async function emit(config: AuditConfig, envelope: unknown): Promise<void> {
  if (config.sink === 'file') {
    // M0: append 到本地 WAL 文件即可
    return
  }
  // TODO(M0): http sink → 控制面 /api/audit/ingest（内部鉴权）
}
