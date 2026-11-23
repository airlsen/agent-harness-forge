/**
 * Forge Skill 装配：把控制面下发、Runner 校验过的 Skill 注册为 DSH 运行时 Skill。
 *
 * - 不扫描任何文件系统根目录（不读取宿主机或项目里的 .agents/skills 等），会话只看到被授权的 Skill；
 * - 正文由 dsh-tool-skill 的 skill 工具按需加载；用户可在消息中用 /名称 直接调用；
 * - resourceBase 始终指向 Runner 物化的只读快照目录（SKILL.md + references/、assets/、scripts/，
 *   按修订号与内容哈希命名），正文中的相对路径按它解析；有附加文件时模型用 read 读取（路径由 forge-runtime
 *   收窄到本次装配的快照目录），脚本只能经 skill_run_script 逐次审批后运行。
 */
import { notify } from '../shared/events.js';

export const name = 'forge-skills';
export const inject = ['skills'];

export function apply(ctx, config) {
  const skills = Array.isArray(config?.skills) ? config.skills : [];
  const disposers = [];
  for (const skill of skills) {
    disposers.push(
      ctx.skills.register({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
        content: skill.content,
        source: 'runtime',
        invocation: { modelInvocable: true, userInvocable: true },
        // 兼容未传目录的调用方（Runner 总会传）：退回不可解析的说明，避免模型拼出不存在的路径
        ...(typeof skill.dir === 'string' && skill.dir
          ? { resourceBase: { kind: 'directory', path: skill.dir } }
          : { resourceBase: { kind: 'opaque', description: '此 Skill 只有正文，没有可读取的目录。' } }),
      }),
    );
  }
  notify('forge.skills_loaded', { skills: skills.map((skill) => skill.name) });
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
