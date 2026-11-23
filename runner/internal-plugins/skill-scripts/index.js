import { runSkillScript } from '../shared/skill-script-runtime/index.js';

export const name = 'skill-scripts';
export const inject = ['tools'];

export async function apply(ctx, config) {
  const skills = new Map((config.skills ?? []).map((skill) => [skill.name, skill]));
  return ctx.tools.register({
    name: 'skill_run_script',
    description:
      '运行已授权 Skill 中 scripts/ 下的脚本，直接执行，单次最长 5 分钟。脚本在会话工作区的 outputs/<脚本名>-<时间>/ 下运行，写出的文件保留在那里（结果中的 outputs 列出产出路径）；环境变量 FORGE_SKILL_DIR 指向 Skill 目录。',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '已加载的 Skill 英文名称' },
        path: { type: 'string', description: '脚本相对路径，例如 scripts/check.py' },
        args: { type: 'array', items: { type: 'string' }, description: '脚本参数（不支持 Shell 展开）' },
      },
      required: ['skill', 'path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async ({ skill, path, args }) => {
      const item = skills.get(skill);
      if (!item || !item.scripts.includes(path)) throw new Error('此 Skill 未授权该脚本');
      return runSkillScript(
        item.dir,
        path,
        args ?? [],
        config.workspace ? { outputRoot: config.workspace } : {},
      );
    },
  });
}
