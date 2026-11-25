/**
 * 执行策略钩子：工具白名单、带路径工具的路径收窄、搜索结果脱敏、bash 门控与输出脱敏、外部工具逐次确认。
 * 每次决定都经 forge.policy 事件通知 Runner。规则本身在 path-guard / bash-rules，这里只负责挂到 dsh 扩展点上。
 */
import { ENGINE_TOOLS } from '../../src/kernel/dsh/engine-tools.js';
import { notify } from '../shared/events.js';
import { classifyBashCommand, sanitizeShellValue } from './bash-rules.js';
import { filterSecretResults, toolPathDenial } from './path-guard.js';

/** dsh 提供的终端工具名；后台任务输出与终端输出同样需要脱敏 */
const SHELL = ENGINE_TOOLS.shell;
const SHELL_OUTPUT = new Set([SHELL, ENGINE_TOOLS.jobOutput]);

/**
 * 安装策略钩子，返回各自的注销函数。
 * - allowed：本会话白名单（模型可见、允许执行的全部工具）；
 * - root：会话工作区绝对路径；
 * - readRoots：只读根目录（已关联的代码项目 ∪ 本次装配的 Skill 快照目录），[{name, path}]；
 * - approvalTools：管理员标记为「需确认」的外部工具（MCP），每次调用都要用户批准。
 */
export function installPolicyHooks(ctx, { allowed, root, readRoots, approvalTools }) {
  const disposers = [];
  // restrict() 必须通过 agent.ctx 安装；全局上下文会被 dsh 拒绝。
  // agent/created 为串行、可等待事件，首轮提示词装配前即生效。
  disposers.push(
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.restrict({ allow: [...allowed] });
    }),
  );
  // guard 只有 deny，没有 allow，后续插件无法重新放开被禁用的工具。
  disposers.push(
    ctx.tools.guard((exec) => (allowed.has(exec.name) ? undefined : 'Forge 当前部署禁止执行此工具')),
  );
  // 读取、搜索、写入、修改、交付都来自 DSH 官方插件：读取类收窄到会话工作区与已关联的只读目录，
  // 写入类收窄到会话工作区内的非隐藏路径（dsh 文件沙箱只按工作区根目录限制写入）。
  disposers.push(ctx.tools.guard((exec) => toolPathDenial(root, readRoots, exec)));
  if (readRoots.length)
    disposers.push(
      ctx.on('tools/execute', async (exec, next) => filterSecretResults(root, readRoots, exec, await next())),
    );
  // 终端与后台任务输出脱敏：避免通过 git remote -v、输出回显等泄漏包含 token 的远程地址与密钥。
  // 结果是结构化对象（stdout / stderr / output 等），逐个字符串字段脱敏后交给工具自己的 render 生成文本
  disposers.push(
    ctx.on('tools/execute', async (exec, next) => {
      const result = await next();
      if (SHELL_OUTPUT.has(exec.name) && result && typeof result === 'object' && 'value' in result)
        return { ...result, value: sanitizeShellValue(result.value) };
      return result;
    }),
  );
  disposers.push(
    ctx.on('tools/pre-execute', (exec, next) => {
      // 1. 白名单拦截
      if (!allowed.has(exec.name)) {
        notify('forge.policy', {
          tool: exec.name,
          callId: exec.callId,
          arguments: exec.arguments,
          decision: 'deny',
        });
        return { kind: 'deny', reason: 'Forge 工具白名单拒绝' };
      }

      // 2. bash 门控：危险命令拦截(deny)，其余放行(allow)；ask 分支保留兼容，分类器目前不返回
      if (exec.name === SHELL) {
        const classification = classifyBashCommand(exec.arguments?.command, { workspace: root });
        notify('forge.policy', {
          tool: exec.name,
          callId: exec.callId,
          arguments: exec.arguments,
          decision: classification.level,
        });
        if (classification.level === 'deny') {
          return { kind: 'deny', reason: classification.reason };
        }
        if (classification.level === 'ask') {
          return { kind: 'ask', reason: classification.reason };
        }
        return next();
      }

      // 3. 管理员标记为「需确认」的外部工具（MCP）：每次调用都要用户批准
      if (approvalTools.has(exec.name)) {
        notify('forge.policy', {
          tool: exec.name,
          callId: exec.callId,
          arguments: exec.arguments,
          decision: 'ask',
        });
        return {
          kind: 'ask',
          reason: '该工具由外部 MCP 服务提供，管理员要求每次调用前经用户确认',
          displayReason: { en: 'Allow this external tool call?', 'zh-CN': '是否允许调用这个外部工具？' },
        };
      }

      // 4. 其余工具（读写会话工作区、交付、任务清单等）直接放行
      notify('forge.policy', {
        tool: exec.name,
        callId: exec.callId,
        arguments: exec.arguments,
        decision: 'allow',
      });
      return next();
    }),
  );
  return disposers;
}
