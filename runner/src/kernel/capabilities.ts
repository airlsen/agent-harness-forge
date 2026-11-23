/**
 * 会话扩展能力（Skill / MCP / 联网搜索）：控制面每轮下发「本轮生效」的完整集合 = 场景绑定 ∪ 聊天临时选择。
 *
 * - Skill：只是文本。Runner 把正文注册为 DSH 运行时 Skill（dsh-skill 注册表 + dsh-tool-skill 的 skill 工具），
 *   并把完整原文（SKILL.md）与 references/、assets/、scripts/ 写成按「修订号-内容哈希」命名的只读快照目录
 *   （会话工作区之外）；脚本经单独工具运行（与 bash 一样直接执行）；用户可在消息中用 /名称 直接调用。
 * - MCP：每个服务挂一个 dsh-mcp-client；凭据只在本轮配置里出现，不写入 Bundle。
 *   工具按 mcp__<server>__<tool> 命名，只有控制面允许的工具进入白名单，默认直接执行。
 * - 联网：dsh-web + DeepSeek 搜索提供方 + HTTP 抓取，由 dsh-tool-web 提供 web_search / web_fetch。
 *
 * 任一变化（含凭据）都以新配置重启 dsh 并接续会话，和关联代码、模型切换一致：下一轮生效。
 *
 * Skill 内容按快照引用传递：修订不可变、快照名含内容哈希，所以控制面已知 Runner 有这一版时只发
 * {name, revisionId, snapshot, …}，不带原文与附件；Runner 从本会话当前能力或进程内缓存取内容。
 * 缺少的快照以 409 + missingSkills 告知控制面，控制面补发这几个 Skill 的全文后重试一次。
 */
import { createHash } from 'node:crypto';
import { LIMITS } from './platform-contract.js';

/** 与控制面共用的上限来自平台契约（contracts/platform.json），两端不再各写一份 */
export const MAX_SKILLS = LIMITS.sessionSkills;
export const MAX_SKILL_FILES = LIMITS.skillFiles;
export const MAX_SKILL_FILE_BYTES = LIMITS.skillFileBytes;
export const MAX_SKILL_FILES_TOTAL_BYTES = LIMITS.skillFilesTotalBytes;
export const MAX_MCP_SERVERS = LIMITS.sessionMcpServers;
/** 以下只是 Runner 侧的防御性上限（控制面有自己更严格的校验），不进契约 */
export const MAX_SKILL_BYTES = 64_000;
export const MAX_MCP_TOOLS = 200;
/** DSH 技能名语法（dsh-skill isSkillName）：小写 kebab-case */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Skill 快照目录名：<修订号>-<内容哈希前 12 位>（见 skillSnapshotId） */
export const SKILL_SNAPSHOT = /^\d{1,15}-[0-9a-f]{12}$/;
/** dsh-mcp-client 的 serverName 语法 */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
/** 附加文件路径：references/、assets/ 或 scripts/ 下一层、非隐藏、常见安全字符 */
export const SKILL_FILE_PATH =
  /^(references|assets)\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$|^scripts\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:py|js|sh)$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** 联网搜索提供方标识（控制面配置值）；对应哪个 dsh 包由 DSH 适配层决定 */
export const WEB_SEARCH_PROVIDERS = ['deepseek-official', 'deepseek-search-api'] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export interface SkillFile {
  /** Skill 目录内的相对路径，如 references/rules.md */
  path: string;
  content: string;
}
export interface RuntimeSkill {
  name: string;
  description: string;
  whenToUse?: string;
  /** 去掉 front matter 的正文：注册为 DSH 运行时 Skill，由 skill 工具加载 */
  content: string;
  /** 完整原文（含 front matter）：原样写成快照目录里的 SKILL.md；旧控制面不下发时不写 SKILL.md */
  document?: string;
  /** 控制面 Skill 修订号：快照目录名与能力摘要使用 */
  revisionId?: number;
  files: SkillFile[];
  /** 快照标识 <修订号>-<内容哈希>：解析时算一次（或取自缓存），目录名、指纹与摘要都用它 */
  snapshot: string;
  /** 展示用：来源（scenario/chat）与平台 Skill 名称 */
  source: 'scenario' | 'chat';
  title?: string;
}
export type McpPermission = 'read' | 'approval';
export interface RuntimeMcpTool {
  name: string;
  permission: McpPermission;
}
export interface RuntimeMcpServer {
  serverName: string;
  title?: string;
  source: 'scenario' | 'chat';
  transport: 'stdio' | 'streamable-http';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tools: RuntimeMcpTool[];
}
export interface RuntimeWeb {
  search: boolean;
  fetch: boolean;
  provider?: WebSearchProvider;
  apiKey?: string;
  baseUrl?: string;
  source: 'scenario' | 'chat';
}
export interface RuntimeCapabilities {
  skills: RuntimeSkill[];
  mcp: RuntimeMcpServer[];
  web: RuntimeWeb | null;
}
export const EMPTY_CAPABILITIES: RuntimeCapabilities = Object.freeze({ skills: [], mcp: [], web: null });

function failure(message: string, statusCode = 422) {
  return Object.assign(new Error(message), { statusCode });
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number, field: string, required = true) => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.includes('\0') || (required && !value.trim()) || value.length > max)
    throw failure(`${field} 无效`);
  return value;
};
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const source = (value: unknown): 'scenario' | 'chat' => (value === 'chat' ? 'chat' : 'scenario');

function stringMap(value: unknown, field: string, key: RegExp, maxEntries: number) {
  if (value === undefined) return {};
  if (!isObject(value) || Object.keys(value).length > maxEntries) throw failure(`${field} 无效`);
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!key.test(name) || typeof item !== 'string' || item.length > 8192 || item.includes('\0'))
      throw failure(`${field} 无效`);
    out[name] = item;
  }
  return out;
}

/** files:[{path,content}]；兼容旧控制面的 references:[{filename,content}]（视为 references/<filename>） */
function resolveSkillFiles(name: string, raw: Record<string, unknown>): SkillFile[] {
  const legacy = raw.files === undefined && raw.references !== undefined;
  const items = legacy ? raw.references : (raw.files ?? []);
  if (!Array.isArray(items) || items.length > MAX_SKILL_FILES) throw failure(`Skill ${name} 的附加文件无效`);
  const seen = new Set<string>();
  let total = 0;
  return items.map((item) => {
    if (!isObject(item)) throw failure(`Skill ${name} 的附加文件无效`);
    const path = legacy
      ? `references/${text(item.filename, 120, '附加文件名')}`
      : text(item.path, 200, '附加文件路径')!;
    const content = text(item.content, MAX_SKILL_FILE_BYTES, '附加文件内容', false) ?? '';
    total += bytes(content);
    if (!SKILL_FILE_PATH.test(path) || seen.has(path) || bytes(content) > MAX_SKILL_FILE_BYTES)
      throw failure(`Skill ${name} 的附加文件无效：${path}`);
    if (total > MAX_SKILL_FILES_TOTAL_BYTES)
      throw failure(`Skill ${name} 的附加文件合计超过 ${Math.round(MAX_SKILL_FILES_TOTAL_BYTES / 1000)} KB`);
    seen.add(path);
    return { path, content };
  });
}

/** Skill 的内容部分（快照缓存的值）：同一快照标识对应的内容必然相同 */
export type SkillContent = Pick<RuntimeSkill, 'document' | 'content' | 'files'>;
/** 按快照标识查找 Runner 已有的 Skill 内容 */
export type SkillLookup = (snapshot: string) => SkillContent | undefined;
/** 控制面只发了快照引用、而 Runner 没有对应内容：409，控制面补发全文后重试 */
export const SKILL_CONTENT_REQUIRED = 'SKILL_CONTENT_REQUIRED';

/** 解析一个 Skill；引用形式找不到内容时返回 missing，由调用方汇总后一次性告知控制面 */
function resolveSkill(raw: unknown, lookup?: SkillLookup): RuntimeSkill | { missing: string } {
  if (!isObject(raw)) throw failure('Skill 配置无效');
  const name = text(raw.name, 64, 'Skill 名称')!;
  if (!SKILL_NAME.test(name)) throw failure(`Skill 名称无效：${name}`);
  if (
    raw.revisionId !== undefined &&
    (!Number.isSafeInteger(raw.revisionId) ||
      (raw.revisionId as number) < 1 ||
      String(raw.revisionId).length > 15)
  )
    throw failure(`Skill ${name} 修订号无效`);
  const revisionId = raw.revisionId as number | undefined;
  const claimed = raw.snapshot === undefined ? undefined : text(raw.snapshot, 32, `Skill ${name} 快照标识`)!;
  if (claimed !== undefined && (!SKILL_SNAPSHOT.test(claimed) || !claimed.startsWith(`${revisionId ?? 0}-`)))
    throw failure(`Skill ${name} 快照标识无效`);
  const meta = {
    name,
    description: text(raw.description, 1024, `Skill ${name} 描述`)!,
    ...(raw.whenToUse ? { whenToUse: text(raw.whenToUse, 1024, `Skill ${name} 适用场景`)! } : {}),
    ...(revisionId !== undefined ? { revisionId } : {}),
    source: source(raw.source),
    ...(typeof raw.title === 'string' && raw.title ? { title: raw.title.slice(0, 120) } : {}),
  };
  // 引用形式：不带正文与附件，内容取自 Runner 已有的同一快照（快照名含内容哈希，不会取错）
  const isRef = ['content', 'document', 'files', 'references'].every((field) => raw[field] === undefined);
  if (isRef) {
    if (claimed === undefined) throw failure(`Skill ${name} 正文 无效`);
    const cached = lookup?.(claimed);
    if (!cached) return { missing: claimed };
    return { ...meta, ...contentOf(cached), snapshot: claimed };
  }
  const content = text(raw.content, MAX_SKILL_BYTES, `Skill ${name} 正文`)!;
  if (bytes(content) > MAX_SKILL_BYTES) throw failure(`Skill ${name} 正文超过 64 KB`);
  // 新字段可选：旧控制面不下发时照常装配（只是不写 SKILL.md、快照修订号记为 0）
  const document = text(raw.document, MAX_SKILL_BYTES, `Skill ${name} 原文`, false);
  if (document !== undefined && bytes(document) > MAX_SKILL_BYTES)
    throw failure(`Skill ${name} 原文超过 64 KB`);
  const files = resolveSkillFiles(name, raw);
  const snapshot = skillSnapshotId({ revisionId, document, content, files });
  // 全文形式附带的快照标识必须与 Runner 自己算的一致，否则之后的引用永远对不上
  if (claimed !== undefined && claimed !== snapshot) throw failure(`Skill ${name} 快照标识与内容不一致`);
  return { ...meta, ...contentOf({ content, document, files }), snapshot };
}

/** 内容部分：没有原文时不带 document 字段（旧控制面），与缓存中的值同形 */
function contentOf(value: SkillContent): SkillContent {
  return {
    content: value.content,
    ...(value.document !== undefined ? { document: value.document } : {}),
    files: value.files,
  };
}

/**
 * 进程内 Skill 内容缓存：快照标识 → 内容，按最近使用淘汰，总量上限 64 MB。
 * 正在使用的会话自己持有内容（entry.caps），淘汰只会让控制面多补发一次全文，不影响正确性。
 */
export class SkillContentCache {
  private items = new Map<string, { value: SkillContent; bytes: number }>();
  private total = 0;
  constructor(private readonly limit = 64 * 1024 * 1024) {}
  get size() {
    return this.items.size;
  }
  get(snapshot: string): SkillContent | undefined {
    const item = this.items.get(snapshot);
    if (!item) return undefined;
    this.items.delete(snapshot);
    this.items.set(snapshot, item);
    return item.value;
  }
  /** 记住本轮装配的 Skill；已有的只刷新使用顺序，不重新计算大小 */
  remember(skills: readonly RuntimeSkill[]) {
    for (const skill of skills) {
      if (this.get(skill.snapshot)) continue;
      const size =
        bytes(skill.content) +
        (skill.document ? bytes(skill.document) : 0) +
        skill.files.reduce((sum, file) => sum + bytes(file.path) + bytes(file.content), 0);
      this.items.set(skill.snapshot, { value: contentOf(skill), bytes: size });
      this.total += size;
    }
    for (const [key, item] of this.items) {
      if (this.total <= this.limit || this.items.size <= 1) break;
      this.items.delete(key);
      this.total -= item.bytes;
    }
  }
}

function resolveMcp(raw: unknown): RuntimeMcpServer {
  if (!isObject(raw)) throw failure('MCP 配置无效');
  const serverName = text(raw.serverName, 32, 'MCP 服务标识')!;
  if (!MCP_SERVER_NAME.test(serverName)) throw failure(`MCP 服务标识无效：${serverName}`);
  if (!Array.isArray(raw.tools) || !raw.tools.length || raw.tools.length > MAX_MCP_TOOLS)
    throw failure(`MCP 服务 ${serverName} 没有可用工具`);
  const seen = new Set<string>();
  const tools = raw.tools.map((tool) => {
    if (!isObject(tool)) throw failure(`MCP 服务 ${serverName} 的工具配置无效`);
    const name = text(tool.name, 128, 'MCP 工具名')!;
    if (seen.has(name) || !['read', 'approval'].includes(tool.permission as string))
      throw failure(`MCP 服务 ${serverName} 的工具配置无效：${name}`);
    seen.add(name);
    return { name, permission: tool.permission as McpPermission };
  });
  const common = {
    serverName,
    source: source(raw.source),
    tools,
    ...(typeof raw.title === 'string' && raw.title ? { title: raw.title.slice(0, 96) } : {}),
  };
  if (raw.transport === 'stdio') {
    const args = raw.args === undefined ? [] : raw.args;
    if (
      !Array.isArray(args) ||
      args.length > 64 ||
      args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
    )
      throw failure(`MCP 服务 ${serverName} 的启动参数无效`);
    return {
      ...common,
      transport: 'stdio',
      command: text(raw.command, 256, `MCP 服务 ${serverName} 的启动命令`)!.trim(),
      args: args as string[],
      env: stringMap(raw.env, `MCP 服务 ${serverName} 的环境变量`, ENV_NAME, 50),
    };
  }
  if (raw.transport !== 'streamable-http') throw failure(`MCP 服务 ${serverName} 的传输方式不受支持`);
  const url = text(raw.url, 2048, `MCP 服务 ${serverName} 的地址`)!;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw failure(`MCP 服务 ${serverName} 的地址无效`);
  }
  // 地址的公网校验在控制面导入时完成；这里只拒绝明显不安全的形态（明文、内嵌凭据）
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw failure(`MCP 服务 ${serverName} 只允许 HTTPS 地址`);
  return {
    ...common,
    transport: 'streamable-http',
    url,
    headers: stringMap(raw.headers, `MCP 服务 ${serverName} 的请求头`, HEADER_NAME, 30),
  };
}

function resolveWeb(raw: unknown): RuntimeWeb | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw failure('联网配置无效');
  const search = raw.search === true;
  const fetch = raw.fetch === true;
  if (!search && !fetch) return null;
  const web: RuntimeWeb = { search, fetch, source: source(raw.source) };
  if (search) {
    if (
      typeof raw.provider !== 'string' ||
      !(WEB_SEARCH_PROVIDERS as readonly string[]).includes(raw.provider)
    )
      throw failure('联网搜索提供方无效');
    web.provider = raw.provider as WebSearchProvider;
    web.apiKey = text(raw.apiKey, 2048, '联网搜索密钥')!;
    if (raw.baseUrl !== undefined && raw.baseUrl !== '') {
      const baseUrl = text(raw.baseUrl, 512, '联网搜索地址')!;
      try {
        if (!['http:', 'https:'].includes(new URL(baseUrl).protocol)) throw new Error();
      } catch {
        throw failure('联网搜索地址无效');
      }
      web.baseUrl = baseUrl;
    }
  }
  return web;
}

/** 已解析的能力集合：再次传入 resolveCapabilities 时原样返回（Runner 入口先校验、执行时不再重复解析） */
const resolvedSets = new WeakSet<object>();

/**
 * 校验控制面下发的扩展能力；不传视为没有扩展能力。名称冲突直接拒绝（控制面负责去重）。
 * lookup 用于解析只带快照引用的 Skill；找不到的快照汇总后以 409 + missingSkills 抛出。
 */
export function resolveCapabilities(raw: unknown, lookup?: SkillLookup): RuntimeCapabilities {
  if (raw === undefined || raw === null) return { skills: [], mcp: [], web: null };
  if (isObject(raw) && resolvedSets.has(raw)) return raw as unknown as RuntimeCapabilities;
  if (!isObject(raw)) throw failure('扩展能力配置无效');
  const skills = raw.skills === undefined ? [] : raw.skills;
  const mcp = raw.mcp === undefined ? [] : raw.mcp;
  if (!Array.isArray(skills) || skills.length > MAX_SKILLS)
    throw failure(`一个会话最多使用 ${MAX_SKILLS} 个 Skill`);
  if (!Array.isArray(mcp) || mcp.length > MAX_MCP_SERVERS)
    throw failure(`一个会话最多连接 ${MAX_MCP_SERVERS} 个 MCP 服务`);
  const parsed = skills.map((item) => resolveSkill(item, lookup));
  const missing = parsed.flatMap((item) => ('missing' in item ? [item.missing] : []));
  if (missing.length)
    throw Object.assign(failure('Runner 缺少部分 Skill 内容，请补发全文', 409), {
      code: SKILL_CONTENT_REQUIRED,
      missingSkills: [...new Set(missing)],
    });
  const resolved = {
    skills: parsed as RuntimeSkill[],
    mcp: mcp.map(resolveMcp),
    web: resolveWeb(raw.web),
  };
  const skillNames = resolved.skills.map((skill) => skill.name);
  if (new Set(skillNames).size !== skillNames.length) throw failure('Skill 名称重复');
  const servers = resolved.mcp.map((server) => server.serverName);
  if (new Set(servers).size !== servers.length) throw failure('MCP 服务标识重复');
  resolvedSets.add(resolved);
  return resolved;
}

/**
 * 与 dsh-mcp-client@0.2.2-rc.5 的 publicToolName 保持一致：模型看到的工具名。
 * 纯函数：mcp__<server>__<tool>，字符替换或截断到 64 字符时附加 12 位身份哈希。
 */
export function mcpPublicToolName(serverName: string, rawName: string) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized === joined && normalized.length <= 64) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12);
  return `${normalized.slice(0, 64 - 12 - 1)}_${hash}`;
}

/** 允许执行的 MCP 工具（模型可见名）与其中需要逐次确认的部分 */
export function mcpToolNames(caps: RuntimeCapabilities) {
  const allowed: string[] = [];
  const approval: string[] = [];
  for (const server of caps.mcp)
    for (const tool of server.tools) {
      const name = mcpPublicToolName(server.serverName, tool.name);
      allowed.push(name);
      if (tool.permission === 'approval') approval.push(name);
    }
  return { allowed, approval };
}

/**
 * 指纹覆盖全部字段（含凭据）：任一变化都需以新配置重启 dsh。
 * Skill 的原文、正文与附件由快照标识（含内容哈希）代表，不再每轮对全文做哈希。
 */
export function capabilityFingerprint(caps: RuntimeCapabilities) {
  const skills = caps.skills.map(
    ({ document: _document, content: _content, files: _files, ...rest }) => rest,
  );
  return createHash('sha256')
    .update(JSON.stringify({ ...caps, skills }))
    .digest('hex');
}

/**
 * Skill 快照标识「<修订号>-<内容哈希前 12 位>」，与控制面 capability_service.skill_snapshot_id 算法一致。
 * 哈希覆盖 SKILL.md 原文与全部附加文件（按路径排序，路径与内容以 NUL 分隔；校验已保证两者都不含 NUL）。
 * 旧控制面没有原文时以正文代替（此时目录里不写 SKILL.md）。
 */
export function skillSnapshotId(skill: Pick<RuntimeSkill, 'revisionId' | 'document' | 'content' | 'files'>) {
  const hash = createHash('sha256');
  const parts = skill.document !== undefined ? ['SKILL.md', skill.document] : ['content', skill.content];
  const files = [...skill.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of files) parts.push(file.path, file.content);
  for (const value of parts) hash.update(value, 'utf8').update('\0');
  return `${skill.revisionId ?? 0}-${hash.digest('hex').slice(0, 12)}`;
}

/** 对外（事件、日志）展示的摘要：不含正文、凭据、命令与环境变量 */
export function capabilitySummary(caps: RuntimeCapabilities) {
  return {
    skills: caps.skills.map((skill) => ({
      name: skill.name,
      title: skill.title ?? skill.name,
      source: skill.source,
      ...(skill.revisionId !== undefined ? { revisionId: skill.revisionId } : {}),
      snapshot: skill.snapshot,
    })),
    mcp: caps.mcp.map((server) => ({
      serverName: server.serverName,
      title: server.title ?? server.serverName,
      source: server.source,
      transport: server.transport,
      tools: server.tools.map((tool) => ({
        name: tool.name,
        publicName: mcpPublicToolName(server.serverName, tool.name),
        permission: tool.permission,
      })),
    })),
    web: caps.web ? { search: caps.web.search, fetch: caps.web.fetch, source: caps.web.source } : null,
  };
}
