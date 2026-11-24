/**
 * 一个会话的 dsh 引擎实例：启动子进程、接续会话、执行一轮、关闭。
 * 内核通过 EngineHost 接收已翻译好的 Forge 事件、处理审批；它看不到任何 dsh 方法名、包名或事件结构。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KernelEvent } from '../types.js';
import type { RuntimeModel } from '../runtime-model.js';
import { DshProcess } from './process.js';
import {
  DSH_PROFILE,
  HOST_REQUEST,
  QUESTION_REPLY,
  RPC,
  approvalReason,
  approvalReply,
  translateNotification,
  type ApprovalOutcome,
} from './protocol.js';
import { WEB_SEARCH_KEY_ENV, buildRuntimePatch, type RuntimePlan } from './runtime-config.js';

export interface ApprovalRequest {
  tool: string;
  callId: string;
  arguments: unknown;
  reason?: string;
}
/** 内核提供给引擎的回调 */
export interface EngineHost {
  emit(kind: string, payload: unknown, source: KernelEvent['source']): void;
  /** 本轮失败：explicit 为插件主动上报的错误（总是记录），否则只在尚无错误时记录 */
  fail(message: string, explicit?: boolean): void;
  /** 工具需要用户确认：内核负责票据、超时与取消，返回最终结论 */
  approve(request: ApprovalRequest): Promise<ApprovalOutcome>;
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
  private readonly calls = new Map<string, any>();
  /** 沙箱探测结果（只在 probeSandbox 时等待；超时则为 undefined） */
  sandbox: SandboxProbe | undefined;
  private constructor(private readonly proc: DshProcess) {}

  static async start(opts: EngineOptions, host: EngineHost): Promise<DshEngine> {
    const patchPath = join(opts.dir, 'runtime.patch.json');
    await writeFile(patchPath, JSON.stringify(buildRuntimePatch(opts.plan, opts.groupTools), null, 2), {
      mode: 0o600,
    });
    const proc = new DshProcess();
    const engine = new DshEngine(proc);
    let probed: (probe: SandboxProbe) => void = () => {};
    const probe = new Promise<SandboxProbe>((resolve) => (probed = resolve));
    proc.onNotification((method, params) => {
      for (const item of translateNotification(method, params, engine.calls)) {
        if ('failure' in item) host.fail(item.failure, item.explicit);
        else if (item.kind === 'sandbox') probed(item.payload as SandboxProbe);
        else host.emit(item.kind, item.payload, item.source);
      }
    });
    proc.hostHandlers.set(HOST_REQUEST.approval, async (params: any) =>
      approvalReply(
        await host.approve({
          tool: params.toolName,
          callId: params.callId,
          arguments: engine.calls.get(params.callId)?.arguments ?? {},
          reason: approvalReason(params.reason),
        }),
      ),
    );
    proc.hostHandlers.set(HOST_REQUEST.question, async () => QUESTION_REPLY);
    try {
      await proc.start({
        profile: DSH_PROFILE,
        patchPaths: [patchPath],
        // 密钥类变量名都含 SECRET/KEY：dsh 为 stdio MCP 子进程清洗环境变量时会剔除，外部程序拿不到
        env: {
          FORGE_MODEL_SECRET_CONFIG: JSON.stringify(opts.model),
          ...(opts.plan.web?.apiKey ? { [WEB_SEARCH_KEY_ENV]: opts.plan.web.apiKey } : {}),
        },
      });
      await withTimeout(
        proc.request(RPC.initialize, {
          cwd: opts.cwd,
          // forge-runtime 注册的模型出口适配器
          provider: 'forge-gateway',
          model: opts.model.model,
          maxTokens: opts.plan.outputTokens,
          approvalRequests: true,
        }),
        30000,
      );
      if (opts.resume) await withTimeout(proc.request(RPC.resume, { sessionId: opts.sessionId }), 15000);
      if (opts.probeSandbox) engine.sandbox = await withTimeout(probe, SANDBOX_PROBE_MS).catch(() => undefined);
    } catch (error) {
      await proc.dispose();
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
      this.proc.request(RPC.prompt, { sessionId, contentBlocks: [{ type: 'text', text }] }),
      30000,
    );
    accepted?.();
    await withTimeout(this.proc.request(RPC.wait, { sessionId }), waitMs);
  }

  /** 中止即关闭进程：dsh 没有原生中断 RPC，下一轮从会话日志接续 */
  dispose() {
    return this.proc.dispose();
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
