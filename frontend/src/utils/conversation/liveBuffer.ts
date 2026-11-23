/**
 * 流式片段合并：模型每秒可能推送几十个正文 / 思考片段，逐个更新页面会让 Markdown 反复全文解析、
 * 对话反复重算，长回复时主线程被占满。片段先攒起来，最多每 LIVE_FLUSH_MS 合并更新一次；
 * 其他事件（回复结算、工具调用等）处理前先 flush，保证与片段的先后顺序不变。
 * 工作台与 Skill 编辑页共用。
 */
export const LIVE_FLUSH_MS = 50;

export type LiveDeltaKind = 'message_delta' | 'reasoning_delta';

export function isLiveDelta(kind: unknown): kind is LiveDeltaKind {
  return kind === 'message_delta' || kind === 'reasoning_delta';
}

export interface LiveBuffer {
  /** 记下一个片段；首个片段到达后 LIVE_FLUSH_MS 内合并写入 */
  push(kind: LiveDeltaKind, text: string): void;
  /** 立即写入已攒下的片段 */
  flush(): void;
  /** 丢弃尚未写入的片段（断开、切换会话、回合结束） */
  clear(): void;
}

export function createLiveBuffer(
  apply: (text: string, reasoning: string) => void,
  delay = LIVE_FLUSH_MS,
): LiveBuffer {
  let text = '';
  let reasoning = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    cancel();
    if (!text && !reasoning) return;
    const pendingText = text;
    const pendingReasoning = reasoning;
    text = '';
    reasoning = '';
    apply(pendingText, pendingReasoning);
  };
  return {
    push(kind, chunk) {
      if (!chunk) return;
      if (kind === 'message_delta') text += chunk;
      else reasoning += chunk;
      if (timer === null) timer = setTimeout(flush, delay);
    },
    flush,
    clear() {
      cancel();
      text = '';
      reasoning = '';
    },
  };
}
