/**
 * 会话 API + SSE 客户端（语义对齐旧 /conversations/stream）。
 * 断线重连带 last_event_seq（后端事件索引支持，见 docs/02-技术方案 §4.3）。
 */
import type { AgentSseEvent } from '../types/agent'

const BASE = '/api/agent/sessions'

export async function createSession(scenarioId: number): Promise<{ sessionId: number }> {
  const res = await fetch(`${BASE}?scenario_id=${scenarioId}`, { method: 'POST' })
  const body = await res.json()
  if (body.code !== 0) throw new Error(body.message)
  return body.data
}

export function forkSession(sessionId: number, atSeq: number) {
  return fetch(`${BASE}/${sessionId}/fork?at_seq=${atSeq}`, { method: 'POST' }).then((r) => r.json())
}

export async function* streamTurn(
  sessionId: number,
  message: string,
  lastEventSeq?: number,
): AsyncGenerator<AgentSseEvent> {
  const res = await fetch(`${BASE}/${sessionId}/stream?message=${encodeURIComponent(message)}`, {
    method: 'POST',
    headers: lastEventSeq ? { 'Last-Event-Seq': String(lastEventSeq) } : {},
  })
  if (!res.body) return
  // TODO(W1): 走 utils/agent-sse-parser.ts（event:/data: 帧解析 + 缓冲）
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // 简化骨架：逐行事件
    for (const line of buf.split('\n')) void line
  }
}
