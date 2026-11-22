/** 一项因下线、停用或平台关闭而未能装配的扩展能力（后端写在用户消息 meta.capabilities.unavailable） */
export type UnavailableCapability = ActiveCapabilities['unavailable'][number];
/**
 * 最近一轮实际未生效的扩展能力。只看最后一条用户消息：它反映会话当前的真实装配结果，
 * 在「能力」面板中逐项标记，不再在消息流里插入分隔条。
 */
export function latestUnavailable(turns: Pick<Turn, 'user'>[]): UnavailableCapability[] {
  const last = [...turns].reverse().find((turn) => turn.user)?.user;
  const value = (last?.meta?.capabilities as Partial<ActiveCapabilities> | undefined)?.unavailable;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is UnavailableCapability =>
      Boolean(item) && typeof item === 'object' && ['skill', 'mcp', 'web'].includes(item.kind),
  );
}
/**
 * 把扁平的消息列表聚合成「轮次」视图：一轮 = 一条用户消息 + 一个 AI 块。
 * AI 块内按发生顺序排列步骤（steps）：思考、连续工具调用组、正文。live 覆盖项只落在最后一轮：
 * 运行中的思考/工具/正文流式并入同一个 AI 块。
 *
 * 一轮通常包含多次模型请求（思考 → 调工具 → 再思考 → …），每次请求都会产生一段思考。
 * 展示时按用户关心的「这一轮做了什么」组织，而不是按请求次数：
 * - process：最终回答之前的全部过程（所有思考、工具调用、中间的过程说明），合成一个过程块；
 * - answer：最后一次工具调用之后的正文，即最终回答。
 * 运行中已显示的正文不再收回：所有正文都留在 answer 里原位显示，轮次结束后才整理一次
 * （中间说明收进过程块），避免「文字出现几秒又消失」。
 */
import type { ActiveCapabilities, ChatMessage } from '../types/platform';
import {
  PRESENT_TOOL,
  mergeDeliverables,
  parseChanges,
  parseDeliverables,
  type Deliverable,
  type WorkspaceChanges,
} from './files';

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

export type TextStep = Extract<TurnStep, { kind: 'text' }>;

export interface Turn {
  key: string | number;
  user: ChatMessage | null;
  /** 按发生顺序的全部步骤 */
  steps: TurnStep[];
  /** 过程块：最终回答之前的思考、工具调用与中间说明（保持发生顺序） */
  process: TurnStep[];
  /** 最终回答：最后一次工具调用之后的正文 */
  answer: TextStep[];
  running: boolean;
  /** 生成本轮回复的模型显示名；旧消息未记录时为空，由调用方回退为会话模型 */
  model: string;
  /** 本轮模型通过 workspace_present 声明的交付文件（同一路径以最后一次声明为准） */
  deliverables: Deliverable[];
  /** 本轮结束时服务端记录的工作区改动（新增/修改/删除与行数），无改动时为 null */
  changes: WorkspaceChanges | null;
}
function modelLabel(meta: Record<string, any> | undefined) {
  const value = meta?.modelName || meta?.model;
  return typeof value === 'string' ? value : '';
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
      // 第二期起用户消息记录本轮模型：执行中、尚无回复时也能显示。
      turns.push({
        key: message.id,
        user: message,
        steps: [],
        process: [],
        answer: [],
        running: false,
        model: modelLabel(message.meta),
        deliverables: [],
        changes: parseChanges(message.meta?.workspaceChanges),
      });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) continue;
    if (message.role === 'assistant') {
      if (!turn.model) turn.model = modelLabel(message.meta);
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
      if (message.meta?.tool === PRESENT_TOOL && !message.meta?.isError)
        mergeDeliverables(turn.deliverables, parseDeliverables(message.content));
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
    // 同一次模型请求里正文先于工具调用输出：有进行中的调用时，正文排在调用之前（随之归入过程块）
    if (live.text)
      last.steps.push({
        kind: 'text',
        text: live.text,
        live: live.activeTools.length === 0,
        partial: false,
        key: 'live',
      });
    for (const call of live.activeTools) pushCall(last.steps, call);
  }
  for (const turn of turns) Object.assign(turn, splitSteps(turn.steps, turn.running));
  return turns;
}

/**
 * 拆分过程与最终回答：最后一个工具组之后的正文是最终回答，其余（含全部思考）归入过程。
 * running：轮次进行中时正文一律留在 answer——已经显示给用户的文字不因随后开始调工具而
 * 被收进（收起状态的）过程块；轮次结束后再按上面的规则整理，只变化一次。
 */
export function splitSteps(steps: TurnStep[], running = false): { process: TurnStep[]; answer: TextStep[] } {
  if (running)
    return {
      process: steps.filter((step) => step.kind !== 'text'),
      answer: steps.filter((step): step is TextStep => step.kind === 'text'),
    };
  let lastTools = -1;
  steps.forEach((step, index) => {
    if (step.kind === 'tools') lastTools = index;
  });
  const process: TurnStep[] = [];
  const answer: TextStep[] = [];
  steps.forEach((step, index) => {
    if (step.kind === 'text' && index > lastTools) answer.push(step);
    else process.push(step);
  });
  return { process, answer };
}

export interface ProcessStats {
  /** 是否包含思考 */
  thinking: boolean;
  /** 工具调用总数 */
  calls: number;
  /** 失败的工具调用数 */
  failures: number;
  /** 进行中的调用（按发生顺序） */
  pending: ToolCallView[];
}
export function processStats(process: TurnStep[]): ProcessStats {
  const calls = process.flatMap((step) => (step.kind === 'tools' ? step.calls : []));
  return {
    thinking: process.some((step) => step.kind === 'thinking'),
    calls: calls.length,
    failures: calls.filter((call) => !call.pending && call.isError).length,
    pending: calls.filter((call) => call.pending),
  };
}
/** 过程块结束后的一行摘要，如「已思考 · 调用 4 个工具」 */
export function processSummary(stats: ProcessStats): string {
  const parts = [
    ...(stats.thinking ? ['已思考'] : []),
    ...(stats.calls ? [`调用 ${stats.calls} 个工具`] : []),
    ...(stats.failures ? [`${stats.failures} 个失败`] : []),
  ];
  return parts.join(' · ') || '执行过程';
}

/**
 * 工具调用参数的一行摘要：优先显示路径、文件、修改说明、命令、查询或网址，否则截断 JSON。
 * 工具调用行与过程块的「当前动态」共用。
 */
export function toolArgSummary(value: unknown, max = 48): string {
  if (!value || typeof value !== 'object') return typeof value === 'string' ? clip(value, max) : '';
  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && record.path) return record.path;
  if (Array.isArray(record.files) && record.files.length)
    return record.files.map((file) => (typeof file?.path === 'string' ? file.path : '…')).join('、');
  // 整篇写入类调用（如更新 SKILL.md）没有路径，显示修改说明而不是正文开头
  for (const key of ['summary', 'command', 'cmd', 'query', 'url']) {
    const text = record[key];
    if (typeof text === 'string' && text.trim()) return clip(text.trim(), max);
  }
  try {
    return clip(JSON.stringify(value), max);
  } catch {
    return '';
  }
}
function clip(text: string, max: number) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}
