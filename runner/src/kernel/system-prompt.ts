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

const FALLBACK_IDENTITY = '你是 Forge 企业智能体，请准确、清晰地回答用户。';
const WORKSPACE_RULE = '所有文件操作仅限当前会话工作区。不可声称执行了未实际调用的工具。';

type StructuredPrompt = {
  identity?: string;
  domain?: string;
  safety?: string[];
  workspace?: string[];
};

export function buildSystemPrompt(prompt: unknown): string {
  const sections =
    prompt && typeof prompt === 'object'
      ? [
          (prompt as StructuredPrompt).identity,
          (prompt as StructuredPrompt).domain,
          ...((prompt as StructuredPrompt).safety ?? []),
          ...((prompt as StructuredPrompt).workspace ?? []),
          ...RENDER_GUIDE,
          WORKSPACE_RULE,
        ]
      : [prompt == null || prompt === '' ? FALLBACK_IDENTITY : String(prompt), ...RENDER_GUIDE];
  return sections.filter(Boolean).join('\n\n');
}
