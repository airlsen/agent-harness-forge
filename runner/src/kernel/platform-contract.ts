/**
 * 控制面与 Runner 共用的平台契约（仓库根目录 contracts/platform.json，唯一来源）：
 * 平台内置工具目录（按 group 决定装配哪个插件，provider 标明由谁提供）与能力上限。
 * 两端读同一份文件，不再各自手抄；分开部署时可用 FORGE_PLATFORM_CONTRACT 指定路径。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** base：每个会话默认加载（forge-runtime）；其余各组对应一个按需装配的插件 */
export type ToolGroup = 'base' | 'skill-script' | 'todo' | 'jobs' | 'goal';
export interface PlatformTool {
  name: string;
  title: string;
  description: string;
  permission: 'read' | 'write';
  icon: string;
  group: ToolGroup;
  /**
   * 提供者：dsh 包名（@deepseek-ai/…，npm run contract 核对工具名仍在该包中），
   * 或 Forge 自有插件名（forge-plugins.ts 中登记，check-wiring 核对该插件确实注册了此工具）
   */
  provider: string;
  /** 附属工具：随被跟随的工具一同开放，不在平台策略中单独管控（如 present、edit 跟随 write） */
  follows?: string;
}
export interface PlatformLimits {
  sessionSkills: number;
  sessionMcpServers: number;
  skillFiles: number;
  skillFileBytes: number;
  skillFilesTotalBytes: number;
}
export interface PlatformContract {
  version: number;
  tools: PlatformTool[];
  /** 已下线的旧工具名 → 新工具名；空串表示该能力已由 DSH 自动提供（如当前时间），不再是工具 */
  renamed: Record<string, string>;
  limits: PlatformLimits;
}

const GROUPS: ToolGroup[] = ['base', 'skill-script', 'todo', 'jobs', 'goal'];
const LIMIT_KEYS: Array<keyof PlatformLimits> = [
  'sessionSkills',
  'sessionMcpServers',
  'skillFiles',
  'skillFileBytes',
  'skillFilesTotalBytes',
];
export const PLATFORM_CONTRACT_PATH = resolve(
  process.env.FORGE_PLATFORM_CONTRACT ??
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/platform.json'),
);

/** 读取并校验契约；格式不对时启动即失败，而不是运行到某个会话才出错 */
export function loadPlatformContract(path = PLATFORM_CONTRACT_PATH): PlatformContract {
  const data = JSON.parse(readFileSync(path, 'utf8')) as PlatformContract;
  if (!Array.isArray(data.tools) || !data.tools.length) throw new Error(`平台契约缺少工具目录：${path}`);
  const names = new Set<string>();
  for (const tool of data.tools) {
    for (const field of ['name', 'title', 'description', 'permission', 'icon', 'group', 'provider'] as const)
      if (typeof tool[field] !== 'string' || !tool[field])
        throw new Error(`平台契约中的工具 ${tool.name ?? '?'} 缺少字段 ${field}`);
    if (!GROUPS.includes(tool.group))
      throw new Error(`平台契约中的工具 ${tool.name} 分组无效：${tool.group}`);
    if (names.has(tool.name)) throw new Error(`平台契约中的工具重复：${tool.name}`);
    names.add(tool.name);
  }
  for (const tool of data.tools) {
    if (tool.follows === undefined) continue;
    const leader = data.tools.find((item) => item.name === tool.follows);
    if (!leader || leader.follows !== undefined)
      throw new Error(`平台契约中的工具 ${tool.name} 跟随的 ${tool.follows} 不存在或本身是附属工具`);
  }
  if (!data.renamed || typeof data.renamed !== 'object') throw new Error(`平台契约缺少 renamed：${path}`);
  for (const [old, next] of Object.entries(data.renamed))
    if (names.has(old) || (next !== '' && !names.has(next)))
      throw new Error(`平台契约 renamed 中的 ${old} → ${next} 无效：旧名不能仍在目录中，新名必须在目录中`);
  for (const key of LIMIT_KEYS)
    if (!Number.isSafeInteger(data.limits?.[key]) || data.limits[key] <= 0)
      throw new Error(`平台契约缺少上限 ${key}`);
  return data;
}

export const PLATFORM = loadPlatformContract();
export const LIMITS = PLATFORM.limits;
/** 某一组中受平台策略管控的工具名（不含附属工具，保持契约中的顺序） */
export function toolsInGroup(group: ToolGroup): string[] {
  return PLATFORM.tools
    .filter((tool) => tool.group === group && tool.follows === undefined)
    .map((tool) => tool.name);
}
/** 附属工具：被跟随的工具名 → 随它一同开放的工具名 */
export const COMPANION_TOOLS: Record<string, string[]> = {};
for (const tool of PLATFORM.tools)
  if (tool.follows !== undefined) (COMPANION_TOOLS[tool.follows] ??= []).push(tool.name);
/** 只有一个工具的组（如 todo、skill-script）取其工具名；契约改坏时启动即失败 */
export function singleTool(group: ToolGroup): string {
  const tools = toolsInGroup(group);
  if (tools.length !== 1) throw new Error(`平台契约中 ${group} 组应恰好有一个工具`);
  return tools[0];
}
/**
 * 把工具名换成当前名称：旧版本保存的名称（企业策略、场景快照、会话清单里的 workspace_* 等）按 renamed 换新，
 * 已由 DSH 自动提供的能力（renamed 为空串）去掉；其余名称原样保留，结果去重并保持顺序。
 */
export function canonicalTools(names: readonly string[]): string[] {
  const out = names.map((name) => (Object.hasOwn(PLATFORM.renamed, name) ? PLATFORM.renamed[name] : name));
  return [...new Set(out.filter(Boolean))];
}
