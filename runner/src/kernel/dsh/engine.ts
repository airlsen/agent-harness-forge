/**
 * 一个会话的 dsh 引擎实例：启动子进程、接续会话、执行一轮、关闭。
 * 内核通过 EngineHost 接收已翻译好的 Forge 事件、处理审批；它看不到任何 dsh 方法名、包名或事件结构。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeepSeekHarness, type NotificationSubscription } from '@deepseek-ai/dsh-sdk-client';
import type { KernelEvent } from '../types.js';
import type { RuntimeModel } from '../runtime-model.js';
import {
  DSH_PROFILE,
  HOST_REQUEST,
  QUESTION_CANCELLED,
  approvalReason,
  approvalReply,
  redact,
  translateNotification,
  type ApprovalOutcome,
} from './protocol.js';
import {
  MODEL_KEY_ENV,
  MODEL_KEY_PLACEHOLDER,
  MODEL_ROUTE,
  WEB_SEARCH_KEY_ENV,
  buildRuntimePatch,
  type RuntimePlan,
} from './runtime-config.js';

export interface ApprovalRequest {
  tool: string;
  callId: string;
  arguments: unknown;
  reason?: string;
}
/** 一个问题的回答：selected 为选中的选项 label（多选可多项），custom 为自由文本（单选时覆盖 selected） */
export interface AskAnswer {
  id: string;
  selected: string[];
  custom?: string;
}
/** 用户对一批提问的最终结论：回答，或不回答（模型随后自行继续） */
export type AnswerOutcome = { answers: AskAnswer[] } | { cancelled: true };
/** 内核提供给引擎的回调 */
export interface EngineHost {
  emit(kind: string, payload: unknown, source: KernelEvent['source']): void;
  /** 本轮失败：只在尚无错误时记录 */
  fail(message: string): void;
  /** 工具需要用户确认：内核负责票据、超时与取消，返回最终结论 */
  approve(request: ApprovalRequest): Promise<ApprovalOutcome>;
  /** 模型向用户提问：内核负责票据、超时与取消；signal 在运行时撤销等待时中止 */
  ask(request: { questions: unknown[] }, context: { signal: AbortSignal }): Promise<AnswerOutcome>;
  /** 运行时撤销了挂起提问（user-question.cancelled）：取消本会话全部挂起提问 */
  cancelQuestions(): void;
}
export interface EngineOptions {
  sessionId: string;
  /** 会话数据目录：runtime patch 写在这里 */
  dir: string;
  /** dsh 工作目录（会话工作区） */
  cwd: string;
  model: RuntimeModel;
  plan: RuntimePlan;
  /** 是否等待 forge-runtime 的终端沙箱探测结果（Runner 尚不知道本机是否支持沙箱时） */
  probeSandbox?: boolean;
  /** 平台契约中各工具组的工具名 */
  groupTools: Record<string, readonly string[]>;
  /** 有历史时以 session/resume 接续磁盘上的会话日志 */
  resume: boolean;
}
/** 等待超时（区别于 dsh 报告的错误，内核据此给出可读提示） */
export class EngineTimeout extends Error {
  constructor() {
    super('执行超时');
  }
}

/** 终端沙箱探测结果：available 为 false 表示本机既没有 bwrap 也不支持 Landlock */
export interface SandboxProbe {
  available: boolean;
  enforcement?: string;
  reason?: string;
}
const SANDBOX_PROBE_MS = 10000;

export class DshEngine {
  /** 沙箱探测结果（只在 probeSandbox 时等待；超时则为 undefined） */
  sandbox: SandboxProbe | undefined;
  private constructor(
    private readonly harness: DeepSeekHarness,
    private readonly subscription: NotificationSubscription,
    private readonly notifications: Promise<void>,
  ) {}

  static async start(opts: EngineOptions, host: EngineHost): Promise<DshEngine> {
    const patchPath = join(opts.dir, 'runtime.patch.json');
    await writeFile(patchPath, JSON.stringify(buildRuntimePatch(opts.plan, opts.groupTools), null, 2), {
      mode: 0o600,
    });
    const harness = new DeepSeekHarness({
      profile: DSH_PROFILE,
      patches: [patchPath],
      dshHome: join(opts.dir, 'dsh-home'),
      cwd: opts.cwd,
      provider: MODEL_ROUTE,
      model: opts.model.model,
      maxTokens: opts.plan.outputTokens,
      approvalRequests: true,
      initializeTimeoutMs: 30000,
      shutdownTimeoutMs: 500,
      disposeEofGraceMs: 500,
      disposeGraceMs: 1500,
      // The SDK replaces the entire environment when env is supplied.
      env: {
        ...process.env,
        [MODEL_KEY_ENV]: opts.model.apiKey || MODEL_KEY_PLACEHOLDER,
        ...(opts.plan.web?.apiKey ? { [WEB_SEARCH_KEY_ENV]: opts.plan.web.apiKey } : {}),
      },
      onUserQuestion: (request, context) =>
        host.ask({ questions: Array.isArray(request?.questions) ? request.questions : [] }, context),
    });
    const client = harness.client;
    client.start();
    const subscription = client.subscribe();
    const calls = new Map<string, any>();
    let engine: DshEngine | undefined;
    let probed: (probe: SandboxProbe) => void = () => {};
    const probe = new Promise<SandboxProbe>((resolve) => (probed = resolve));
    const notifications = (async () => {
      try {
        for await (const { method, params } of subscription) {
          // 运行时撤销挂起提问：无法按 requestId 对应票据（回调参数不携带），按全会话取消处理
          if (method === QUESTION_CANCELLED) {
            host.cancelQuestions();
            continue;
          }
          for (const item of translateNotification(method, params, calls)) {
            if ('failure' in item) host.fail(redact(item.failure, opts.model.apiKey));
            else if (item.kind === 'sandbox') probed(item.payload as SandboxProbe);
            else host.emit(item.kind, item.payload, item.source);
          }
        }
      } catch (error) {
        // Closing a subscription during interrupt/reap rejects its pending next().
        if (!engine?.closing) host.fail(redact(String(error), opts.model.apiKey));
      }
    })();
    engine = new DshEngine(harness, subscription, notifications);
    client.onRequest(async (method, params) => {
      if (method !== HOST_REQUEST.approval) throw new Error(`Unsupported host request: ${method}`);
      const callId = String(params.callId ?? '');
      return approvalReply(
        await host.approve({
          tool: String(params.toolName ?? ''),
          callId,
          arguments: calls.get(callId)?.arguments ?? {},
          reason: approvalReason(params.reason),
        }),
      );
    });
    try {
      await withTimeout(harness.start(), 30000);
      if (opts.resume) await withTimeout(harness.resumeSession(opts.sessionId), 15000);
      if (opts.probeSandbox)
        engine.sandbox = await withTimeout(probe, SANDBOX_PROBE_MS).catch(() => undefined);
    } catch (error) {
      await engine.dispose();
      throw error;
    }
    return engine;
  }

  /**
   * 执行一轮：提交消息后等待本轮结束；waitMs 为整轮上限，超时抛出 EngineTimeout。
   * accepted 在消息被引擎接收（已写入会话日志）后调用。
   */
  async prompt(sessionId: string, text: string, waitMs: number, accepted?: () => void) {
    await withTimeout(
      this.harness.run(text, {
        sessionId,
        onNotification: ({ method, params }) => {
          if (
            method === 'session.event' &&
            (params.event as { type?: string } | undefined)?.type === 'agent/inbox/spliced'
          )
            accepted?.();
        },
      }),
      waitMs,
    );
  }

  /** 中止即关闭进程：dsh 没有原生中断 RPC，下一轮从会话日志接续 */
  private closing = false;
  async dispose() {
    this.closing = true;
    this.subscription.close();
    await this.harness.close();
    await this.notifications;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new EngineTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
