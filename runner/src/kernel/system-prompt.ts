/**
 * 系统提示词拼装。
 *
 * 富内容渲染（代码高亮、Mermaid 图、Vega-Lite 图表）是对话界面的平台能力，与具体场景无关；
 * 场景 Bundle 是发布时的不可变快照，若把说明写进 Bundle，已发布的场景永远拿不到。
 * 因此渲染说明由 runner 在每次会话启动时统一追加。
 */

export const RENDER_GUIDE: readonly string[] = [
  '对话界面会把 Markdown 直接渲染给用户：代码一律用标注了语言的围栏代码块输出，会显示为语法高亮代码。',
  '界面会把 ```mermaid 和 ```vega 围栏代码块直接渲染成图形，这就是你的绘图能力；不要说自己无法画图，也不要让用户复制到 mermaid.live、Typora 等外部工具或改用 matplotlib 等本地方案。',
  '流程图、时序图、架构图、状态图、甘特图用 ```mermaid 输出合法的 Mermaid 源码；节点文字含括号、引号等特殊字符时用双引号包裹。',
  '柱状图、折线图、饼图、散点图等数据图表优先用 ```vega 输出一个合法、自包含的 Vega-Lite JSON 规范：数据直接写在 data.values 内，不引用外部 URL，不写 config 配色（界面会统一配色）。',
];

/**
 * 工作区基础能力说明：按会话实际可用的工具生成，避免模型只把文件内容贴在回复里、
 * 或声称已保存却没有调用工具。
 */
export function workspaceGuide(tools: readonly string[]): string[] {
  const has = (name: string) => tools.includes(name);
  const lines: string[] = [];
  if (has('workspace_write'))
    lines.push(
      '你可以在当前会话工作区创建文件。用户要求生成、保存或导出文件（例如 Markdown 报告、代码、CSV、HTML）时，必须调用 workspace_write 写入完整内容，路径使用工作区内的相对路径（如 report.md、docs/plan.md）；写入可能需要用户批准，批准并成功后才算保存。不要只在回复里贴出内容，也不要在没有成功调用工具时声称已经保存。',
    );
  if (has('workspace_present'))
    lines.push(
      '文件写好后调用 workspace_present 声明最终交付物（通常 1–2 个），界面会在回复下方展示可预览、下载的文件卡片；回复里简要说明文件内容即可，不必再完整粘贴。',
    );
  if (has('glob') || has('grep') || has('workspace_read'))
    lines.push(
      [
        has('workspace_list') ? 'workspace_list 列出工作区文件' : '',
        has('glob') ? 'glob 按文件名模式查找' : '',
        has('grep') ? 'grep 按正则搜索文件内容' : '',
        has('workspace_read')
          ? 'workspace_read 只读读取文本文件（可用 offset/limit 读取 grep 命中附近的行）'
          : '',
      ]
        .filter(Boolean)
        .join('，') + '。这些工具只能访问当前会话工作区，路径一律使用相对路径。',
    );
  return lines;
}

const FALLBACK_IDENTITY = '你是 Forge 企业智能体，请准确、清晰地回答用户。';
const WORKSPACE_RULE = '所有文件操作仅限当前会话工作区。不可声称执行了未实际调用的工具。';

type StructuredPrompt = {
  identity?: string;
  domain?: string;
  safety?: string[];
  workspace?: string[];
};

export function buildSystemPrompt(prompt: unknown, tools: readonly string[] = []): string {
  const guide = workspaceGuide(tools);
  const sections =
    prompt && typeof prompt === 'object'
      ? [
          (prompt as StructuredPrompt).identity,
          (prompt as StructuredPrompt).domain,
          ...((prompt as StructuredPrompt).safety ?? []),
          ...((prompt as StructuredPrompt).workspace ?? []),
          ...RENDER_GUIDE,
          ...guide,
          WORKSPACE_RULE,
        ]
      : [prompt == null || prompt === '' ? FALLBACK_IDENTITY : String(prompt), ...RENDER_GUIDE, ...guide];
  return sections.filter(Boolean).join('\n\n');
}
