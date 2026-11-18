/** 业务内核：独立 dsh 进程、真实模型出口、受限文件工具、逐次审批。 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DshProcess } from './dsh-process.js';
import type { AgentKernel, Bundle, KernelEvent, SessionHandle, TurnOpts, UserCtx } from './types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = resolve(process.env.FORGE_RUNNER_DATA_DIR ?? join(ROOT, 'data', 'sessions'));
export interface RuntimeModel {
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow?: number;
}
type Pending = { resolve: (value: unknown) => void; timer: NodeJS.Timeout };
type Entry = {
  id: string;
  bundle: Bundle;
  model: RuntimeModel;
  proc: DshProcess | null;
  events: KernelEvent[];
  listeners: Set<(event: KernelEvent) => void>;
  seq: number;
  busy: boolean;
  hasHistory: boolean;
  error: string | null;
  workspace: string;
  pending: Map<string, Pending>;
  calls: Map<string, any>;
};
function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export class DshKernel implements AgentKernel {
  private sessions = new Map<string, Entry>();
  get size() {
    return this.sessions.size;
  }
  get capacity() {
    return Math.max(1, Number(process.env.RUNNER_MAX_SESSIONS ?? 4));
  }
  has(id: string) {
    return this.sessions.has(id);
  }
  isBusy(id: string) {
    return this.entry(id).busy;
  }
  private entry(id: string) {
    const entry = this.sessions.get(id);
    if (!entry) throw failure('执行会话不存在，Runner 可能已重启；请创建新会话', 404);
    return entry;
  }
  private emit(entry: Entry, kind: string, payload: any, source: KernelEvent['source'] = 'system') {
    const event: KernelEvent = { seq: ++entry.seq, kind, payload, source, ts: Date.now() };
    entry.events.push(event);
    if (entry.events.length > 20000) entry.events.shift();
    for (const listener of entry.listeners) listener(event);
  }
  private cancelApprovals(entry: Entry) {
    for (const [ticketId, pending] of entry.pending) {
      clearTimeout(pending.timer);
      entry.pending.delete(ticketId);
      this.emit(entry, 'approval_resolved', { ticketId, action: 'cancelled' }, 'tools');
      pending.resolve({ outcome: 'cancelled' });
    }
  }
  async createSession(bundle: Bundle, _user: UserCtx, model?: RuntimeModel): Promise<SessionHandle> {
    if (!model?.baseUrl || !model.model) throw failure('请先在模型中心配置真实模型网关', 422);
    if (this.size >= this.capacity) throw failure('Runner 会话容量已满，请归档暂不使用的会话', 429);
    const approvedPlugins = new Set(['forge-runtime', 'skill-authoring']);
    if (!Array.isArray(bundle.plugin_mounts) || bundle.plugin_mounts.some((p) => !approvedPlugins.has(p)))
      throw failure('包含未审核的插件', 422);
    if (bundle.plugin_mounts.includes('skill-authoring') && !bundle.meta?.skillAuthoring)
      throw failure('Skill 编辑插件缺少当前 Skill 草稿上下文', 422);
    const id = randomUUID();
    const entry: Entry = {
      id,
      bundle,
      model,
      proc: null,
      events: [],
      listeners: new Set(),
      seq: 0,
      busy: false,
      hasHistory: false,
      error: null,
      workspace: join(DATA, id, 'workspace'),
      pending: new Map(),
      calls: new Map(),
    };
    this.sessions.set(id, entry);
    try {
      await this.boot(entry);
    } catch (error) {
      await entry.proc?.dispose();
      this.sessions.delete(id);
      throw error;
    }
    return {
      sessionId: id,
      forgeSessionId: 0,
      bundleHash: createHash('sha256').update(JSON.stringify(bundle)).digest('hex'),
    };
  }
  private async boot(entry: Entry) {
    const dir = join(DATA, entry.id);
    await mkdir(entry.workspace, { recursive: true, mode: 0o700 });
    const policy = (entry.bundle.meta?.policy as any) ?? {};
    const allowed = (entry.bundle.meta?.builtin_tools as string[]) ?? [];
    const plugin = {
      id: 'forge-runtime',
      name: pathToFileURL(join(ROOT, 'forge-runtime-plugin', 'index.js')).href,
      config: {
        workspace: entry.workspace,
        allowedTools: allowed.filter((name) => (policy.allowedTools ?? allowed).includes(name)),
        requireWriteApproval: policy.requireWriteApproval ?? true,
        maxOutputTokens: policy.maxOutputTokens ?? 4096,
        requestTimeoutSeconds: policy.requestTimeoutSeconds ?? 120,
      },
    };
    const skillAuthoringPlugin = entry.bundle.plugin_mounts.includes('skill-authoring')
      ? {
          id: 'skill-authoring',
          name: pathToFileURL(join(ROOT, 'skill-authoring-plugin', 'index.js')).href,
          config: {
            ...((entry.bundle.meta?.skillAuthoring as Record<string, unknown>) ?? {}),
            allowedTools: allowed.filter((name) => (policy.allowedTools ?? allowed).includes(name)),
          },
        }
      : null;
    const patch = [
      { id: 'sessions', config: { root: join(dir, 'session-log'), compression: 'none' } },
      ...[
        'persistent-bash',
        'persistent-pwsh',
        'terminal-bash',
        'terminal-pwsh',
        'tool-working-directory',
        'tool-fs',
      ].map((id) => ({ id, disabled: true })),
      {
        insert: [
          { id: 'forge-user-approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: 'ask' } },
          plugin,
          ...(skillAuthoringPlugin ? [skillAuthoringPlugin] : []),
        ],
      },
    ];
    const patchPath = join(dir, 'runtime.patch.json');
    await writeFile(patchPath, JSON.stringify(patch, null, 2), { mode: 0o600 });
    const proc = new DshProcess();
    entry.proc = proc;
    proc.onNotification((method, params: any) => this.notification(entry, method, params));
    proc.hostHandlers.set(
      'approval/request',
      (params: any) =>
        new Promise((resolve) => {
          const ticketId = randomUUID();
          const milliseconds = (policy.approvalTimeoutSeconds ?? 120) * 1000;
          const timer = setTimeout(() => {
            entry.pending.delete(ticketId);
            this.emit(entry, 'approval_resolved', { ticketId, action: 'timeout' }, 'tools');
            resolve({ outcome: 'rejected' });
          }, milliseconds);
          entry.pending.set(ticketId, { resolve, timer });
          this.emit(
            entry,
            'approval_required',
            {
              ticketId,
              tool: params.toolName,
              callId: params.callId,
              arguments: entry.calls.get(params.callId)?.arguments ?? {},
              reason: params.reason,
              timeoutSeconds: milliseconds / 1000,
            },
            'tools',
          );
        }),
    );
    proc.hostHandlers.set('user-question/ask', async () => ({ cancelled: true }));
    const prompt = entry.bundle.profile_patch.systemPrompt as any;
    const system =
      typeof prompt === 'object'
        ? [
            prompt.identity,
            prompt.domain,
            ...(prompt.safety ?? []),
            ...(prompt.workspace ?? []),
            '所有文件操作仅限当前会话工作区。不可声称执行了未实际调用的工具。',
          ]
            .filter(Boolean)
            .join('\n\n')
        : String(prompt ?? '你是 Forge 企业智能体，请准确、清晰地回答用户。');
    await proc.start({
      binPath: join(ROOT, 'scripts', 'dsh-launch.mjs'),
      profile: 'sdk-minimal',
      patchPaths: [patchPath],
      env: { FORGE_MODEL_CONFIG: JSON.stringify(entry.model), DSH_SYSTEM_PROMPT: system },
    });
    await timeout(
      proc.request('initialize', {
        cwd: entry.workspace,
        provider: 'forge-gateway',
        model: entry.model.model,
        maxTokens: policy.maxOutputTokens ?? 4096,
        approvalRequests: true,
      }),
      30000,
    );
    if (entry.hasHistory) await timeout(proc.request('session/resume', { sessionId: entry.id }), 15000);
  }
  private notification(entry: Entry, method: string, params: any) {
    if (method === 'forge.delta') this.emit(entry, 'message_delta', params, 'llm');
    else if (method === 'forge.error') {
      entry.error = params.message;
      this.emit(entry, 'error', params);
    } else if (method === 'forge.policy') this.emit(entry, 'policy_decision', params, 'tools');
    else if (method === 'forge.skill_revision') this.emit(entry, 'skill_revision', params, 'tools');
    else if (method === 'forge.artifact') this.emit(entry, 'files', { files: [params] }, 'tools');
    else if (method === 'session.event') {
      const event = params.event;
      this.emit(
        entry,
        'trajectory',
        event,
        event.type?.startsWith('tool/')
          ? 'tools'
          : event.type?.startsWith('assistant/') || event.type?.startsWith('request/')
            ? 'llm'
            : 'agent',
      );
      const data = event.data ?? {};
      if (
        event.type === 'turn/end' &&
        ['error', 'blocked', 'aborted', 'interrupted', 'max-tokens'].includes(data.reason?.kind) &&
        !entry.error
      ) {
        const reason = data.reason?.kind;
        entry.error =
          reason === 'error'
            ? (data.reason.error?.message ?? '执行内核报告错误')
            : reason === 'blocked'
              ? '任务被策略阻止'
              : reason === 'max-tokens'
                ? '模型输出达到长度上限，回答可能不完整；可继续对话或调整输出上限'
                : '任务已中止';
        this.emit(entry, 'error', { message: entry.error });
      }
      if (event.type === 'tool/call') {
        entry.calls.set(data.callId, data);
        this.emit(
          entry,
          'tool_use_start',
          { toolCallId: data.callId, tool: data.name, arguments: data.arguments },
          'tools',
        );
      } else if (event.type === 'tool/result') {
        const message = data.message ?? {},
          call = entry.calls.get(message.toolCallId);
        this.emit(
          entry,
          'tool_result',
          {
            toolCallId: message.toolCallId,
            tool: call?.name,
            arguments: call?.arguments,
            result: (message.content ?? [])
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text)
              .join('\n'),
            isError: message.isError ?? false,
          },
          'tools',
        );
      } else if (event.type === 'assistant/message') {
        const text = (data.message?.content ?? [])
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('\n');
        if (text)
          this.emit(
            entry,
            'message',
            { text, runtimeMessageId: data.message.id, partial: data.interrupted ?? false },
            'llm',
          );
        if (data.usage)
          this.emit(
            entry,
            'cost_tick',
            {
              tokensIn:
                (data.usage.inputTokens ?? 0) +
                (data.usage.cacheReadTokens ?? 0) +
                (data.usage.cacheWriteTokens ?? 0),
              tokensOut: data.usage.outputTokens ?? 0,
            },
            'llm',
          );
      }
    }
  }
  async sendTurn(id: string, message: string, _opts?: TurnOpts) {
    const entry = this.entry(id);
    if (entry.busy) throw failure('会话正在执行，请等待或中止', 409);
    entry.busy = true;
    entry.error = null;
    try {
      if (!entry.proc) await this.boot(entry);
      await timeout(
        entry.proc!.request('session/prompt', {
          sessionId: id,
          contentBlocks: [{ type: 'text', text: message }],
        }),
        30000,
      );
      entry.hasHistory = true;
      const policy = (entry.bundle.meta?.policy as any) ?? {};
      await timeout(
        entry.proc!.request('session/wait', { sessionId: id }),
        ((policy.requestTimeoutSeconds ?? 120) + (policy.approvalTimeoutSeconds ?? 120) + 30) * 1000,
      );
    } catch (error) {
      if (!entry.error) {
        entry.error = error instanceof Error ? error.message : '执行失败';
        this.emit(entry, 'error', { message: entry.error });
      }
      await entry.proc?.dispose();
      entry.proc = null;
    } finally {
      this.cancelApprovals(entry);
      entry.busy = false;
      this.emit(entry, 'done', { status: entry.error ? 'error' : 'idle' });
    }
  }
  onEvent(id: string, listener: (event: KernelEvent) => void) {
    const entry = this.entry(id);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }
  async interrupt(id: string) {
    const entry = this.entry(id);
    if (entry.busy && !entry.error) {
      entry.error = '任务已由用户中止';
      this.emit(entry, 'error', { message: entry.error });
    }
    this.cancelApprovals(entry);
    const proc = entry.proc;
    entry.proc = null;
    await proc?.dispose();
  }
  async fork(): Promise<SessionHandle> {
    throw failure('原生分叉尚未接入；请创建新会话', 501);
  }
  async *replay(id: string) {
    for (const event of this.entry(id).events) yield event;
  }
  async resolveApproval(id: string, ticketId: string, decision: any) {
    const entry = this.entry(id),
      pending = entry.pending.get(ticketId);
    if (!pending) throw failure('审批已过期或已处理', 409);
    if (!['approve', 'deny'].includes(decision?.action)) throw failure('无效审批动作', 422);
    clearTimeout(pending.timer);
    entry.pending.delete(ticketId);
    const allowed = decision.action === 'approve';
    this.emit(entry, 'approval_resolved', { ticketId, action: decision.action }, 'tools');
    pending.resolve({ outcome: allowed ? 'allowed-once' : 'rejected' });
  }
  async disposeSession(id: string) {
    if (!this.sessions.has(id)) return;
    await this.interrupt(id);
    this.sessions.delete(id);
  }
  async dispose() {
    await Promise.all([...this.sessions.keys()].map((id) => this.disposeSession(id)));
  }
  private async workspace(id: string) {
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id))
      throw failure('会话标识无效', 422);
    const root = join(DATA, id, 'workspace');
    try {
      if (!(await lstat(root)).isDirectory()) throw new Error();
    } catch {
      throw failure('未找到会话产物目录', 404);
    }
    return root;
  }
  async listFiles(id: string) {
    const root = await this.workspace(id);
    const out: { path: string; bytes: number }[] = [];
    const walk = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 8 || out.length >= 100) return;
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink() || item.name.startsWith('.')) continue;
        const full = join(dir, item.name);
        if (item.isDirectory()) await walk(full, depth + 1);
        else if (item.isFile())
          out.push({ path: full.slice(root.length + 1), bytes: (await lstat(full)).size });
        if (out.length >= 100) break;
      }
    };
    await walk(root);
    return out;
  }
  async readFile(id: string, path: string) {
    const root = await this.workspace(id),
      full = resolve(root, path ?? '');
    if (!path || full === root || !full.startsWith(root + sep)) throw failure('文件路径超出会话工作区', 422);
    let current = root;
    for (const part of full.slice(root.length + 1).split(sep)) {
      if (part.startsWith('.')) throw failure('不允许读取隐藏文件', 422);
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw failure('不允许符号链接', 422);
    }
    const stat = await lstat(full);
    if (!stat.isFile() || stat.size > 256000) throw failure('仅支持 256 KB 内的文本文件', 422);
    return readFile(full, 'utf8');
  }
}
function timeout<T>(promise: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('执行超时')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
