/**
 * AgentKernel 端口定义 —— 控制面只依赖这份契约（ADR-1）。
 * dsh 是它的第一个实现（./dsh-kernel.ts）；备选实现（deepagents/Hermes）可替换内核。
 * 文档：docs/02-技术方案 ADR-1 / docs/03-后端架构分析 §四
 */

/** 控制面下发的不变场景快照（backend ScenarioAssembler 编译产物） */
export interface Bundle {
  profile_patch: Record<string, unknown>;
  plugin_mounts: string[];
  skill_files: Record<string, string>;
  mcp: Array<Record<string, unknown>>;
  model_route: { primary: string; fallbacks: string[] };
  policy_ref: string;
  input_schema?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
}

export interface UserCtx {
  tenantId: string;
  userId: string;
  roles: string[];
}

export interface SessionHandle {
  sessionId: string; // 平台会话 id（与控制面一致）
  forgeSessionId: number; // 控制面 DB 主键（回调关联用）
  bundleHash: string;
}

export interface TurnOpts {
  thinking?: boolean;
  budgetTokens?: number;
  timeoutSeconds?: number;
}

export interface KernelEvent {
  seq: number;
  source: 'system' | 'llm' | 'tools' | 'agent' | 'ui';
  kind: string;
  payload: unknown;
  ts: number;
}

export interface AgentKernel {
  createSession(bundle: Bundle, user: UserCtx): Promise<SessionHandle>;
  sendTurn(sessionId: string, message: string, opts?: TurnOpts): Promise<void>;
  /** 事件流订阅：Event Bridge 与 audit-exporter 挂这里 */
  onEvent(sessionId: string, listener: (e: KernelEvent) => void): () => void;
  interrupt(sessionId: string): Promise<void>;
  fork(sessionId: string, atSeq: number): Promise<SessionHandle>;
  replay(sessionId: string): AsyncIterable<KernelEvent>;
  resolveApproval(sessionId: string, ticketId: string, decision: unknown): Promise<void>;
  disposeSession(sessionId: string): Promise<void>;
}
