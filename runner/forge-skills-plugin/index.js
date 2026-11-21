/**
 * Forge Skill 装配：把控制面下发、Runner 校验过的 Skill 注册为 DSH 运行时 Skill。
 *
 * - 不扫描任何文件系统根目录（不读取宿主机或项目里的 .agents/skills 等），会话只看到被授权的 Skill；
 * - 正文由 dsh-tool-skill 的 skill 工具按需加载；用户可在消息中用 /名称 直接调用；
 * - 有附加文件时 resourceBase 指向 Runner 物化的只读 Skill 目录（references/、assets/），
 *   正文中的相对路径按它解析，模型用 read 读取（路径由 forge-runtime 收窄）。
 */
export const name = 'forge-skills';
export const inject = ['skills'];

const notify = (method, params) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

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
        ...(skill.dir
          ? { resourceBase: { kind: 'directory', path: skill.dir } }
          : { resourceBase: { kind: 'opaque', description: '此 Skill 只有正文，没有 references/、assets/ 文件。' } }),
      }),
    );
  }
  notify('forge.skills_loaded', { skills: skills.map((skill) => skill.name) });
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
