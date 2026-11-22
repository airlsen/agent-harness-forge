/** 业务内核：独立 dsh 进程、真实模型出口、受限文件工具、逐次审批。 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, lstat, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DshProcess } from './dsh-process.js';
import { mimeType } from './mime.js';
import { buildSystemPrompt } from './system-prompt.js';
import { projectOverview, resolveCodeProjects, sameProjects, type CodeProject } from './code-projects.js';
import {
  EMPTY_CAPABILITIES,
  SKILL_SNAPSHOT,
  SkillContentCache,
  WEB_SEARCH_PROVIDERS,
  capabilityFingerprint,
  capabilitySummary,
  mcpToolNames,
  resolveCapabilities,
  type RuntimeCapabilities,
} from './capabilities.js';
import type { PluginWorkerClient } from '../plugin-worker-client.js';
import type { AgentKernel, Bundle, KernelEvent, SessionHandle, TurnOpts, UserCtx } from './types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRESENT_TOOL = 'workspace_present';
/**
 * 基础能力：每个会话默认加载，不需要场景逐个授权。仍以平台策略（allowedTools）为上限，
 * workspace_write 仅写入受限会话目录并直接执行；终端命令按风险逐次审批。场景 Bundle 是发布时的快照，由 Runner 统一补齐，已发布场景与存量会话同样生效。
 */
export const BASE_TOOLS = [
  'current_time',
  'workspace_list',
  'workspace_read',
  'workspace_write',
  'bash',
] as const;
/** 版本固定的 DSH 搜索插件（随 dsh 版本锁定）提供的工具；随读取权限开放，路径由 forge-runtime 限制在工作区内。 */
export const SEARCH_TOOLS = ['glob', 'grep'] as const;
export const SEARCH_PLUGIN = '@deepseek-ai/dsh-tool-fs-search';
/** DSH 原生只读 read（带行号、分页、字节上限），关联代码时开放，路径同样由 forge-runtime 收窄 */
export const CODE_READ_TOOL = 'read';
/** dsh-tool-skill 提供的 Skill 加载工具 */
export const SKILL_TOOL = 'skill';
export const SKILL_SCRIPT_TOOL = 'skill_run_script';
/** dsh-tool-web 提供的联网工具 */
export const WEB_SEARCH_TOOL = 'web_search';
export const WEB_FETCH_TOOL = 'web_fetch';
export interface SessionToolset {
  /** forge-runtime 白名单：模型可见、允许执行的全部工具 */
  allowed: string[];
  /** 是否加载 DSH 搜索插件 */
  search: boolean;
  /** 是否关联了代码项目 */
  code: boolean;
  /** 是否开放 DSH 只读 read（关联代码或 Skill 带附加文件） */
  read: boolean;
  /** 是否装配 Skill（dsh-skill + dsh-tool-skill） */
  skills: boolean;
  /** 需要逐次确认的工具（管理员标记为需确认的 MCP 工具） */
  approval: string[];
}
/**
 * 计算会话工具集：基础能力 ∪ 场景声明，Forge 内置工具以平台策略为上限；
 * 写入开放时附带交付声明，读取开放时附带 glob/grep 搜索；插件工具原样保留。
 * 关联代码是会话级能力、与场景无关：关联了项目就开放只读的 glob/grep/read；
 * 受控终端命令（bash）可执行编译、修改等操作，始终以平台策略为上限，关联代码不会绕过策略开放它。
 * 扩展能力（Skill / MCP / 联网）由控制面按场景绑定 ∪ 聊天临时选择、并经企业策略筛选后下发，原样加入白名单。
 */
export function sessionToolset(
  meta: Record<string, any> | undefined,
  hasCode = false,
  caps: RuntimeCapabilities = EMPTY_CAPABILITIES,
): SessionToolset {
  const policy = meta?.policy ?? {};
  const ceiling: string[] | undefined = Array.isArray(policy.allowedTools) ? policy.allowedTools : undefined;
  const declared = Array.isArray(meta?.builtin_tools) ? (meta.builtin_tools as string[]) : [];
  const pluginTools = Array.isArray(meta?.plugin_tools) ? (meta.plugin_tools as string[]) : [];
  const withinCeiling = (name: string) => !ceiling || ceiling.includes(name);
  // 场景声明的其他内置插件工具（如 Skill 编辑的 skill_*）沿用原有规则：以策略为上限。
  // Skill 编辑会话的策略上限只含 skill_*，因此不会被附加基础能力。
  const builtin = [...new Set([...BASE_TOOLS, ...declared])].filter(withinCeiling);
  const search = builtin.includes('workspace_read') || hasCode;
  const skills = caps.skills.length > 0;
  const read = hasCode || caps.skills.some((skill) => skill.files.length > 0);
  // bash 已在 BASE_TOOLS 中并经过平台策略筛选：策略未勾选时，即使关联了代码也不开放。
  const bash = builtin.includes('bash');
  const scripts = withinCeiling(SKILL_SCRIPT_TOOL) && caps.skills.some((skill) => skill.files.some((file) => file.path.startsWith('scripts/')));
  const mcp = mcpToolNames(caps);
  const allowed = [
    ...builtin,
    ...(builtin.includes('workspace_write') ? [PRESENT_TOOL] : []),
    ...(search ? SEARCH_TOOLS : []),
    ...(read ? [CODE_READ_TOOL] : []),
    ...(bash ? ['bash'] : []),
    // 受管插件工具已由控制面按企业插件策略与场景授权筛选，不再按内置工具策略过滤。
    ...pluginTools,
    ...(skills ? [SKILL_TOOL] : []),
    ...(scripts ? [SKILL_SCRIPT_TOOL] : []),
    ...(caps.web?.search ? [WEB_SEARCH_TOOL] : []),
    ...(caps.web?.fetch ? [WEB_FETCH_TOOL] : []),
    ...mcp.allowed,
  ];
  return { allowed: [...new Set(allowed)], search, code: hasCode, read, skills, approval: [...mcp.approval, ...(scripts ? [SKILL_SCRIPT_TOOL] : [])] };
}
const MAX_RAW_BYTES = 20 * 1024 * 1024;
/** 联网搜索密钥的环境变量名（含 KEY，不会被传给 stdio MCP 子进程） */
const WEB_SEARCH_KEY_ENV = 'FORGE_WEB_SEARCH_API_KEY';
const MCP_TOOL_TIMEOUT_MS = 60000;
/** 清单上限：远高于插件的 100 个文件配额；达到上限时标记 truncated，控制面不会据此删除记录 */
export const MAX_LISTED_FILES = 1000;
/** Runner 会话 id（randomUUID），同时决定磁盘目录名，必须严格校验 */
const SESSION_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
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
  /** 当前关联的代码项目（只读挂载）；变化时下一轮以新配置重启 dsh 并接续会话 */
  code: CodeProject[];
  /** 本轮生效的扩展能力（场景绑定 ∪ 聊天临时选择）；变化时同样重启接续 */
  caps: RuntimeCapabilities;
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

/**
 * 助手修改草稿后同步 Bundle 中的草稿快照：dsh 进程之后因出错、中止、切换模型等原因重启时，
 * 编写插件从 Bundle 重新加载草稿，必须拿到最新内容，而不是会话创建时的旧草稿。
 */
export function syncSkillDraft(bundle: Bundle, change: any) {
  type Draft = { content?: string; files?: Array<{ path: string; content: string }> };
  const draft = bundle.meta?.skillAuthoring as Draft | undefined;
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

export class DshKernel implements AgentKernel {
  private sessions = new Map<string, Entry>();
  /** 正在从磁盘日志恢复的会话：并发恢复同一 id 时复用同一任务，避免启动两个 dsh 进程争用日志。 */
  private restoring = new Map<string, Promise<SessionHandle>>();
  /** 正在执行（busy）的会话数：容量按它计，而不是按存活会话总数。 */
  private activeTurns = 0;
  /** 排队等待并发额度的回合；先进先出，容量释放后依次放行。 */
  private turnQueue: Array<{ id: string; resolve: () => void; reject: (error: Error) => void }> = [];
  /** Skill 内容缓存（快照标识 → 内容）：控制面已知 Runner 有这一版时只发快照引用 */
  private skillCache = new SkillContentCache();
  constructor(private readonly pluginWorker?: PluginWorkerClient) {}
  get size() {
    return this.sessions.size;
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
  policyRef(id: string) {
    return this.entry(id).bundle.policy_ref;
  }
  isBusy(id: string) {
    return this.entry(id).busy;
  }
  isQueued(id: string) {
    return this.turnQueue.some((turn) => turn.id === id);
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
  async createSession(
    bundle: Bundle,
    _user: UserCtx,
    model?: RuntimeModel,
    codeProjects?: unknown,
    capabilities?: unknown,
  ): Promise<SessionHandle> {
    const { code, caps } = this.validateSession(bundle, model, codeProjects, capabilities);
    const id = randomUUID();
    const entry = this.newEntry(id, bundle, model!, code, caps, false);
    this.sessions.set(id, entry);
    try {
      await this.boot(entry);
    } catch (error) {
      await entry.proc?.dispose();
      this.sessions.delete(id);
      throw error;
    }
    return this.handle(entry);
  }
  /**
   * 以原会话 id 重新装配执行会话（控制面调用，配置由控制面按数据库快照重新下发）：
   * - 内存中不存在（Runner 重启过）：确认磁盘上的 dsh 会话日志存在，启动 dsh 并 session/resume 接续，
   *   之后的对话与重启前完全连续；日志缺失 404，日志无法恢复 410，均不会创建替代会话。
   * - 内存中已存在：替换为新配置（例如 Skill 草稿被手动修改），下一轮以新配置重启并接续同一份日志。
   */
  async restoreSession(
    id: string,
    bundle: Bundle,
    _user: UserCtx,
    model?: RuntimeModel,
    codeProjects?: unknown,
    capabilities?: unknown,
  ): Promise<SessionHandle> {
    if (!SESSION_ID.test(id)) throw failure('会话标识无效', 422);
    const { code, caps } = this.validateSession(bundle, model, codeProjects, capabilities);
    const pending = this.restoring.get(id);
    if (pending) return pending;
    const current = this.sessions.get(id);
    if (current) {
      if (current.busy || this.isQueued(id)) throw failure('会话正在执行，请等待本轮结束', 409);
      const previous = current.proc;
      current.proc = null;
      await previous?.dispose();
      Object.assign(current, { bundle, model: model!, code, caps });
      return this.handle(current);
    }
    const task = this.hydrate(id, bundle, model!, code, caps);
    this.restoring.set(id, task);
    try {
      return await task;
    } finally {
      this.restoring.delete(id);
    }
  }
  private async hydrate(
    id: string,
    bundle: Bundle,
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
    const entry = this.newEntry(id, bundle, model, code, caps, true);
    this.sessions.set(id, entry);
    try {
      await this.boot(entry);
    } catch (error) {
      await entry.proc?.dispose();
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
    bundle: Bundle,
    model: RuntimeModel | undefined,
    codeProjects: unknown,
    capabilities: unknown,
  ) {
    if (!validModel(model)) throw failure('请先在模型中心配置真实模型网关', 422);
    const code = resolveCodeProjects(codeProjects);
    const caps = this.resolveTurnCapabilities(capabilities);
    const approvedPlugins = new Set(['forge-runtime', 'skill-authoring', 'forge-plugin-bridge']);
    if (!Array.isArray(bundle?.plugin_mounts) || bundle.plugin_mounts.some((p) => !approvedPlugins.has(p)))
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
    return { code, caps };
  }
  private newEntry(
    id: string,
    bundle: Bundle,
    model: RuntimeModel,
    code: CodeProject[],
    caps: RuntimeCapabilities,
    hasHistory: boolean,
  ): Entry {
    return {
      id,
      bundle,
      model,
      proc: null,
      events: [],
      listeners: new Set(),
      seq: 0,
      busy: false,
      hasHistory,
      error: null,
      workspace: join(DATA, id, 'workspace'),
      pending: new Map(),
      calls: new Map(),
      code,
      caps,
    };
  }
  private handle(entry: Entry): SessionHandle {
    return {
      sessionId: entry.id,
      forgeSessionId: 0,
      bundleHash: createHash('sha256').update(JSON.stringify(entry.bundle)).digest('hex'),
    };
  }
  private async boot(entry: Entry) {
    const dir = join(DATA, entry.id);
    await mkdir(entry.workspace, { recursive: true, mode: 0o700 });
    const policy = (entry.bundle.meta?.policy as any) ?? {};
    const pluginTools = (entry.bundle.meta?.plugin_tools as string[]) ?? [];
    const toolset = sessionToolset(entry.bundle.meta, entry.code.length > 0, entry.caps);
    const skillDirs = await this.materializeSkills(entry);
    // stdio MCP 进程的工作目录：独立空目录，不指向会话工作区或代码项目
    if (entry.caps.mcp.length) await mkdir(join(dir, 'mcp'), { recursive: true, mode: 0o700 });
    const pluginBindings = Array.isArray(entry.bundle.meta?.pluginBindings)
      ? entry.bundle.meta.pluginBindings
      : [];
    const plugin = {
      id: 'forge-runtime',
      name: pathToFileURL(join(ROOT, 'forge-runtime-plugin', 'index.js')).href,
      config: {
        workspace: entry.workspace,
        allowedTools: toolset.allowed,
        approvalTools: toolset.approval,
        codeProjects: entry.code.map(({ name, path }) => ({ name, path })),
        readRoots: Object.entries(skillDirs).map(([name, path]) => ({ name: `skill:${name}`, path })),
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
            // 会话工作区：草稿镜像写到其中的 .skill/（供 bash 运行），脚本产出写到 outputs/
            workspace: entry.workspace,
          },
        }
      : null;
    const skillScriptsPlugin = toolset.allowed.includes(SKILL_SCRIPT_TOOL)
      ? {
          id: 'skill-scripts',
          name: pathToFileURL(join(ROOT, 'skill-scripts-plugin', 'index.js')).href,
          config: {
            // 脚本在会话工作区的 outputs/<脚本名>-<时间>/ 下运行，产出随会话文件同步
            workspace: entry.workspace,
            skills: entry.caps.skills.filter((skill) => skill.files.some((file) => file.path.startsWith('scripts/')))
              .map((skill) => ({
                name: skill.name,
                dir: skillDirs[skill.name],
                scripts: skill.files.filter((file) => file.path.startsWith('scripts/')).map((file) => file.path),
              })),
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
        'persistent-pwsh',
        'terminal-pwsh',
        'tool-working-directory',
        ...(toolset.read ? [] : ['tool-fs']),
      ].map((id) => ({ id, disabled: true })),
      // 关联代码或 Skill 附加文件时只开放 DSH 原生 read：写入、编辑、补丁全部关闭，只读
      ...(toolset.read
        ? [
            {
              id: 'tool-fs',
              config: {
                read: true,
                readImage: false,
                write: false,
                edit: false,
                applyPatch: false,
                readLimit: 2000,
                readMaxBytes: 51200,
              },
            },
          ]
        : []),
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
          ...(skillScriptsPlugin ? [skillScriptsPlugin] : []),
          ...this.capabilityRows(entry, skillDirs),
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
    const summary = capabilitySummary(entry.caps);
    const system = buildSystemPrompt(
      entry.bundle.profile_patch.systemPrompt,
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
    await proc.start({
      binPath: join(ROOT, 'scripts', 'dsh-launch.mjs'),
      profile: 'sdk-minimal',
      patchPaths: [patchPath],
      // 密钥类变量名都含 SECRET/KEY：DSH 为 stdio MCP 子进程清洗环境变量时会剔除，外部程序拿不到
      env: {
        FORGE_MODEL_SECRET_CONFIG: JSON.stringify(entry.model),
        DSH_SYSTEM_PROMPT: system,
        ...(entry.caps.web?.apiKey ? { [WEB_SEARCH_KEY_ENV]: entry.caps.web.apiKey } : {}),
      },
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
  /**
   * 物化 Skill 快照目录：DATA/<id>/skills/<name>/<修订号>-<内容哈希>/，内容与控制面修订逐字节一致：
   * SKILL.md（完整原文，旧控制面未下发原文时不写）+ references/、assets/、scripts/ 附加文件，文件只读（0400）。
   *
   * - 每个 Skill 都有目录（即使只有 SKILL.md），skill 工具的 resourceBase 始终是这个目录；
   * - 先写临时目录再原子改名，已存在的同名快照直接复用（名字由内容哈希决定，内容必然相同）；
   * - 不再每次启动整体删除：旧修订的快照留在磁盘上，接续会话时历史里的旧路径仍可追溯，
   *   但只读根只包含本次装配的快照目录，模型无法再读取旧快照。快照与会话日志一样留在会话数据目录
   *   DATA/<id>/ 中（不属于工作区，不受产物保留期清理影响；单个 Skill 最大约 576 KB）。
   * 返回 Skill 名 → 快照目录；正文中的相对路径（如 references/rules.md）按这个目录解析。
   */
  private async materializeSkills(entry: Entry) {
    const root = join(DATA, entry.id, 'skills');
    const dirs: Record<string, string> = {};
    for (const skill of entry.caps.skills) {
      const snapshot = skill.snapshot;
      const parent = join(root, skill.name);
      const dir = join(parent, snapshot);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await this.pruneSkillParent(parent);
      if (!(await isDirectory(dir))) {
        const staging = join(parent, `.staging-${randomUUID()}`);
        try {
          await mkdir(staging, { mode: 0o700 });
          const files = [
            ...(skill.document !== undefined ? [{ path: 'SKILL.md', content: skill.document }] : []),
            ...skill.files,
          ];
          for (const file of files) {
            // 路径已由 SKILL_FILE_PATH 校验为允许的单层目录，这里再确认不越出 Skill 目录
            const target = join(staging, file.path);
            if (!target.startsWith(staging + sep)) throw new Error(`Skill 文件路径无效：${file.path}`);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await writeFile(target, file.content, { mode: 0o400, flag: 'wx' });
          }
          await rename(staging, dir);
        } catch (error: any) {
          await rm(staging, { recursive: true, force: true });
          // 目标快照已由此前的启动写好（同名即同内容）：直接复用
          if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code) || !(await isDirectory(dir))) throw error;
        }
      }
      dirs[skill.name] = dir;
    }
    return dirs;
  }
  /** 清理中断留下的临时目录与旧版本 Runner 的平铺目录（references/ 等直接放在 Skill 名下）；快照目录保留 */
  private async pruneSkillParent(parent: string) {
    for (const name of await readdir(parent)) {
      if (SKILL_SNAPSHOT.test(name)) continue;
      await rm(join(parent, name), { recursive: true, force: true });
    }
  }
  /** 扩展能力对应的 DSH 插件行：Skill 注册表与加载工具、每个 MCP 服务一个客户端、联网服务与工具 */
  private capabilityRows(entry: Entry, skillDirs: Record<string, string>) {
    const caps = entry.caps;
    const rows: Record<string, unknown>[] = [];
    if (caps.skills.length)
      rows.push(
        { id: 'forge-skill-registry', name: '@deepseek-ai/dsh-skill' },
        {
          id: 'forge-skills',
          name: pathToFileURL(join(ROOT, 'forge-skills-plugin', 'index.js')).href,
          config: {
            skills: caps.skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
              content: skill.content,
              dir: skillDirs[skill.name],
            })),
          },
        },
        { id: 'forge-tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
      );
    if (caps.mcp.length) {
      const cwd = join(DATA, entry.id, 'mcp');
      for (const server of caps.mcp)
        rows.push({
          id: `forge-mcp-${server.serverName}`,
          name: '@deepseek-ai/dsh-mcp-client',
          config:
            server.transport === 'stdio'
              ? {
                  transport: 'stdio',
                  serverName: server.serverName,
                  command: server.command,
                  args: server.args ?? [],
                  env: server.env ?? {},
                  cwd,
                  toolCallTimeoutMs: MCP_TOOL_TIMEOUT_MS,
                }
              : {
                  transport: 'streamable-http',
                  serverName: server.serverName,
                  url: server.url,
                  headers: server.headers ?? {},
                  toolCallTimeoutMs: MCP_TOOL_TIMEOUT_MS,
                },
        });
    }
    const web = caps.web;
    if (web) {
      rows.push({
        id: 'forge-web',
        name: '@deepseek-ai/dsh-web',
        config: { ...(web.search ? { searchProvider: web.provider } : {}), fetchProvider: 'http' },
      });
      if (web.search)
        rows.push({
          id: 'forge-web-search',
          name: WEB_SEARCH_PROVIDERS[web.provider!],
          // 密钥只经环境变量传入，不写入落盘的 patch 文件
          config: { apiKeyEnv: WEB_SEARCH_KEY_ENV, ...(web.baseUrl ? { baseURL: web.baseUrl } : {}) },
        });
      rows.push(
        { id: 'forge-web-fetch', name: '@deepseek-ai/dsh-web-fetch-http' },
        {
          id: 'forge-tool-web',
          name: '@deepseek-ai/dsh-tool-web',
          config: {
            search: web.search,
            fetch: web.fetch,
            searchMaxResults: 8,
            searchTimeoutMs: 60000,
            fetchTimeoutMs: 30000,
            fetchMaxOutputChars: 60000,
          },
        },
      );
    }
    return rows;
  }
  private notification(entry: Entry, method: string, params: any) {
    if (method === 'forge.delta') this.emit(entry, 'message_delta', params, 'llm');
    else if (method === 'forge.reasoning_delta') this.emit(entry, 'reasoning_delta', params, 'llm');
    else if (method === 'forge.error') {
      entry.error = params.message;
      this.emit(entry, 'error', params);
    } else if (method === 'forge.policy') this.emit(entry, 'policy_decision', params, 'tools');
    else if (method === 'forge.skill_revision') {
      syncSkillDraft(entry.bundle, params);
      this.emit(entry, 'skill_revision', params, 'tools');
    } else if (method === 'forge.plugin_loaded') this.emit(entry, 'plugin_loaded', params, 'tools');
    else if (method === 'forge.skills_loaded') this.emit(entry, 'skills_loaded', params, 'tools');
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
  async sendTurn(
    id: string,
    message: string,
    _opts?: TurnOpts,
    model?: RuntimeModel,
    codeProjects?: unknown,
    capabilities?: unknown,
  ) {
    const entry = this.entry(id);
    if (entry.busy) throw failure('会话正在执行，请等待或中止', 409);
    if (this.isQueued(id)) throw failure('会话正在排队等待执行，请稍候', 409);
    if (model !== undefined && !validModel(model)) throw failure('本轮模型配置无效', 422);
    // 不传表示沿用当前关联；传入则必须全部存在（与模型配置一样在执行前校验）
    const code = codeProjects === undefined ? entry.code : resolveCodeProjects(codeProjects);
    // 扩展能力同理：不传沿用，传入即本轮生效的完整集合
    const caps = capabilities === undefined ? entry.caps : this.resolveTurnCapabilities(capabilities, id);
    // 并发额度：超出容量时排队等待，而不是直接拒绝；等待期间被中止会抛出并给出 error + done。
    try {
      await this.acquireTurn(id, entry);
    } catch (error) {
      if (!entry.error) {
        entry.error = error instanceof Error ? error.message : '排队已取消';
        this.emit(entry, 'error', { message: entry.error });
      }
      this.emit(entry, 'done', { status: 'error' });
      throw error;
    }
    entry.busy = true;
    entry.error = null;
    try {
      const modelChanged = model !== undefined && modelFingerprint(model) !== modelFingerprint(entry.model);
      const codeChanged = !sameProjects(
        code.map((project) => project.name),
        entry.code.map((project) => project.name),
      );
      const capsChanged = capabilityFingerprint(caps) !== capabilityFingerprint(entry.caps);
      if (modelChanged || codeChanged || capsChanged) {
        // 模型密钥、工具白名单与系统提示都只在启动时注入：任一变化都以新配置重启并接续会话
        const previous = entry.proc;
        entry.proc = null;
        await previous?.dispose();
        if (model) entry.model = model;
        entry.code = code;
        entry.caps = caps;
        if (capsChanged) this.emit(entry, 'capabilities', capabilitySummary(caps));
        if (codeChanged)
          this.emit(entry, 'code_projects', {
            projects: code.map(({ name, branch, commit }) => ({ name, branch, commit })),
          });
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
      this.releaseTurn();
      this.emit(entry, 'done', { status: entry.error ? 'error' : 'idle' });
    }
  }
  /**
   * 抢占一个并发额度；满员时把回合入队等待。队列先进先出，靠 releaseTurn 在上一回合结束后放行。
   * 排队期间若会话被中止或归档，drainQueue 会以 409 拒绝该等待。
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
  onEvent(id: string, listener: (event: KernelEvent) => void) {
    const entry = this.entry(id);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }
  async interrupt(id: string) {
    const entry = this.entry(id);
    // 仍在排队等待执行的回合：直接取消等待，不再进入执行。
    if (this.cancelQueuedTurn(id)) return;
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
    if (!SESSION_ID.test(id)) throw failure('会话标识无效', 422);
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
async function isDirectory(path: string) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
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
