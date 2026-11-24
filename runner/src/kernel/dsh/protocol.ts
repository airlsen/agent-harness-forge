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
/** dsh → Runner 的宿主请求（需要回复） */
export const HOST_REQUEST = {
  approval: 'approval/request',
  question: 'user-question/ask',
} as const;
/** dsh → Runner 的会话日志通知 */
export const SESSION_EVENT = 'session.event';
/** contract-check 用：高级 run API 与恢复会话所依赖的协议消息 */
export const SDK_METHODS = ['initialize', 'session/query', 'session/resume', ...Object.values(HOST_REQUEST), SESSION_EVENT];

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
 * 翻译结果：普通事件，或「本轮失败」。失败只记第一次（例如中止后 dsh 报告的 aborted 不覆盖用户中止）。
 */
export type Translated = { kind: string; payload: unknown; source: KernelEvent['source'] } | { failure: string };

/** 错误信息里回显的密钥替换掉（模型网关的报错可能原样带回请求里的凭据） */
export function redact(message: string, secret?: string) {
  return secret ? message.split(secret).join('***') : message;
}

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

/**
 * 本轮错误的中文说明。模型请求失败时 dsh（llm-pi-ai）给出英文原因和分类码（如 `401 …` + AUTH）；
 * 换成业务用户能看懂、知道下一步做什么的说明，保留服务端给出的原因（截断到 300 字）。
 * 只有鉴权失败才提示检查凭据；分类不认识的错误原样返回。
 */
export function turnFailure(error: any): string {
  const raw = String(error?.message ?? '').replace(/\s+/g, ' ').trim();
  const code = String(error?.code ?? '');
  const status = /^([45]\d\d)\b/.exec(raw)?.[1];
  const detail = (status ? raw.slice(status.length) : raw).replace(/^[\s:：-]+/, '').slice(0, 300);
  const reason = detail ? `：${detail}` : '';
  switch (code) {
    case 'AUTH':
      return `模型网关拒绝访问（HTTP ${status ?? 401}），请检查模型中心的凭据${reason}`;
    case 'MISSING_CREDENTIAL':
    case 'INVALID_CREDENTIAL':
      return '模型凭据缺失或格式不正确，请检查模型中心的凭据';
    case 'QUOTA':
    case 'ACCOUNT_QUOTA':
      return `模型服务的额度已用完，请联系管理员${reason}`;
    case 'RATE_LIMIT':
      return `模型服务繁忙（请求过于频繁），已自动重试仍未成功，请稍后再试${reason}`;
    case 'CONTEXT_WINDOW_EXCEEDED':
      return '对话内容超出了模型能处理的长度，请新建会话，或换用上下文更大的模型';
    case 'EMPTY_RESPONSE':
      return '模型返回了空响应，请重试';
    case 'TIMEOUT':
      return '模型请求超时，请稍后重试或联系管理员检查模型服务';
    case 'TRANSPORT':
      return '模型响应流提前结束或连接中断，请重试';
  }
  // 回复被模型服务的内容审核拦截（finish_reason 为 content_filter 等非正常结束）
  if (/finish_reason:\s*(?!stop|length|tool_calls)\w+/i.test(raw))
    return '模型响应被拦截或未能正常完成，请检查模型服务';
  if (status === '404') return `模型网关 HTTP 404，请检查模型中心的地址和模型名${reason}`;
  if (status) return `模型网关 HTTP ${status}${reason || '，请稍后重试或联系管理员检查模型服务'}`;
  if (code === 'PI_AI_ERROR' || code === 'SERVER') return `模型请求失败${reason}`;
  return raw || '执行内核报告错误';
}

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
    if (reason === 'error') out.push({ failure: turnFailure(data.reason.error) });
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
