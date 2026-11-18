/** 业务内核：独立 dsh 进程、真实模型出口、受限文件工具、逐次审批。 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, lstat, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DshProcess } from './dsh-process.js';
import { mimeType } from './mime.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { PluginWorkerClient } from '../plugin-worker-client.js';
import type { AgentKernel, Bundle, KernelEvent, SessionHandle, TurnOpts, UserCtx } from './types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRESENT_TOOL = 'workspace_present';
/**
 * 基础能力：每个会话默认加载，不需要场景逐个授权。仍以平台策略（allowedTools）为上限，
 * 写入仍按策略逐次审批。场景 Bundle 是发布时的快照，由 Runner 统一补齐，已发布场景与存量会话同样生效。
 */
export const BASE_TOOLS = ['current_time', 'workspace_list', 'workspace_read', 'workspace_write'] as const;
/** 版本固定的 DSH 搜索插件（随 dsh 版本锁定）提供的工具；随读取权限开放，路径由 forge-runtime 限制在工作区内。 */
export const SEARCH_TOOLS = ['glob', 'grep'] as const;
export const SEARCH_PLUGIN = '@deepseek-ai/dsh-tool-fs-search';
export interface SessionToolset {
  /** forge-runtime 白名单：模型可见、允许执行的全部工具 */
  allowed: string[];
  /** 是否加载 DSH 搜索插件 */
  search: boolean;
}
/**
 * 计算会话工具集：基础能力 ∪ 场景声明，Forge 内置工具以平台策略为上限；
 * 写入开放时附带交付声明，读取开放时附带 glob/grep 搜索；插件工具原样保留。
 */
export function sessionToolset(meta: Record<string, any> | undefined): SessionToolset {
  const policy = meta?.policy ?? {};
  const ceiling: string[] | undefined = Array.isArray(policy.allowedTools) ? policy.allowedTools : undefined;
  const declared = Array.isArray(meta?.builtin_tools) ? (meta.builtin_tools as string[]) : [];
  const pluginTools = Array.isArray(meta?.plugin_tools) ? (meta.plugin_tools as string[]) : [];
  const withinCeiling = (name: string) => !ceiling || ceiling.includes(name);
  // 场景声明的其他内置插件工具（如 Skill 编辑的 skill_*）沿用原有规则：以策略为上限。
  // Skill 编辑会话的策略上限只含 skill_*，因此不会被附加基础能力。
  const builtin = [...new Set([...BASE_TOOLS, ...declared])].filter(withinCeiling);
  const search = builtin.includes('workspace_read');
  const allowed = [
    ...builtin,
    ...(builtin.includes('workspace_write') ? [PRESENT_TOOL] : []),
    ...(search ? SEARCH_TOOLS : []),
    // 受管插件工具已由控制面按企业插件策略与场景授权筛选，不再按内置工具策略过滤。
    ...pluginTools,
  ];
  return { allowed: [...new Set(allowed)], search };
}
const MAX_RAW_BYTES = 20 * 1024 * 1024;
/** 清单上限：远高于插件的 100 个文件配额；达到上限时标记 truncated，控制面不会据此删除记录 */
export const MAX_LISTED_FILES = 1000;
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
export function validModel(model?: RuntimeModel): model is RuntimeModel {
  return Boolean(
    model &&
    typeof model.baseUrl === 'string' &&
    model.baseUrl &&
    typeof model.model === 'string' &&
    model.model &&
    (model.apiKey === undefined || typeof model.apiKey === 'string') &&
    (model.contextWindow === undefined ||
      (Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0)),
  );
}
/**
 * compaction-basic 默认额外预留 65,536 tokens 余量：窗口 W − 输出上限 O ≤ 65,536 时（例如常见的 64K 模型），
 * 自动压缩会被静默跳过，且会话内切换到该模型会被 dsh 直接拒绝。按模型窗口缩放余量，
 * 大窗口模型仍不超过官方默认值；摘要输出上限与普通回复一致，避免向网关请求超出模型能力的 max_tokens。
 */
export function compactionConfig(contextWindow: number, outputTokens: number) {
  const budget = contextWindow - outputTokens;
  const headroomTokens = Math.max(1024, Math.min(65536, Math.floor(budget * 0.25)));
  return { headroomTokens, maxTokens: Math.max(1, Math.min(headroomTokens, outputTokens)) };
}
/** 运行配置指纹：任一项变化都必须以新配置重启 dsh 进程（模型与密钥只在启动时注入）。 */
export function modelFingerprint(model: RuntimeModel) {
  return createHash('sha256')
    .update(JSON.stringify([model.baseUrl, model.model, model.apiKey ?? '', model.contextWindow ?? 0]))
    .digest('hex');
}

export class DshKernel implements AgentKernel {
  private sessions = new Map<string, Entry>();
  constructor(private readonly pluginWorker?: PluginWorkerClient) {}
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
    if (!validModel(model)) throw failure('请先在模型中心配置真实模型网关', 422);
    if (this.size >= this.capacity) throw failure('Runner 会话容量已满，请归档暂不使用的会话', 429);
    const approvedPlugins = new Set(['forge-runtime', 'skill-authoring', 'forge-plugin-bridge']);
    if (!Array.isArray(bundle.plugin_mounts) || bundle.plugin_mounts.some((p) => !approvedPlugins.has(p)))
      throw failure('包含未审核的插件', 422);
    if (bundle.plugin_mounts.includes('skill-authoring') && !bundle.meta?.skillAuthoring)
      throw failure('Skill 编辑插件缺少当前 Skill 草稿上下文', 422);
    const pluginBindings = Array.isArray(bundle.meta?.pluginBindings) ? bundle.meta.pluginBindings : [];
    const pluginTools = Array.isArray(bundle.meta?.plugin_tools) ? bundle.meta.plugin_tools : [];
    if (bundle.plugin_mounts.includes('forge-plugin-bridge') !== pluginBindings.length > 0)
      throw failure('受管插件装配信息不完整', 422);
    const boundToolNames = pluginBindings.flatMap((binding: any) =>
      Array.isArray(binding?.tools) ? binding.tools.map((tool: any) => tool?.name) : [],
    );
    if (
      pluginTools.some((name) => typeof name !== 'string' || !name) ||
      new Set(pluginTools).size !== pluginTools.length ||
      new Set(boundToolNames).size !== boundToolNames.length ||
      pluginTools.length !== boundToolNames.length ||
      pluginTools.some((name) => !boundToolNames.includes(name))
    )
      throw failure('插件工具装配信息无效', 422);
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
    const pluginTools = (entry.bundle.meta?.plugin_tools as string[]) ?? [];
    const toolset = sessionToolset(entry.bundle.meta);
    const pluginBindings = Array.isArray(entry.bundle.meta?.pluginBindings)
      ? entry.bundle.meta.pluginBindings
      : [];
    const plugin = {
      id: 'forge-runtime',
      name: pathToFileURL(join(ROOT, 'forge-runtime-plugin', 'index.js')).href,
      config: {
        workspace: entry.workspace,
        allowedTools: toolset.allowed,
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
            allowedTools: toolset.allowed,
          },
        }
      : null;
    if (entry.bundle.plugin_mounts.includes('forge-plugin-bridge') && !this.pluginWorker)
      throw failure('受管插件 Worker 不可用，已拒绝启动插件会话', 503);
    const bridgeBindings = pluginBindings.map((binding: any) => ({
      package: binding.package,
      displayName: binding.displayName,
      version: binding.version,
      artifactHash: binding.artifactHash,
      runtime: binding.runtime,
      tools: binding.tools,
    }));
    const pluginBridge = entry.bundle.plugin_mounts.includes('forge-plugin-bridge')
      ? {
          id: 'forge-plugin-bridge',
          name: pathToFileURL(join(ROOT, 'forge-plugin-bridge', 'index.js')).href,
          config: {
            bindings: bridgeBindings,
            allowedTools: pluginTools,
            gatewayUrl: this.pluginWorker!.url,
            // execution metadata stays inside the signed Worker lease, rather than DSH config.
            lease: this.pluginWorker!.issueLease(entry.id, pluginBindings),
          },
        }
      : null;
    const patch = [
      { id: 'sessions', config: { root: join(dir, 'session-log'), compression: 'none' } },
      {
        id: 'compaction-basic',
        config: compactionConfig(entry.model.contextWindow || 64000, policy.maxOutputTokens ?? 4096),
      },
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
          // 基础搜索能力：ripgrep 由依赖包内置，不需要宿主安装；结果上限保持较小，避免撑大上下文。
          ...(toolset.search
            ? [
                {
                  id: 'forge-fs-search',
                  name: SEARCH_PLUGIN,
                  config: {
                    sampleOverCapGlobResults: false,
                    globMaxResults: 100,
                    grepMaxMatches: 100,
                    timeoutMs: 15000,
                  },
                },
              ]
            : []),
          ...(pluginBridge ? [pluginBridge] : []),
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
    const system = buildSystemPrompt(entry.bundle.profile_patch.systemPrompt, toolset.allowed);
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
    else if (method === 'forge.reasoning_delta') this.emit(entry, 'reasoning_delta', params, 'llm');
    else if (method === 'forge.error') {
      entry.error = params.message;
      this.emit(entry, 'error', params);
    } else if (method === 'forge.policy') this.emit(entry, 'policy_decision', params, 'tools');
    else if (method === 'forge.skill_revision') this.emit(entry, 'skill_revision', params, 'tools');
    else if (method === 'forge.plugin_loaded') this.emit(entry, 'plugin_loaded', params, 'tools');
    else if (method === 'forge.plugin_call') this.emit(entry, 'plugin_call', params, 'tools');
    else if (method === 'forge.artifact') this.emit(entry, 'files', { files: [params] }, 'tools');
    else if (method === 'forge.present') this.emit(entry, 'deliverables', params, 'tools');
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
        const blocks = data.message?.content ?? [];
        const text = blocks
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('\n');
        const reasoning = blocks
          .filter((block: any) => block.type === 'reasoning')
          .map((block: any) => block.text)
          .join('\n\n');
        // 只思考未出正文的步骤（工具调用步）同样落一条消息，过程展示完整。
        if (text || reasoning)
          this.emit(
            entry,
            'message',
            {
              text,
              ...(reasoning ? { reasoning } : {}),
              runtimeMessageId: data.message.id,
              partial: data.interrupted ?? false,
            },
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
              ...(data.usage.reasoningTokens ? { reasoningTokens: data.usage.reasoningTokens } : {}),
            },
            'llm',
          );
      }
    }
  }
  /**
   * 执行一轮对话。model 为控制面下发的本轮运行配置：与当前进程不同（会话内切换模型）时，
   * 先结束旧进程，再以新配置启动并通过 session/resume 接续同一份会话日志。
   */
  async sendTurn(id: string, message: string, _opts?: TurnOpts, model?: RuntimeModel) {
    const entry = this.entry(id);
    if (entry.busy) throw failure('会话正在执行，请等待或中止', 409);
    if (model !== undefined && !validModel(model)) throw failure('本轮模型配置无效', 422);
    entry.busy = true;
    entry.error = null;
    try {
      if (model && modelFingerprint(model) !== modelFingerprint(entry.model)) {
        const previous = entry.proc;
        entry.proc = null;
        await previous?.dispose();
        entry.model = model;
      }
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
    const out: { path: string; bytes: number; mime: string; modifiedAt: string; sha256: string }[] = [];
    const walk = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 8 || out.length >= MAX_LISTED_FILES) return;
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink() || item.name.startsWith('.')) continue;
        const full = join(dir, item.name);
        if (item.isDirectory()) await walk(full, depth + 1);
        else if (item.isFile()) {
          const stat = await lstat(full);
          const path = full
            .slice(root.length + 1)
            .split(sep)
            .join('/');
          // 内容哈希供控制面增量同步：未变化的文件无需重新拉取
          const sha256 = createHash('sha256')
            .update(await readFile(full))
            .digest('hex');
          out.push({
            path,
            bytes: stat.size,
            mime: mimeType(path),
            modifiedAt: stat.mtime.toISOString(),
            sha256,
          });
        }
        if (out.length >= MAX_LISTED_FILES) break;
      }
    };
    await walk(root);
    return out;
  }
  /** 校验并解析工作区内的文件路径：禁止越界、隐藏文件与符号链接。 */
  private async workspaceFile(id: string, path: string) {
    const root = await this.workspace(id),
      full = resolve(root, path ?? '');
    if (!path || full === root || !full.startsWith(root + sep)) throw failure('文件路径超出会话工作区', 422);
    let current = root;
    try {
      for (const part of full.slice(root.length + 1).split(sep)) {
        if (part.startsWith('.')) throw failure('不允许读取隐藏文件', 422);
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink()) throw failure('不允许符号链接', 422);
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw failure('文件不存在或已被删除', 404);
      throw error;
    }
    const stat = await lstat(full);
    if (!stat.isFile()) throw failure('不是普通文件', 422);
    return { full, stat };
  }
  async readFile(id: string, path: string) {
    const { full, stat } = await this.workspaceFile(id, path);
    if (stat.size > 256000) throw failure('仅支持 256 KB 内的文本文件', 422);
    return readFile(full, 'utf8');
  }
  /** 用户在界面上删除文件：执行中拒绝，删除后清理空目录。 */
  async deleteFile(id: string, path: string) {
    if (this.sessions.get(id)?.busy) throw failure('会话正在执行，请等待本轮结束后再删除文件', 409);
    const root = await this.workspace(id);
    const { full } = await this.workspaceFile(id, path);
    await unlink(full);
    for (let dir = dirname(full); dir !== root && dir.startsWith(root + sep); dir = dirname(dir)) {
      try {
        await rmdir(dir);
      } catch {
        break; // 目录非空
      }
    }
  }
  /** 保留期限到期：清空会话工作区（目录本身保留，会话仍可继续使用）。 */
  async purgeWorkspace(id: string) {
    if (this.sessions.get(id)?.busy) throw failure('会话正在执行，暂不能清理文件', 409);
    const root = await this.workspace(id);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  /** 原始字节读取：用于任意类型文件的预览与下载（工作区总量本身不超过 10 MB）。 */
  async readRaw(id: string, path: string) {
    const { full, stat } = await this.workspaceFile(id, path);
    if (stat.size > MAX_RAW_BYTES) throw failure('文件过大，无法读取', 413);
    return { data: await readFile(full), mime: mimeType(full), bytes: stat.size };
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
