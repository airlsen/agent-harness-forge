/**
 * 把扁平的消息列表聚合成「轮次」视图：一轮 = 一条用户消息 + 一个 AI 块。
 * AI 块内按发生顺序排列过程步骤：思考（流式时展开，思考结束后折叠成一行）、
 * 连续工具调用组（可折叠）、正文。live 覆盖项只落在最后一轮：
 * 运行中的思考/工具/正文流式并入同一个 AI 块。
 */
import type { ChatMessage } from '../types/platform';

export interface ToolCallView {
  id: string;
  tool: string;
  arguments?: unknown;
  result?: string;
  isError?: boolean;
  pending?: boolean;
}

export type TurnStep =
  | { kind: 'thinking'; text: string; live: boolean }
  | { kind: 'tools'; calls: ToolCallView[] }
  | { kind: 'text'; text: string; live: boolean; partial: boolean; key: string | number };

export interface Turn {
  key: string | number;
  user: ChatMessage | null;
  steps: TurnStep[];
  running: boolean;
  /** 生成本轮回复的模型显示名；旧消息未记录时为空，由调用方回退为会话模型 */
  model: string;
}

export interface LiveTurn {
  running: boolean;
  reasoning: string;
  text: string;
  activeTools: ToolCallView[];
}

function pushCall(steps: TurnStep[], call: ToolCallView) {
  const last = steps.at(-1);
  // 连续工具调用并入同一组；思考或正文输出会自然断开分组。
  if (last?.kind === 'tools') last.calls.push(call);
  else steps.push({ kind: 'tools', calls: [call] });
}

export function buildTurns(messages: ChatMessage[], live: LiveTurn): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ key: message.id, user: message, steps: [], running: false, model: '' });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) continue;
    if (message.role === 'assistant') {
      const model = message.meta?.modelName || message.meta?.model;
      if (!turn.model && typeof model === 'string') turn.model = model;
      const reasoning = typeof message.meta?.reasoning === 'string' ? message.meta.reasoning : '';
      if (reasoning) turn.steps.push({ kind: 'thinking', text: reasoning, live: false });
      if (message.content)
        turn.steps.push({
          kind: 'text',
          text: message.content,
          live: false,
          partial: Boolean(message.meta?.partial),
          key: message.id,
        });
    } else if (message.role === 'tool') {
      pushCall(turn.steps, {
        id: String(message.meta?.toolCallId ?? message.id),
        tool: message.meta?.tool ?? '工具',
        arguments: message.meta?.arguments,
        result: message.content,
        isError: Boolean(message.meta?.isError),
      });
    }
  }
  const last = turns.at(-1);
  if (last && live.running) {
    last.running = true;
    if (live.reasoning)
      // 思考只在仍在流式推理时视为 live：一旦开始调工具或输出正文，思考即结束、折叠收起
      last.steps.push({
        kind: 'thinking',
        text: live.reasoning,
        live: !live.text && live.activeTools.length === 0,
      });
    for (const call of live.activeTools) pushCall(last.steps, call);
    if (live.text)
      last.steps.push({ kind: 'text', text: live.text, live: true, partial: false, key: 'live' });
  }
  return turns;
}
