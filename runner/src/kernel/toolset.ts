/**
 * 会话工具集：模型可见、允许执行的工具白名单，以及需要装配哪些能力。
 * 平台可管控的内置工具来自平台契约（contracts/platform.json），dsh 原生工具名来自 DSH 适配层。
 */
import { ENGINE_TOOLS } from './dsh/index.js';
import { EMPTY_CAPABILITIES, mcpToolNames, type RuntimeCapabilities } from './capabilities.js';
import type { SessionManifest } from './manifest.js';
import { PLATFORM, singleTool, toolsInGroup } from './platform-contract.js';

/**
 * 基础能力：每个会话默认加载，不需要场景逐个授权。仍以平台策略（allowedTools）为上限，
 * workspace_write 仅写入受限会话目录并直接执行；终端命令直接执行，仅拦截少数高危命令。
 */
export const BASE_TOOLS = toolsInGroup('base');
/** 工作区搜索：随读取权限开放，路径由 forge-runtime 限制在工作区内 */
export const SEARCH_TOOLS = ENGINE_TOOLS.search;
/** 只读 read（带行号、分页、字节上限），关联代码或 Skill 带附加文件时开放，路径同样由 forge-runtime 收窄 */
export const CODE_READ_TOOL = ENGINE_TOOLS.read;
export const SKILL_TOOL = ENGINE_TOOLS.skill;
export const SKILL_SCRIPT_TOOL = singleTool('skill-script');
export const WEB_SEARCH_TOOL = ENGINE_TOOLS.webSearch;
export const WEB_FETCH_TOOL = ENGINE_TOOLS.webFetch;
/** forge-runtime 的交付声明工具：写入开放时附带，不受平台策略单独管控 */
export const PRESENT_TOOL = 'workspace_present';
/** 平台契约各工具组的工具名（DSH 适配层据此决定挂载哪些插件） */
export const GROUP_TOOLS: Record<string, readonly string[]> = Object.fromEntries(
  [...new Set(PLATFORM.tools.map((tool) => tool.group))].map((group) => [group, toolsInGroup(group)]),
);

export interface SessionToolset {
  /** forge-runtime 白名单：模型可见、允许执行的全部工具 */
  allowed: string[];
  /** 是否装配工作区搜索 */
  search: boolean;
  /** 是否关联了代码项目 */
  code: boolean;
  /** 是否开放只读 read（关联代码或 Skill 带附加文件） */
  read: boolean;
  /** 是否装配 Skill */
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
/** 计算工具集需要的清单部分；纯函数，缺省字段按空处理（便于单独测试） */
export type ToolsetInput = {
  tools?: Partial<SessionManifest['tools']>;
  policy?: Partial<SessionManifest['policy']>;
};
export function sessionToolset(
  manifest: ToolsetInput = {},
  hasCode = false,
  caps: RuntimeCapabilities = EMPTY_CAPABILITIES,
): SessionToolset {
  const ceiling = manifest.policy?.allowedTools ?? undefined;
  const declared = manifest.tools?.builtin ?? [];
  const pluginTools = manifest.tools?.plugin ?? [];
  const withinCeiling = (name: string) => !ceiling || ceiling.includes(name);
  // 场景声明的其他内置插件工具（如 Skill 编辑的 skill_*）沿用原有规则：以策略为上限。
  // Skill 编辑会话的策略上限只含 skill_*，因此不会被附加基础能力。
  const builtin = [...new Set([...BASE_TOOLS, ...declared])].filter(withinCeiling);
  const search = builtin.includes('workspace_read') || hasCode;
  const skills = caps.skills.length > 0;
  const read = hasCode || caps.skills.some((skill) => skill.files.length > 0);
  const scripts =
    withinCeiling(SKILL_SCRIPT_TOOL) &&
    caps.skills.some((skill) => skill.files.some((file) => file.path.startsWith('scripts/')));
  const mcp = mcpToolNames(caps);
  const allowed = [
    // bash 已在 BASE_TOOLS 中并经过平台策略筛选：策略未勾选时，即使关联了代码也不开放
    ...builtin,
    ...(builtin.includes('workspace_write') ? [PRESENT_TOOL] : []),
    ...(search ? SEARCH_TOOLS : []),
    ...(read ? [CODE_READ_TOOL] : []),
    // 受管插件工具已由控制面按企业插件策略与场景授权筛选，不再按内置工具策略过滤
    ...pluginTools,
    ...(skills ? [SKILL_TOOL] : []),
    ...(scripts ? [SKILL_SCRIPT_TOOL] : []),
    ...(caps.web?.search ? [WEB_SEARCH_TOOL] : []),
    ...(caps.web?.fetch ? [WEB_FETCH_TOOL] : []),
    ...mcp.allowed,
  ];
  return {
    allowed: [...new Set(allowed)],
    search,
    code: hasCode,
    read,
    skills,
    // Skill 脚本与 bash 同等对待：直接执行，不再逐次确认
    approval: mcp.approval,
  };
}
