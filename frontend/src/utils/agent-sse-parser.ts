/**
 * SSE 帧解析（平移旧 claude-sse-parser 的健壮性要求）：
 *  - event:/data: 帧边界、跨 chunk 缓冲、data 多行拼接
 *  - 序号游标：记录 last_event_seq 供断线重连
 *  - 骨架阶段留 TODO，W1 联调 mock（vite-plugin-mock 按冻结协议造流）
 */
import type { AgentSseEvent } from '../types/agent'

export class AgentSseParser {
  private buf = ''
  lastSeq = 0

  feed(chunk: string): AgentSseEvent[] {
    this.buf += chunk
    const events: AgentSseEvent[] = []
    // TODO(W1): 按 \n\n 切帧 → event/data 行解析 → JSON.parse with try/catch
    return events
  }
}
