/**
 * Forge 业务插件（每个会话都装配）：系统提示 + 执行门控 + 工作区配额 + 实时输出转发。
 * 模型出口（llm-pi-ai）以及文件读写、交付、终端、时间等工具都来自 dsh 官方插件（sdk profile），
 * 这里只做平台层。本文件只做组装，各部分职责：
 * - limits.js：工作区配额与路径上限；
 * - path-guard.js：带路径工具的路径收窄（读取 / 写入两种范围）、搜索结果脱敏；
 * - bash-rules.js：bash 命令分类与输出脱敏（纯函数）；
 * - live-stream.js：生成过程中的正文 / 思考片段实时推给 Runner；
 * - workspace-bridge.js：写入配额，文件与交付物的实时同步事件；
 * - policy-hooks.js：白名单、路径守卫、bash 门控、外部工具确认等执行钩子。
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { notify } from '../shared/events.js';
import { installLiveStream } from './live-stream.js';
import { installPolicyHooks } from './policy-hooks.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

export { searchPathDenial, toolPathDenial, filterSecretResults, workspacePathDenial } from './path-guard.js';
export { classifyBashCommand, sanitizeGitOutput, sanitizeShellValue } from './bash-rules.js';

export const name = 'forge-runtime';
export const inject = ['tools', 'approval', 'systemPrompt'];

/**
 * 场景系统提示：作为一个不做变量插值的段落注入（dsh 会把段落里的 {{name}} 当作变量，
 * 场景提示词或 Skill 编写指南里出现的模板占位符会让每次请求失败）。排在部署人设的位置，即提示词最前面。
 */
function registerSystemPrompt(ctx, text) {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  return ctx.systemPrompt.section({
    name: 'forge:system-prompt',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text,
    interpolate: false,
  });
}

/**
 * 探测服务器是否支持终端沙箱（bwrap 或 Landlock）：结果经 forge.sandbox 通知 Runner。
 * 不支持时 dsh 会拒绝执行每条命令（不会裸跑），Runner 拒绝开放终端会话。
 */
function probeSandbox(ctx, root) {
  return ctx.inject(['sandbox'], async (scope) => {
    try {
      const confined = await scope.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: root });
      notify('forge.sandbox', { available: true, enforcement: confined?.enforcement ?? 'full' });
    } catch (error) {
      notify('forge.sandbox', { available: false, reason: error?.code ?? error?.message ?? 'unknown' });
    }
  });
}

export async function apply(ctx, config) {
  const allowed = new Set(config.allowedTools ?? []);
  const root = resolve(config.workspace);
  await mkdir(root, { recursive: true });
  // 只读根目录 = 已关联的代码项目 ∪ 本次装配的 Skill 快照目录（Runner 物化，模型用 read 按需读取；旧快照不在其中）
  // ∪ 大结果转存目录（dsh 把超长的工具结果存成文件，提示模型用 read 读取）
  const readRoots = [
    ...(Array.isArray(config.codeProjects) ? config.codeProjects : []),
    ...(Array.isArray(config.readRoots) ? config.readRoots : []),
    ...(typeof config.spillDir === 'string' ? [{ name: 'spill', path: resolve(config.spillDir) }] : []),
  ].filter((item) => item && typeof item.path === 'string');
  const disposers = [
    installLiveStream(ctx),
    registerSystemPrompt(ctx, config.systemPrompt),
    ...installPolicyHooks(ctx, {
      allowed,
      root,
      readRoots,
      approvalTools: new Set((config.approvalTools ?? []).filter((tool) => allowed.has(tool))),
    }),
    ...installWorkspaceBridge(ctx, root),
    ...(config.probeSandbox ? [probeSandbox(ctx, root)] : []),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
