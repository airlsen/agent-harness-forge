/** 对话过程中的工具显示名：平台内置工具的中文名，以及 MCP 工具名的展示格式。 */

/** 交付文件工具：模型用它声明本轮最终交付的文件 */
export const PRESENT_TOOL = 'workspace_present';
/** 平台内置、但不在工具目录（不可单独授权）中的工具显示名 */
export const BUILTIN_TOOL_TITLES: Record<string, string> = {
  [PRESENT_TOOL]: '交付文件',
  // Runner 基础能力中的 DSH 搜索插件
  glob: '查找文件',
  grep: '搜索文件内容',
  bash: '执行终端命令',
  // 关联代码、Skill 参考资料的只读读取
  read: '读取文件',
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
