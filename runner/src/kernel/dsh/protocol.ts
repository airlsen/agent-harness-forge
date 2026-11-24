/**
 * dsh SDK 协议知识（唯一位置）：方法名、宿主回调名，以及把 dsh 通知翻译成 Forge 内核事件。
 * 内核只认 Forge 事件（message / tool_use_start / tool_result / cost_tick / error …），
 * dsh 的事件结构变化只需改这里，contract-check 会核对下面的方法名仍在 dsh-sdk-protocol 中。
 */
import { FORGE_EVENTS, FORGE_EVENT_PREFIX } from '../../../internal-plugins/shared/events.js';
import type { KernelEvent } from '../types.js';

/**
 * dsh 启动 profile：官方 SDK 应用组合（文件、交付、沙箱终端、时间、大结果转存等通用能力齐全），
 * 用不上的插件由 runtime-config.ts 关闭
 */
export const DSH_PROFILE = 'sdk';
/** Runner → dsh 的 JSON-RPC 请求 */
export const RPC = {
  initialize: 'initialize',
  prompt: 'session/prompt',
  wait: 'session/wait',
  resume: 'session/resume',
} as const;
/** dsh → Runner 的宿主请求（需要回复） */
export const HOST_REQUEST = {
  approval: 'approval/request',
  question: 'user-question/ask',
} as const;
/** dsh → Runner 的会话日志通知 */
export const SESSION_EVENT = 'session.event';
/** contract-check 用：Forge 依赖的全部 SDK 方法 */
export const SDK_METHODS = [...Object.values(RPC), ...Object.values(HOST_REQUEST), SESSION_EVENT];

/** 审批结论（Forge 侧）→ dsh 审批回复 */
export type ApprovalOutcome = 'approve' | 'deny' | 'timeout' | 'cancelled';
export function approvalReply(outcome: ApprovalOutcome) {
  return {
    outcome: outcome === 'approve' ? 'allowed-once' : outcome === 'cancelled' ? 'cancelled' : 'rejected',
  };
}
/** 用户提问（user-question）：Forge 没有对应交互，统一回复取消，模型会继续自行处理 */
export const QUESTION_REPLY = { cancelled: true };

/** 沙箱模式的中文说明（确认卡片上给业务用户看） */
const SANDBOX_MODE_TEXT: Record<string, string> = {
  'read-only': '只读',
  'workspace-write': '写入会话工作区',
  'danger-full-access': '不受沙箱限制，可读写服务器上的任意位置',
};
/**
 * 审批理由翻译：dsh 沙箱越界请求的理由是固定英文格式 `escalate sandbox to <mode>: <justification>`
 * （justification 是模型按用户语言写的一句话），换成中文说明；其他理由原样返回。
 */
export function approvalReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string' || !reason) return undefined;
  const escalation = /^escalate sandbox to ([\w-]+): ([\s\S]*)$/.exec(reason);
  if (!escalation) return reason;
  const [, mode, justification] = escalation;
  return `这条命令需要突破终端沙箱（${SANDBOX_MODE_TEXT[mode] ?? mode}）。原因：${justification.trim() || '未说明'}`;
}

/**
 * 翻译结果：普通事件，或「本轮失败」。失败默认只记第一次（例如中止后 dsh 报告的 aborted 不覆盖用户中止）；
 * explicit 表示插件主动上报的错误（如模型网关报错），总是记录。
 */
export type Translated =
  { kind: string; payload: unknown; source: KernelEvent['source'] } | { failure: string; explicit?: boolean };

/** 已告警过的未登记插件事件：每种只告警一次，避免刷屏 */
const unknownWarned = new Set<string>();
/**
 * Forge 自有插件经 dsh 通知通道上报的事件：登记表在 internal-plugins/shared/events.js（插件与这里共用）。
 * 未登记的 `forge.*` 不再静默丢弃，而是在 Runner 日志里告警一次。
 */
function translatePluginEvent(method: string, params: any, calls: Map<string, any>): Translated[] | undefined {
  const spec = Object.hasOwn(FORGE_EVENTS, method) ? FORGE_EVENTS[method] : undefined;
  if (!spec) {
    if (!method.startsWith(FORGE_EVENT_PREFIX)) return undefined;
    if (!unknownWarned.has(method)) {
      unknownWarned.add(method);
      console.warn(
        `[dsh] 忽略未登记的插件事件 ${method}：请在 runner/internal-plugins/shared/events.js 中登记`,
      );
    }
    return [];
  }
  if (spec.kind === 'failure') return [{ failure: params?.message ?? '执行失败', explicit: true }];
  if (spec.kind === 'files') return [{ kind: 'files', payload: { files: [params] }, source: spec.source }];
  if (spec.kind === 'deliverables') {
    // 记下本次交付（工作区相对路径、大小、说明）：随后的 tool/result 用它作为持久化的结果，
    // 界面回放历史时从工具结果里解析交付卡片
    const call = calls.get(params?.callId);
    if (call) call.presented = params.files;
    return [{ kind: 'deliverables', payload: { files: params?.files ?? [] }, source: spec.source }];
  }
  return [{ kind: spec.kind, payload: params, source: spec.source }];
}
const FAILED_TURN: Record<string, string> = {
  blocked: '任务被策略阻止',
  // 普通成员改不了输出上限，提示只给他们能做的下一步
  'max-tokens': '回复内容太长，超出了单次输出上限，已保留生成的部分；可回复“继续”让它接着完成',
  aborted: '任务已中止',
  interrupted: '任务已中止',
};

function textOf(blocks: any[], type: string, separator: string) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === type)
    .map((block) => block.text)
    .join(separator);
}
function sourceOf(type: string | undefined): KernelEvent['source'] {
  if (type?.startsWith('tool/')) return 'tools';
  if (type?.startsWith('assistant/') || type?.startsWith('request/')) return 'llm';
  return 'agent';
}

/**
 * 翻译一条 dsh 通知。calls 是本进程内的工具调用记录（callId → 调用参数），
 * 用来给 tool_result 和审批请求补上工具名与参数。
 */
export function translateNotification(method: string, params: any, calls: Map<string, any>): Translated[] {
  const plugin = translatePluginEvent(method, params, calls);
  if (plugin) return plugin;
  if (method !== SESSION_EVENT) return [];

  const event = params?.event ?? {};
  const data = event.data ?? {};
  // 原始轨迹保留给审计与排障；业务事件在下面单独翻译
  const out: Translated[] = [{ kind: 'trajectory', payload: event, source: sourceOf(event.type) }];
  if (event.type === 'turn/end') {
    const reason = data.reason?.kind;
    if (reason === 'error') out.push({ failure: data.reason.error?.message ?? '执行内核报告错误' });
    else if (FAILED_TURN[reason]) out.push({ failure: FAILED_TURN[reason] });
  } else if (event.type === 'compaction/start' || event.type === 'compaction/end') {
    // 对话过长时 dsh 自动压缩上下文（期间模型在后台生成摘要）：给页面一个“正在整理”的状态
    const phase = event.type === 'compaction/start' ? 'start' : data.error ? 'failed' : 'end';
    out.push({ kind: 'compaction', payload: { phase }, source: 'agent' });
  } else if (event.type === 'tool/call') {
    calls.set(data.callId, data);
    out.push({
      kind: 'tool_use_start',
      payload: { toolCallId: data.callId, tool: data.name, arguments: data.arguments },
      source: 'tools',
    });
  } else if (event.type === 'tool/result') {
    const message = data.message ?? {};
    const call = calls.get(message.toolCallId);
    out.push({
      kind: 'tool_result',
      payload: {
        toolCallId: message.toolCallId,
        tool: call?.name,
        arguments: call?.arguments,
        result: call?.presented
          ? JSON.stringify({ files: call.presented })
          : textOf(message.content, 'text', '\n'),
        isError: message.isError ?? false,
      },
      source: 'tools',
    });
  } else if (event.type === 'assistant/message') {
    const blocks = data.message?.content ?? [];
    const text = textOf(blocks, 'text', '\n');
    const reasoning = textOf(blocks, 'reasoning', '\n\n');
    // 只思考未出正文的步骤（工具调用步）同样落一条消息，过程展示完整。
    if (text || reasoning)
      out.push({
        kind: 'message',
        payload: {
          text,
          ...(reasoning ? { reasoning } : {}),
          runtimeMessageId: data.message.id,
          partial: data.interrupted ?? false,
        },
        source: 'llm',
      });
    const usage = data.usage;
    if (usage)
      out.push({
        kind: 'cost_tick',
        payload: {
          tokensIn: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          tokensOut: usage.outputTokens ?? 0,
          ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
        },
        source: 'llm',
      });
  }
  return out;
}
