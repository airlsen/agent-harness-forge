/**
 * 会话扩展能力（Skill / MCP / 联网搜索）：控制面每轮下发「本轮生效」的完整集合 = 场景绑定 ∪ 聊天临时选择。
 *
 * - Skill：只是文本。Runner 把正文注册为 DSH 运行时 Skill（dsh-skill 注册表 + dsh-tool-skill 的 skill 工具），
 *   references/、assets/ 中的文件写到会话目录外的只读目录（完整 Skill 目录），模型用 read 按需读取；
 *   用户可在消息中用 /名称 直接调用。
 * - MCP：每个服务挂一个 dsh-mcp-client；凭据只在本轮配置里出现，不写入 Bundle。
 *   工具按 mcp__<server>__<tool> 命名，只有控制面允许的工具进入白名单，需确认的工具逐次审批。
 * - 联网：dsh-web + DeepSeek 搜索提供方 + HTTP 抓取，由 dsh-tool-web 提供 web_search / web_fetch。
 *
 * 任一变化（含凭据）都以新配置重启 dsh 并接续会话，和关联代码、模型切换一致：下一轮生效。
 */
import { createHash } from 'node:crypto';

export const MAX_SKILLS = 20;
export const MAX_SKILL_BYTES = 64_000;
/** 与控制面 skill_files 一致：每个 Skill 最多 20 个附加文件、单个 120 KB、合计 512 KB */
export const MAX_SKILL_FILES = 20;
export const MAX_SKILL_FILE_BYTES = 120_000;
export const MAX_SKILL_FILES_TOTAL_BYTES = 512_000;
export const MAX_MCP_SERVERS = 10;
export const MAX_MCP_TOOLS = 200;
/** DSH 技能名语法（dsh-skill isSkillName）：小写 kebab-case */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** dsh-mcp-client 的 serverName 语法 */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
/** 附加文件路径：references/ 或 assets/ 下一层、非隐藏、常见安全字符 */
export const SKILL_FILE_PATH = /^(references|assets)\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const WEB_SEARCH_PROVIDERS = {
  'deepseek-official': '@deepseek-ai/dsh-web-search-deepseek',
  'deepseek-search-api': '@deepseek-ai/dsh-web-deepseek-api',
} as const;
export type WebSearchProvider = keyof typeof WEB_SEARCH_PROVIDERS;

export interface SkillFile {
  /** Skill 目录内的相对路径，如 references/rules.md */
  path: string;
  content: string;
}
export interface RuntimeSkill {
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  files: SkillFile[];
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
    if (total > MAX_SKILL_FILES_TOTAL_BYTES) throw failure(`Skill ${name} 的附加文件合计超过 512 KB`);
    seen.add(path);
    return { path, content };
  });
}

function resolveSkill(raw: unknown): RuntimeSkill {
  if (!isObject(raw)) throw failure('Skill 配置无效');
  const name = text(raw.name, 64, 'Skill 名称')!;
  if (!SKILL_NAME.test(name)) throw failure(`Skill 名称无效：${name}`);
  const content = text(raw.content, MAX_SKILL_BYTES, `Skill ${name} 正文`)!;
  if (bytes(content) > MAX_SKILL_BYTES) throw failure(`Skill ${name} 正文超过 64 KB`);
  return {
    name,
    description: text(raw.description, 1024, `Skill ${name} 描述`)!,
    ...(raw.whenToUse ? { whenToUse: text(raw.whenToUse, 1024, `Skill ${name} 适用场景`)! } : {}),
    content,
    files: resolveSkillFiles(name, raw),
    source: source(raw.source),
    ...(typeof raw.title === 'string' && raw.title ? { title: raw.title.slice(0, 120) } : {}),
  };
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
    if (typeof raw.provider !== 'string' || !(raw.provider in WEB_SEARCH_PROVIDERS))
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

/** 校验控制面下发的扩展能力；不传视为没有扩展能力。名称冲突直接拒绝（控制面负责去重）。 */
export function resolveCapabilities(raw: unknown): RuntimeCapabilities {
  if (raw === undefined || raw === null) return { skills: [], mcp: [], web: null };
  if (!isObject(raw)) throw failure('扩展能力配置无效');
  const skills = raw.skills === undefined ? [] : raw.skills;
  const mcp = raw.mcp === undefined ? [] : raw.mcp;
  if (!Array.isArray(skills) || skills.length > MAX_SKILLS)
    throw failure(`一个会话最多使用 ${MAX_SKILLS} 个 Skill`);
  if (!Array.isArray(mcp) || mcp.length > MAX_MCP_SERVERS)
    throw failure(`一个会话最多连接 ${MAX_MCP_SERVERS} 个 MCP 服务`);
  const resolved = {
    skills: skills.map(resolveSkill),
    mcp: mcp.map(resolveMcp),
    web: resolveWeb(raw.web),
  };
  const skillNames = resolved.skills.map((skill) => skill.name);
  if (new Set(skillNames).size !== skillNames.length) throw failure('Skill 名称重复');
  const servers = resolved.mcp.map((server) => server.serverName);
  if (new Set(servers).size !== servers.length) throw failure('MCP 服务标识重复');
  return resolved;
}

/**
 * 与 dsh-mcp-client@0.2.2-rc.1 的 publicToolName 保持一致：模型看到的工具名。
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

/** 指纹覆盖全部字段（含凭据）：任一变化都需以新配置重启 dsh */
export function capabilityFingerprint(caps: RuntimeCapabilities) {
  return createHash('sha256').update(JSON.stringify(caps)).digest('hex');
}

/** 对外（事件、日志）展示的摘要：不含正文、凭据、命令与环境变量 */
export function capabilitySummary(caps: RuntimeCapabilities) {
  return {
    skills: caps.skills.map((skill) => ({
      name: skill.name,
      title: skill.title ?? skill.name,
      source: skill.source,
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
