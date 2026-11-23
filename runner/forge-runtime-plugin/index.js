/**
 * Forge 业务插件（每个会话都装配）：真实 OpenAI-compatible 模型出口 + 受限会话工具 + 执行门控。无假模型。
 * 本文件只做组装，各部分职责：
 * - limits.js：工作区配额与读取上限；
 * - path-guard.js：带路径工具的路径收窄、搜索结果脱敏、工作区路径校验；
 * - bash-rules.js：bash 命令分类与输出脱敏（纯函数）；
 * - gateway.js：模型网关（dsh LlmAdapter）；
 * - workspace-tools.js：current_time 与 workspace_* 工具；
 * - policy-hooks.js：白名单、路径守卫、bash 门控、外部工具确认等执行钩子。
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GatewayAdapter } from './gateway.js';
import { installPolicyHooks } from './policy-hooks.js';
import { registerWorkspaceTools } from './workspace-tools.js';

export { searchPathDenial, toolPathDenial, filterSecretResults } from './path-guard.js';
export { classifyBashCommand, sanitizeGitOutput } from './bash-rules.js';

export const name = 'forge-runtime';
export const inject = ['llm', 'tools', 'approval'];

export async function apply(ctx, config) {
  // 变量名含 SECRET：DSH 为 stdio MCP 子进程清洗环境变量时会剔除它，模型密钥不会泄露给外部程序
  const connection = JSON.parse(process.env.FORGE_MODEL_SECRET_CONFIG ?? '{}');
  if (!connection.baseUrl || !connection.model) throw new Error('Forge model gateway is not configured');
  const allowed = new Set(config.allowedTools ?? []);
  const root = resolve(config.workspace);
  await mkdir(root, { recursive: true });
  // 只读根目录 = 已关联的代码项目 ∪ 本次装配的 Skill 快照目录（Runner 物化，模型用 read 按需读取；旧快照不在其中）
  const readRoots = [
    ...(Array.isArray(config.codeProjects) ? config.codeProjects : []),
    ...(Array.isArray(config.readRoots) ? config.readRoots : []),
  ].filter((item) => item && typeof item.path === 'string');
  const disposers = [
    ctx.llm.registerAdapter(['forge-gateway'], new GatewayAdapter({ ...connection, ...config })),
    ...registerWorkspaceTools(ctx, root),
    ...installPolicyHooks(ctx, {
      allowed,
      root,
      readRoots,
      approvalTools: new Set((config.approvalTools ?? []).filter((tool) => allowed.has(tool))),
    }),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
