/**
 * 会话工具集：模型可见、允许执行的工具白名单，以及需要装配哪些能力。
 * 平台可管控的内置工具来自平台契约（contracts/platform.json），dsh 原生工具名来自 DSH 适配层。
 */
import { ENGINE_TOOLS } from './dsh/index.js';
import { EMPTY_CAPABILITIES, mcpToolNames, type RuntimeCapabilities } from './capabilities.js';
import type { SessionManifest } from './manifest.js';
import { COMPANION_TOOLS, PLATFORM, canonicalTools, singleTool, toolsInGroup } from './platform-contract.js';

/**
 * 基础能力（read / write / bash）：每个会话默认加载，不需要场景逐个授权。仍以平台策略（allowedTools）为上限；
 * write 只能写会话工作区并直接执行；终端命令在 dsh 沙箱中直接执行，仅拦截少数高危命令。
 */
export const BASE_TOOLS = toolsInGroup('base');
/** 搜索（glob / grep）：随读取权限开放，路径由 forge-runtime 限制在工作区与已关联的只读目录内 */
export const SEARCH_TOOLS = ENGINE_TOOLS.search;
/** 读取（带行号、分页、字节上限）：基础能力；关联代码或 Skill 带附加文件时即使策略未开放也提供，路径同样由 forge-runtime 收窄 */
export const CODE_READ_TOOL = ENGINE_TOOLS.read;
export const SKILL_TOOL = ENGINE_TOOLS.skill;
/** 终端工具（dsh 内置持久 bash，属于基础能力，仍以平台策略为上限） */
export const SHELL_TOOL = ENGINE_TOOLS.shell;
export const SKILL_SCRIPT_TOOL = singleTool('skill-script');
export const WEB_SEARCH_TOOL = ENGINE_TOOLS.webSearch;
export const WEB_FETCH_TOOL = ENGINE_TOOLS.webFetch;
/** 平台契约各工具组的工具名（DSH 适配层据此决定挂载哪些插件） */
export const GROUP_TOOLS: Record<string, readonly string[]> = Object.fromEntries(
  [...new Set(PLATFORM.tools.map((tool) => tool.group))].map((group) => [group, toolsInGroup(group)]),
);

export interface SessionToolset {
  /** forge-runtime 白名单：模型可见、允许执行的全部工具 */
  allowed: string[];
  /** 是否开放搜索（glob / grep） */
  search: boolean;
  /** 是否关联了代码项目 */
  code: boolean;
  /** 是否开放读取（read） */
  read: boolean;
  /** 是否开放写入（write，附带 edit 与交付声明 present） */
  write: boolean;
  /** 是否装配 Skill */
  skills: boolean;
  /** 需要逐次确认的工具（管理员标记为需确认的 MCP 工具） */
  approval: string[];
}
/**
 * 计算会话工具集：基础能力 ∪ 场景声明，Forge 内置工具以平台策略为上限；
 * 写入开放时附带修改与交付声明，读取开放时附带 glob/grep 搜索；插件工具原样保留。
 * 旧版本保存的工具名（workspace_* 等）先按平台契约换成新名。
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
  const ceiling = manifest.policy?.allowedTools ? canonicalTools(manifest.policy.allowedTools) : undefined;
  const declared = canonicalTools(manifest.tools?.builtin ?? []);
  const pluginTools = manifest.tools?.plugin ?? [];
  const withinCeiling = (name: string) => !ceiling || ceiling.includes(name);
  // 场景声明的其他内置插件工具（如 Skill 编辑的 skill_*）沿用原有规则：以策略为上限。
  // Skill 编辑会话的策略上限只含 skill_*，因此不会被附加基础能力。
  const builtin = [...new Set([...BASE_TOOLS, ...declared])].filter(withinCeiling);
  const search = builtin.includes(CODE_READ_TOOL) || hasCode;
  const skills = caps.skills.length > 0;
  const read = search || caps.skills.some((skill) => skill.files.length > 0);
  const scripts =
    withinCeiling(SKILL_SCRIPT_TOOL) &&
    caps.skills.some((skill) => skill.files.some((file) => file.path.startsWith('scripts/')));
  const mcp = mcpToolNames(caps);
  const allowed = [
    // bash 已在 BASE_TOOLS 中并经过平台策略筛选：策略未勾选时，即使关联了代码也不开放
    ...builtin,
    // 附属工具（契约中带 follows，如修改、交付声明跟随写入）随被跟随的工具开放，不受平台策略单独管控
    ...builtin.flatMap((name) => COMPANION_TOOLS[name] ?? []),
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
    write: builtin.includes(ENGINE_TOOLS.write),
    skills,
    // Skill 脚本与 bash 同等对待：直接执行，不再逐次确认
    approval: mcp.approval,
  };
}
