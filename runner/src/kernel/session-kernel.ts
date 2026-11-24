/**
 * 会话内核：会话生命周期、并发与排队、审批票据、执行日志与事件推送。
 *
 * 执行引擎经 DSH 适配层（./dsh/）接入：内核只描述「本次要什么能力」（RuntimePlan），
 * 只接收翻译好的 Forge 事件，不出现任何 dsh 包名、方法名或事件结构 —— dsh 升级只改 ./dsh/。
 *
 * 一轮的归属在 Runner：startTurn 立即返回 turnId，回合在后台执行到结束，与控制面连接无关；
 * 事件先写入会话执行日志（journal.ts），控制面按 seq 订阅、断线续读并回执。
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DshEngine,
  EngineTimeout,
  type ApprovalOutcome,
  type ApprovalRequest,
  type RuntimePlan,
  type SandboxMode,
  type SandboxProbe,
} from './dsh/index.js';
import { buildSystemPrompt } from './system-prompt.js';
import { projectOverview, resolveCodeProjects, sameProjects, type CodeProject } from './code-projects.js';
import {
  SkillContentCache,
  capabilityFingerprint,
  capabilitySummary,
  resolveCapabilities,
  type RuntimeCapabilities,
} from './capabilities.js';
import { EventJournal } from './journal.js';
import { failure, isSessionId } from './errors.js';
import { effectiveOutputTokens, modelFingerprint, validModel, type RuntimeModel } from './runtime-model.js';
import { materializeSkills } from './skill-snapshots.js';
import { GROUP_TOOLS, SHELL_TOOL, SKILL_SCRIPT_TOOL, sessionToolset } from './toolset.js';
import { MANIFEST_PLUGINS, forgePlugin } from './forge-plugins.js';
import { WorkspaceFiles } from './workspace-files.js';
import type { PluginWorkerClient } from '../plugin-worker-client.js';
import { parseManifest, type PluginBinding, type SessionManifest } from './manifest.js';
import type { KernelEvent, SessionHandle } from './types.js';

export { validModel, effectiveOutputTokens, type RuntimeModel } from './runtime-model.js';
export { MAX_LISTED_FILES } from './workspace-files.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = resolve(process.env.FORGE_RUNNER_DATA_DIR ?? join(ROOT, 'data', 'sessions'));
/** 读一个非负整数环境变量，未设、非法或为负时回退默认值；显式 0 表示关闭 */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
/** 闲置回收 TTL（秒）：会话超过该时长无交互即回收其执行进程；0 表示关闭 */
const SESSION_IDLE_TTL_SECONDS = nonNegativeInt(process.env.RUNNER_SESSION_IDLE_TTL_SECONDS, 900);
/** 存活执行进程（热会话）数量上限：超过时按最久未使用回收，给内存设硬顶；0 表示不设上限 */
const MAX_WARM_SESSIONS = nonNegativeInt(process.env.RUNNER_MAX_WARM_SESSIONS, 20);
/** 回收扫描间隔（毫秒） */
const REAP_INTERVAL_MS = 60_000;

type Pending = { resolve: (outcome: ApprovalOutcome) => void; timer: NodeJS.Timeout };
type Entry = {
  id: string;
  manifest: SessionManifest;
  model: RuntimeModel;
  engine: DshEngine | null;
  journal: EventJournal;
  listeners: Set<(event: KernelEvent) => void>;
  /** 当前回合标识：提交时同步占用，done 事件发出前清除；非空即表示有回合在排队或执行 */
  turnId: string | null;
  /** 回合已拿到并发额度、正在执行 */
  busy: boolean;
  hasHistory: boolean;
  error: string | null;
  workspace: string;
  pending: Map<string, Pending>;
  /** 当前关联的代码项目（只读挂载）；变化时下一轮以新配置重启引擎并接续会话 */
  code: CodeProject[];
  /** 本轮生效的扩展能力（场景绑定 ∪ 聊天临时选择）；变化时同样重启接续 */
  caps: RuntimeCapabilities;
  /** 最近一次交互时间戳（毫秒），供闲置回收判断进程是否可回收 */
  lastActive: number;
};
/** 一轮的输入（已校验）：沿用或替换会话当前的模型、关联代码与扩展能力 */
interface PreparedTurn {
  turnId: string;
  message: string;
  model?: RuntimeModel;
  code: CodeProject[];
  caps: RuntimeCapabilities;
}

/**
 * 助手修改草稿后同步清单中的草稿快照：执行进程之后因出错、中止、切换模型等原因重启时，
 * 编写插件从清单重新加载草稿，必须拿到最新内容，而不是会话创建时的旧草稿。
 */
export function syncSkillDraft(manifest: SessionManifest, change: any) {
  const draft = manifest.skillAuthoring;
  if (!draft || !change || typeof change !== 'object') return;
  const path = typeof change.path === 'string' ? change.path : '';
  if (change.action === 'write_file' && path && typeof change.content === 'string') {
    const files = (draft.files ?? []).filter((file) => file.path !== path);
    draft.files = [...files, { path, content: change.content }];
  } else if (change.action === 'delete_file' && path) {
    draft.files = (draft.files ?? []).filter((file) => file.path !== path);
  } else if ((change.action ?? 'update_draft') === 'update_draft' && typeof change.content === 'string') {
    draft.content = change.content;
  }
}

export class SessionKernel {
  private sessions = new Map<string, Entry>();
  /** 正在从磁盘日志恢复的会话：并发恢复同一 id 时复用同一任务，避免启动两个执行进程争用日志。 */
  private restoring = new Map<string, Promise<SessionHandle>>();
  /** 正在执行（busy）的会话数：容量按它计，而不是按存活会话总数。 */
  private activeTurns = 0;
  /** 排队等待并发额度的回合；先进先出，容量释放后依次放行。 */
  private turnQueue: Array<{ id: string; resolve: () => void; reject: (error: Error) => void }> = [];
  /** Skill 内容缓存（快照标识 → 内容）：控制面已知 Runner 有这一版时只发快照引用 */
  private skillCache = new SkillContentCache();
  /** 闲置回收定时器：空闲超时回收执行进程、热进程超上限时按最久未使用回收 */
  private reaper: NodeJS.Timeout | null = null;
  /** 会话工作区文件（清单、读取、删除、清理） */
  readonly files = new WorkspaceFiles(DATA, (id) => this.isBusy(id));
  constructor(private readonly pluginWorker?: PluginWorkerClient) {
    if (SESSION_IDLE_TTL_SECONDS > 0 || MAX_WARM_SESSIONS > 0) {
      const reaper = setInterval(() => void this.reap(), REAP_INTERVAL_MS);
      reaper.unref?.();
      this.reaper = reaper;
    }
  }
  /**
   * 本机是否支持终端沙箱（bwrap / Landlock）：首次启动会话时由 forge-runtime 探测，之后沿用。
   * 不支持时拒绝开放终端，绝不退回无沙箱的宿主机执行。
   */
  private sandboxSupport: SandboxProbe | undefined;
  /** /v1/runtime 上报：unknown（尚未有会话启动）/ enforced / unavailable */
  get sandbox() {
    if (!this.sandboxSupport) return { status: 'unknown' as const };
    return this.sandboxSupport.available
      ? { status: 'enforced' as const, enforcement: this.sandboxSupport.enforcement }
      : { status: 'unavailable' as const };
  }
  get size() {
    return this.sessions.size;
  }
  get capacity() {
    return Math.max(1, Number(process.env.RUNNER_MAX_SESSIONS ?? 4));
  }
  /** 当前正在执行的会话数（并发占用量） */
  get active() {
    return this.activeTurns;
  }
  /** 正在排队等待执行的回合数 */
  get queued() {
    return this.turnQueue.length;
  }
  has(id: string) {
    return this.sessions.has(id);
  }
  /** 会话状态（控制面对账用）：policyRef 用于判断配置是否过期，lastSeq / turnActive 用于断线续读 */
  state(id: string) {
    const entry = this.entry(id);
    return {
      exists: true,
      busy: entry.turnId !== null,
      policyRef: entry.manifest.policyRef,
      lastSeq: entry.journal.lastSeq,
      turnActive: entry.turnId !== null,
      turnId: entry.turnId,
    };
  }
  isBusy(id: string) {
    const entry = this.sessions.get(id);
    return Boolean(entry && (entry.busy || entry.turnId !== null));
  }
  isQueued(id: string) {
    return this.turnQueue.some((turn) => turn.id === id);
  }
  /**
   * 解析一轮的扩展能力：只带快照引用的 Skill 先从本会话当前能力、再从进程内缓存取内容；
   * 都没有时抛出 409 + missingSkills，控制面补发全文后重试。解析结果记入缓存。
   */
  resolveTurnCapabilities(raw: unknown, sessionId?: string): RuntimeCapabilities {
    const current = sessionId ? this.sessions.get(sessionId)?.caps.skills : undefined;
    const caps = resolveCapabilities(
      raw,
      (snapshot) => current?.find((skill) => skill.snapshot === snapshot) ?? this.skillCache.get(snapshot),
    );
    this.skillCache.remember(caps.skills);
    return caps;
  }
  private entry(id: string) {
    const entry = this.sessions.get(id);
    if (!entry) throw failure('执行会话不存在，Runner 可能已重启；请创建新会话', 404);
    return entry;
  }
  /** 记录并推送一条事件：先写执行日志（拿到 seq），再通知订阅者 */
  private emit(entry: Entry, kind: string, payload: any, source: KernelEvent['source'] = 'system') {
    if (kind === 'skill_revision') syncSkillDraft(entry.manifest, payload);
    const event = entry.journal.append(kind, payload, source);
    for (const listener of entry.listeners) listener(event);
  }
  /** 本轮失败：只记第一次（例如用户中止后引擎报告的 aborted 不覆盖） */
  private fail(entry: Entry, message: string) {
    if (entry.error) return;
    entry.error = message;
    this.emit(entry, 'error', { message });
  }
  private cancelApprovals(entry: Entry) {
    for (const [ticketId, pending] of entry.pending) {
      clearTimeout(pending.timer);
      entry.pending.delete(ticketId);
      this.emit(entry, 'approval_resolved', { ticketId, action: 'cancelled' }, 'tools');
      pending.resolve('cancelled');
    }
  }
  /** 引擎请求用户确认：发出审批事件，等待控制面裁决、超时或取消 */
  private requestApproval(entry: Entry, request: ApprovalRequest): Promise<ApprovalOutcome> {
    const policy = entry.manifest.policy;
    const milliseconds = (policy.approvalTimeoutSeconds ?? 120) * 1000;
    return new Promise((resolve) => {
      const ticketId = randomUUID();
      const timer = setTimeout(() => {
        entry.pending.delete(ticketId);
        this.emit(entry, 'approval_resolved', { ticketId, action: 'timeout' }, 'tools');
        resolve('timeout');
      }, milliseconds);
      entry.pending.set(ticketId, { resolve, timer });
      this.emit(
        entry,
        'approval_required',
        {
          ticketId,
          tool: request.tool,
          callId: request.callId,
          arguments: request.arguments,
          reason: request.reason,
          timeoutSeconds: milliseconds / 1000,
        },
        'tools',
      );
    });
  }

  async createSession(
    input: unknown,
    model?: RuntimeModel,
    codeProjects?: unknown,
    capabilities?: unknown,
  ): Promise<SessionHandle> {
    const { manifest, code, caps } = this.validateSession(input, model, codeProjects, capabilities);
    const id = randomUUID();
    const entry = this.newEntry(id, manifest, model!, code, caps, false);
    this.sessions.set(id, entry);
    try {
      await this.boot(entry);
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
    return this.handle(entry);
  }
  /**
   * 以原会话 id 重新装配执行会话（控制面调用，配置由控制面按数据库快照重新下发）：
   * - 内存中不存在（Runner 重启过）：确认磁盘上的会话日志存在，启动引擎并接续，
   *   之后的对话与重启前完全连续；日志缺失 404，日志无法恢复 410，均不会创建替代会话。
   * - 内存中已存在：替换为新配置（例如 Skill 草稿被手动修改），下一轮以新配置重启并接续同一份日志。
   */
  async restoreSession(
    id: string,
    input: unknown,
    model?: RuntimeModel,
    codeProjects?: unknown,
    capabilities?: unknown,
  ): Promise<SessionHandle> {
    if (!isSessionId(id)) throw failure('会话标识无效', 422);
    const { manifest, code, caps } = this.validateSession(input, model, codeProjects, capabilities);
    const pending = this.restoring.get(id);
    if (pending) return pending;
    const current = this.sessions.get(id);
    if (current) {
      if (this.isBusy(id)) throw failure('会话正在执行，请等待本轮结束', 409);
      const previous = current.engine;
      current.engine = null;
      await previous?.dispose();
      Object.assign(current, { manifest, model: model!, code, caps });
      return this.handle(current);
    }
    const task = this.hydrate(id, manifest, model!, code, caps);
    this.restoring.set(id, task);
    try {
      return await task;
    } finally {
      this.restoring.delete(id);
    }
  }
  private async hydrate(
    id: string,
    manifest: SessionManifest,
    model: RuntimeModel,
    code: CodeProject[],
    caps: RuntimeCapabilities,
  ): Promise<SessionHandle> {
    let logged = false;
    try {
      logged = (await readdir(join(DATA, id, 'session-log'))).length > 0;
    } catch {
      logged = false;
    }
    if (!logged) throw failure('会话日志不存在，无法接续执行上下文', 404);
    const entry = this.newEntry(id, manifest, model, code, caps, true);
    this.sessions.set(id, entry);
    try {
      await this.boot(entry);
    } catch (error) {
      this.sessions.delete(id);
      const reason = error instanceof Error ? error.message : String(error);
      // 配置类错误（模型、插件、能力）原样返回；其余视为日志不可恢复
      if ((error as any)?.statusCode) throw error;
      throw failure(`会话日志无法恢复：${reason}`, 410);
    }
    return this.handle(entry);
  }
  /** 创建与恢复共用的装配校验：插件白名单、受管插件工具、模型、关联代码与扩展能力。 */
  private validateSession(
    input: unknown,
    model: RuntimeModel | undefined,
    codeProjects: unknown,
    capabilities: unknown,
  ) {
    const manifest = parseManifest(input);
    if (!validModel(model)) throw failure('请先在模型中心配置真实模型网关', 422);
    const code = resolveCodeProjects(codeProjects);
    const caps = this.resolveTurnCapabilities(capabilities);
    const { plugins, pluginBindings } = manifest;
    if (plugins.some((p) => !MANIFEST_PLUGINS.has(p))) throw failure('包含未审核的插件', 422);
    if (plugins.includes('skill-authoring') && !manifest.skillAuthoring)
      throw failure('Skill 编辑插件缺少当前 Skill 草稿上下文', 422);
    const pluginTools = manifest.tools.plugin;
    if (plugins.includes('forge-plugin-bridge') !== pluginBindings.length > 0)
      throw failure('受管插件装配信息不完整', 422);
    const boundToolNames = pluginBindings.flatMap((binding: PluginBinding) =>
      Array.isArray(binding.tools) ? binding.tools.map((tool) => tool?.name) : [],
    );
    if (
      pluginTools.some((name) => typeof name !== 'string' || !name) ||
      new Set(pluginTools).size !== pluginTools.length ||
      new Set(boundToolNames).size !== boundToolNames.length ||
      pluginTools.length !== boundToolNames.length ||
      pluginTools.some((name) => !boundToolNames.includes(name))
    )
      throw failure('插件工具装配信息无效', 422);
    return { manifest, code, caps };
  }
  private newEntry(
    id: string,
    manifest: SessionManifest,
    model: RuntimeModel,
    code: CodeProject[],
    caps: RuntimeCapabilities,
    hasHistory: boolean,
  ): Entry {
    return {
      id,
      manifest,
      model,
      engine: null,
      // 接续的会话打开已有日志：seq 与重启前连续
      journal: EventJournal.open(join(DATA, id)),
      listeners: new Set(),
      turnId: null,
      busy: false,
      hasHistory,
      error: null,
      workspace: join(DATA, id, 'workspace'),
      pending: new Map(),
      code,
      caps,
      lastActive: Date.now(),
    };
  }
  private handle(entry: Entry): SessionHandle {
    return {
      sessionId: entry.id,
      manifestHash: createHash('sha256').update(JSON.stringify(entry.manifest)).digest('hex'),
      lastSeq: entry.journal.lastSeq,
    };
  }
  /** 按会话当前配置启动执行引擎：先算出装配需求（RuntimePlan），具体怎么装配交给 DSH 适配层 */
  private async boot(entry: Entry): Promise<void> {
    const dir = join(DATA, entry.id);
    await mkdir(entry.workspace, { recursive: true, mode: 0o700 });
    const { manifest } = entry;
    const policy = manifest.policy;
    const contextWindow = entry.model.contextWindow || 64000;
    const outputTokens = effectiveOutputTokens(contextWindow, policy.maxOutputTokens ?? undefined);
    const toolset = sessionToolset(manifest, entry.code.length > 0, entry.caps);
    const skillDirs = await materializeSkills(dir, entry.caps.skills);
    // stdio MCP 进程的工作目录：独立空目录，不指向会话工作区或代码项目
    const mcpCwd = join(dir, 'mcp');
    if (entry.caps.mcp.length) await mkdir(mcpCwd, { recursive: true, mode: 0o700 });
    const mounts = manifest.plugins;
    const pluginBindings = manifest.pluginBindings;
    if (mounts.includes('forge-plugin-bridge') && !this.pluginWorker)
      throw failure('受管插件 Worker 不可用，已拒绝启动插件会话', 503);
    const scriptSkills = entry.caps.skills.filter((skill) =>
      skill.files.some((file) => file.path.startsWith('scripts/')),
    );
    const spillDir = join(dir, 'spill');
    await mkdir(spillDir, { recursive: true, mode: 0o700 });
    const probeSandbox = this.sandboxSupport === undefined;
    // 没有终端沙箱时终端不可用；写入仍由文件沙箱与 Forge 路径守卫约束。
    if (this.sandboxSupport?.available === false && toolset.allowed.includes(SHELL_TOOL))
      throw failure('终端沙箱不可用，已拒绝开放终端；请安装 bubblewrap 或启用 Landlock', 503);
    const sandbox: SandboxMode = toolset.write ? 'workspace-write' : 'read-only';
    const plan: RuntimePlan = {
      sessionLogDir: join(dir, 'session-log'),
      spillDir,
      workspace: entry.workspace,
      contextWindow,
      outputTokens,
      model: {
        id: entry.model.model,
        baseUrl: entry.model.baseUrl,
        requestTimeoutMs: (policy.requestTimeoutSeconds ?? 300) * 1000,
      },
      allowed: toolset.allowed,
      sandbox,
      runtime: forgePlugin('forge-runtime', {
        workspace: entry.workspace,
        allowedTools: toolset.allowed,
        approvalTools: toolset.approval,
        codeProjects: entry.code.map(({ name, path }) => ({ name, path })),
        readRoots: Object.entries(skillDirs).map(([name, path]) => ({ name: `skill:${name}`, path })),
        spillDir,
        probeSandbox,
        // 系统提示在下面拼好后填入（forge-runtime 以不插值的段落注入）
        systemPrompt: '',
      }),
      plugins: [
        ...(mounts.includes('forge-plugin-bridge')
          ? [
              forgePlugin('forge-plugin-bridge', {
                bindings: pluginBindings.map((binding) => ({
                  package: binding.package,
                  displayName: binding.displayName,
                  version: binding.version,
                  artifactHash: binding.artifactHash,
                  runtime: binding.runtime,
                  tools: binding.tools,
                })),
                allowedTools: manifest.tools.plugin,
                gatewayUrl: this.pluginWorker!.url,
                // 执行元数据只放在 Runner 签发的 Worker 租约里，不进引擎配置
                lease: this.pluginWorker!.issueLease(entry.id, pluginBindings),
              }),
            ]
          : []),
        ...(mounts.includes('skill-authoring')
          ? [
              forgePlugin('skill-authoring', {
                ...(manifest.skillAuthoring ?? {}),
                allowedTools: toolset.allowed,
                // 会话工作区：草稿镜像写到其中的 .skill/（供 bash 运行），脚本产出写到 outputs/
                workspace: entry.workspace,
              }),
            ]
          : []),
        ...(toolset.allowed.includes(SKILL_SCRIPT_TOOL)
          ? [
              forgePlugin('skill-scripts', {
                // 脚本在会话工作区的 outputs/<脚本名>-<时间>/ 下运行，产出随会话文件同步
                workspace: entry.workspace,
                skills: scriptSkills.map((skill) => ({
                  name: skill.name,
                  dir: skillDirs[skill.name],
                  scripts: skill.files
                    .filter((file) => file.path.startsWith('scripts/'))
                    .map((file) => file.path),
                })),
              }),
            ]
          : []),
      ],
      skills: entry.caps.skills.length
        ? {
            plugin: forgePlugin('forge-skills', {
              skills: entry.caps.skills.map((skill) => ({
                name: skill.name,
                description: skill.description,
                ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
                content: skill.content,
                dir: skillDirs[skill.name],
              })),
            }),
          }
        : null,
      mcp: { servers: entry.caps.mcp, cwd: mcpCwd },
      web: entry.caps.web,
    };
    const summary = capabilitySummary(entry.caps);
    const systemPrompt = buildSystemPrompt(
      manifest.systemPrompt,
      toolset.allowed,
      entry.code.map((project) => ({ ...project, overview: projectOverview(project) })),
      {
        skills: entry.caps.skills.map((skill) => ({
          name: skill.name,
          title: skill.title,
          hasFiles: skill.files.length > 0,
          hasScripts: skill.files.some((file) => file.path.startsWith('scripts/')),
        })),
        mcp: summary.mcp.map((server) => ({
          serverName: server.serverName,
          title: server.title,
          tools: server.tools.map((tool) => ({
            publicName: tool.publicName,
            approval: tool.permission === 'approval',
          })),
        })),
        webSearch: Boolean(entry.caps.web?.search),
        webFetch: Boolean(entry.caps.web?.fetch),
      },
    );
    plan.runtime.config.systemPrompt = systemPrompt;
    const engine = await DshEngine.start(
      {
        sessionId: entry.id,
        dir,
        cwd: entry.workspace,
        model: entry.model,
        plan,
        groupTools: GROUP_TOOLS,
        resume: entry.hasHistory,
        probeSandbox,
      },
      {
        emit: (kind, payload, source) => this.emit(entry, kind, payload, source),
        fail: (message) => this.fail(entry, message),
        approve: (request) => this.requestApproval(entry, request),
      },
    );
    if (probeSandbox && engine.sandbox) {
      this.sandboxSupport = engine.sandbox;
      if (!engine.sandbox.available) {
        console.warn(
          `[runner] 本机不支持终端沙箱（${engine.sandbox.reason ?? '没有 bwrap，也不支持 Landlock'}）：` +
            '需要终端的会话将拒绝启动。请在服务器上安装 bubblewrap 或启用 Landlock。',
        );
        // 探测发生在首轮执行前；释放本次引擎，再按安全边界决定是否开放会话。
        await engine.dispose();
        return this.boot(entry);
      }
    }
    entry.engine = engine;
  }

  /**
   * 校验一轮的输入并占用会话（同步完成：校验失败直接抛出 4xx，成功后会话即进入回合，重复提交返回 409）。
   * model / codeProjects / capabilities 不传表示沿用会话当前配置；传入即本轮生效的完整集合。
   */
  private prepareTurn(
    id: string,
    message: string,
    model?: RuntimeModel,
    codeProjects?: unknown,
    capabilities?: unknown,
  ): PreparedTurn {
    const entry = this.entry(id);
    entry.lastActive = Date.now();
    if (this.isQueued(id)) throw failure('会话正在排队等待执行，请稍候', 409);
    if (this.isBusy(id)) throw failure('会话正在执行，请等待或中止', 409);
    if (model !== undefined && !validModel(model)) throw failure('本轮模型配置无效', 422);
    const code = codeProjects === undefined ? entry.code : resolveCodeProjects(codeProjects);
    const caps = capabilities === undefined ? entry.caps : this.resolveTurnCapabilities(capabilities, id);
    const turnId = randomUUID();
    entry.turnId = turnId;
    entry.error = null;
    return { turnId, message, model, code, caps };
  }
  /**
   * 提交一轮并立即返回：回合在 Runner 内执行到结束（与调用方连接无关），
   * 事件写入执行日志，调用方从 after 之后订阅（GET /v1/sessions/:id/events?after=）。
   */
  startTurn(
    id: string,
    message: string,
    model?: RuntimeModel,
    codeProjects?: unknown,
    capabilities?: unknown,
  ) {
    const after = this.entry(id).journal.lastSeq;
    const turn = this.prepareTurn(id, message, model, codeProjects, capabilities);
    void this.runTurn(id, turn).catch(() => {
      /* 失败已作为 error + done 事件写入执行日志 */
    });
    return { turnId: turn.turnId, after };
  }
  /** 执行一轮并等待结束（内核集成测试与脚本使用；服务端用 startTurn） */
  async sendTurn(
    id: string,
    message: string,
    model?: RuntimeModel,
    codeProjects?: unknown,
    capabilities?: unknown,
  ) {
    await this.runTurn(id, this.prepareTurn(id, message, model, codeProjects, capabilities));
  }
  /**
   * 执行一轮。与当前进程配置不同（会话内切换模型、关联代码或扩展能力变化）时，
   * 先结束旧进程，再以新配置启动并接续同一份会话日志。
   */
  private async runTurn(id: string, turn: PreparedTurn) {
    const entry = this.entry(id);
    try {
      await this.acquireTurn(id, entry);
    } catch (error) {
      // 排队期间被中止或归档：给出 error + done
      this.fail(entry, error instanceof Error ? error.message : '排队已取消');
      this.finishTurn(entry);
      throw error;
    }
    entry.busy = true;
    try {
      const modelChanged =
        turn.model !== undefined && modelFingerprint(turn.model) !== modelFingerprint(entry.model);
      const codeChanged = !sameProjects(
        turn.code.map((project) => project.name),
        entry.code.map((project) => project.name),
      );
      const capsChanged = capabilityFingerprint(turn.caps) !== capabilityFingerprint(entry.caps);
      if (modelChanged || codeChanged || capsChanged) {
        // 模型密钥、工具白名单与系统提示都只在启动时注入：任一变化都以新配置重启并接续会话
        const previous = entry.engine;
        entry.engine = null;
        await previous?.dispose();
        if (turn.model) entry.model = turn.model;
        entry.code = turn.code;
        entry.caps = turn.caps;
        if (capsChanged) this.emit(entry, 'capabilities', capabilitySummary(turn.caps));
        if (codeChanged)
          this.emit(entry, 'code_projects', {
            projects: turn.code.map(({ name, branch, commit }) => ({ name, branch, commit })),
          });
      }
      if (!entry.engine) await this.boot(entry);
      // 整轮上限：一轮可能包含多次模型请求与工具调用，单步各有超时，这里只兜底防止进程长期占用并发额度
      const seconds = turnTimeoutSeconds();
      await entry
        .engine!.prompt(id, turn.message, seconds * 1000, () => {
          // 消息已进入会话日志：之后重启引擎都要接续这份日志
          entry.hasHistory = true;
        })
        .catch((error) => {
          if (error instanceof EngineTimeout)
            throw new Error(`本轮执行超过 ${formatDuration(seconds)}，已自动停止，可继续对话`);
          throw error;
        });
    } catch (error) {
      this.fail(entry, error instanceof Error ? error.message : '执行失败');
      const engine = entry.engine;
      entry.engine = null;
      await engine?.dispose();
    } finally {
      this.cancelApprovals(entry);
      entry.busy = false;
      this.releaseTurn();
      this.finishTurn(entry);
    }
  }
  /** 结束回合：先释放会话再发 done，订阅者收到 done 时会话已可接受下一轮 */
  private finishTurn(entry: Entry) {
    const turnId = entry.turnId;
    entry.turnId = null;
    this.emit(entry, 'done', { status: entry.error ? 'error' : 'idle', ...(turnId ? { turnId } : {}) });
  }
  /**
   * 抢占一个并发额度；满员时把回合入队等待。队列先进先出，靠 releaseTurn 在上一回合结束后放行。
   * 排队期间若会话被中止或归档，drainQueue / cancelQueuedTurn 会以 409 拒绝该等待。
   */
  private async acquireTurn(id: string, entry: Entry): Promise<void> {
    if (this.activeTurns < this.capacity) {
      this.activeTurns++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.turnQueue.push({ id, resolve, reject });
      this.emit(entry, 'queued', {
        position: this.turnQueue.length,
        capacity: this.capacity,
        active: this.activeTurns,
      });
    });
    // 额度已由 drainQueue 放行时同步占用（activeTurns 自增），此处不再自增。
  }
  /** 回合结束释放一个额度，并依次放行队列中等待的回合。 */
  private releaseTurn(): void {
    this.activeTurns--;
    this.drainQueue();
  }
  private drainQueue(): void {
    while (this.activeTurns < this.capacity && this.turnQueue.length) {
      const next = this.turnQueue.shift()!;
      // 等待期间会话已被归档/移除：拒绝该等待，不再占用额度。
      if (!this.sessions.has(next.id)) {
        next.reject(failure('会话已归档，排队已取消', 409));
        continue;
      }
      this.activeTurns++;
      this.emit(this.entry(next.id), 'dequeued', { capacity: this.capacity, active: this.activeTurns });
      next.resolve();
    }
  }
  /** 取消仍在排队等待执行的回合（中止 / 归档时调用）；返回是否存在并已取消。 */
  private cancelQueuedTurn(id: string): boolean {
    const index = this.turnQueue.findIndex((turn) => turn.id === id);
    if (index === -1) return false;
    const [turn] = this.turnQueue.splice(index, 1);
    turn.reject(failure('任务已由用户中止', 409));
    return true;
  }
  /** 订阅实时事件（含流式增量）；返回取消订阅函数 */
  onEvent(id: string, listener: (event: KernelEvent) => void) {
    const entry = this.entry(id);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }
  /**
   * seq 之后的持久事件。会话不在内存中（Runner 重启后尚未恢复）时直接读磁盘上的执行日志，
   * 控制面据此补齐重启前已产生、但没来得及落库的事件；日志不存在时 404。
   */
  eventsAfter(id: string, after = 0): KernelEvent[] {
    const entry = this.sessions.get(id);
    if (entry) return entry.journal.after(after);
    if (!isSessionId(id) || !EventJournal.exists(join(DATA, id))) throw failure('执行日志不存在', 404);
    return EventJournal.open(join(DATA, id)).after(after);
  }
  /** 控制面已落库到 seq：执行日志移除已确认的事件 */
  ackEvents(id: string, seq: number) {
    if (!Number.isSafeInteger(seq) || seq < 0) throw failure('回执序号无效', 422);
    const entry = this.sessions.get(id);
    if (entry) return entry.journal.ack(seq);
    if (!isSessionId(id) || !EventJournal.exists(join(DATA, id))) throw failure('执行日志不存在', 404);
    EventJournal.open(join(DATA, id)).ack(seq);
  }
  async interrupt(id: string) {
    const entry = this.entry(id);
    // 仍在排队等待执行的回合：直接取消等待，不再进入执行。
    if (this.cancelQueuedTurn(id)) return;
    if (entry.busy) this.fail(entry, '任务已由用户中止');
    this.cancelApprovals(entry);
    const engine = entry.engine;
    entry.engine = null;
    await engine?.dispose();
  }
  async resolveApproval(id: string, ticketId: string, decision: any) {
    const entry = this.entry(id),
      pending = entry.pending.get(ticketId);
    if (!pending) throw failure('审批已过期或已处理', 409);
    if (!['approve', 'deny'].includes(decision?.action)) throw failure('无效审批动作', 422);
    clearTimeout(pending.timer);
    entry.pending.delete(ticketId);
    this.emit(entry, 'approval_resolved', { ticketId, action: decision.action }, 'tools');
    pending.resolve(decision.action);
  }
  async disposeSession(id: string) {
    if (!this.sessions.has(id)) return;
    await this.interrupt(id);
    this.sessions.delete(id);
  }
  /** 闲置回收：关掉空闲超时或热进程超上限的会话进程（只杀进程，磁盘日志保留，下次提问自动接续） */
  private async reap() {
    const now = Date.now();
    const warm: Entry[] = [];
    const idle: Entry[] = [];
    for (const entry of this.sessions.values()) {
      if (this.isBusy(entry.id) || this.isQueued(entry.id) || !entry.engine) continue;
      warm.push(entry);
      if (SESSION_IDLE_TTL_SECONDS > 0 && now - entry.lastActive > SESSION_IDLE_TTL_SECONDS * 1000)
        idle.push(entry);
    }
    const victims = new Set<Entry>(idle);
    if (MAX_WARM_SESSIONS > 0 && warm.length > MAX_WARM_SESSIONS) {
      warm.sort((a, b) => a.lastActive - b.lastActive);
      for (const entry of warm.slice(0, warm.length - MAX_WARM_SESSIONS)) victims.add(entry);
    }
    for (const entry of victims) {
      // Keep the session handle, selections and event listeners. The next turn
      // can boot the engine again without forcing the control plane to restore it.
      const engine = entry.engine;
      entry.engine = null;
      await engine?.dispose();
    }
  }
  async dispose() {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    await Promise.all([...this.sessions.keys()].map((id) => this.disposeSession(id)));
  }
}
/** 整轮执行上限（秒）：环境变量 RUNNER_TURN_TIMEOUT_SECONDS，默认 1800（30 分钟），最少 60 秒 */
export function turnTimeoutSeconds(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.RUNNER_TURN_TIMEOUT_SECONDS);
  return Number.isFinite(value) && value > 0 ? Math.max(60, Math.floor(value)) : 1800;
}
function formatDuration(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}
