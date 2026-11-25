/** 对话过程中的工具显示名：平台内置工具的中文名，以及 MCP 工具名的展示格式。 */

/** 交付文件工具：模型用它声明本轮最终交付的文件 */
export const PRESENT_TOOL = 'present';
/**
 * 已下线的旧工具名 → 新名（空串表示能力已由运行时自动提供、不再是工具），与平台契约 contracts/platform.json 的 renamed 一致。
 * 旧会话的历史消息与场景快照里仍是旧名，展示时据此识别。
 */
export const LEGACY_TOOL_NAMES: Record<string, string> = {
  workspace_list: 'read',
  workspace_read: 'read',
  workspace_write: 'write',
  workspace_present: 'present',
  current_time: '',
};
/** 工具名换成当前名称；已下线且无替代的返回空串 */
export function canonicalToolName(name: string): string {
  return Object.hasOwn(LEGACY_TOOL_NAMES, name) ? LEGACY_TOOL_NAMES[name] : name;
}
/** 是否为交付文件调用（含旧会话里的 workspace_present） */
export function isPresentTool(name: unknown): boolean {
  return typeof name === 'string' && canonicalToolName(name) === PRESENT_TOOL;
}
/** 平台内置、但不在工具目录（不可单独授权）中的工具显示名 */
export const BUILTIN_TOOL_TITLES: Record<string, string> = {
  [PRESENT_TOOL]: '交付文件',
  edit: '修改文件',
  // 旧会话历史里的工具名
  workspace_list: '查看文件',
  workspace_read: '读取文件',
  workspace_write: '生成文件',
  workspace_present: '交付文件',
  current_time: '获取当前时间',
  // Runner 基础能力中的 DSH 搜索插件
  glob: '查找文件',
  grep: '搜索文件内容',
  bash: '执行终端命令',
  ask_user_question: '向用户提问',
  read: '读取文件',
  write: '生成与修改文件',
  job_output: '读取后台任务输出',
  // 扩展能力
  skill: '加载 Skill',
  web_search: '联网搜索',
  web_fetch: '读取网页',
  // Skill 编写助手（只操作当前编辑的 Skill 草稿）
  skill_read_draft: '读取草稿',
  skill_list_files: '查看文件',
  skill_read_file: '读取文件',
  skill_write_file: '写入文件',
  skill_delete_file: '删除文件',
  skill_read_guide: '查阅写作指南',
  skill_validate_draft: '校验草稿',
  skill_test_script: '试运行脚本',
  skill_trial: '试用最新草稿',
  skill_update_draft: '更新 SKILL.md',
  skill_revision: '更新草稿',
};
/** 内置工具的中文名；MCP 工具（mcp__服务__工具）显示为「服务 · 工具」，其余原样返回 */
export function builtinToolTitle(name: string): string {
  if (BUILTIN_TOOL_TITLES[name]) return BUILTIN_TOOL_TITLES[name];
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}
