/**
 * AgentKernel 的 dsh 实现。
 *
 * M0 POC 要点（docs/02-技术方案 §十二）：
 *  1. 以 headless profile 拉起 dsh（Cordis 插件树在进程内，一棵插件树多会话）
 *  2. 挂平台插件包（src/plugins/*，镜像内置白名单，运行期不装包）
 *  3. createSession = scenario-bootstrap 应用 Bundle(profile patch + 技能物化 + 模式)
 *  4. onEvent = tap dsh 的 session/event 事件流（append-only log 不变量）
 *
 * 注意：dsh 处于 Developer Preview，本层是它与控制面之间的唯一防火墙，
 * 严禁把 cordis/dsh 的类型泄漏到控制面协议里。
 */

import type { AgentKernel, Bundle, KernelEvent, SessionHandle, TurnOpts, UserCtx } from './types.js';
import { SessionRegistry } from './session-registry.js';

export class DshKernel implements AgentKernel {
  private registry = new SessionRegistry(Number(process.env.RUNNER_MAX_SESSIONS ?? 20));

  async createSession(bundle: Bundle, user: UserCtx): Promise<SessionHandle> {
    // TODO(M0): 校验 Bundle 签名与 plugin_mounts 白名单（plugin_registry 对齐）
    // TODO(M0): dsh headless 起会话 + scenario-bootstrap 应用 bundle.profile_patch
    // TODO(M0): sandbox-remote 为会话申请独立沙箱容器；ent-storage hydrate
    throw new Error('M0 POC: 见 docs/02-技术方案 §十二 M0 任务清单');
  }

  async sendTurn(sessionId: string, message: string, opts?: TurnOpts): Promise<void> {
    // TODO(M0): registry.lock(sessionId) 会话级串行化；dsh agent loop 驱动
    throw new Error('M0 POC');
  }

  onEvent(sessionId: string, listener: (e: KernelEvent) => void): () => void {
    // TODO(M0): 订阅 dsh session/event，seq 单调递增（SSE 重连锚点）
    return () => {};
  }

  async interrupt(sessionId: string): Promise<void> {}
  async fork(sessionId: string, atSeq: number): Promise<SessionHandle> {
    // dsh 原生：resume/fork/replay 共用同一事件流 —— 这是选它的核心理由之一
    throw new Error('M0 POC');
  }
  replay(sessionId: string): AsyncIterable<KernelEvent> {
    throw new Error('M0 POC');
  }
  async resolveApproval(sessionId: string, ticketId: string, decision: unknown): Promise<void> {}
  async disposeSession(sessionId: string): Promise<void> {
    // TODO(M1): 检查点 flush（ent-storage → S3）后卸载会话级插件
  }
}
