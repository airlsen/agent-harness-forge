import { runSkillScript } from '../skill-script-runtime/index.js';

export const name = 'skill-scripts';
export const inject = ['tools'];

export async function apply(ctx, config) {
  const skills = new Map((config.skills ?? []).map((skill) => [skill.name, skill]));
  return ctx.tools.register({
    name: 'skill_run_script',
    description: '运行已授权 Skill 中 scripts/ 下的脚本。需要用户批准；脚本在隔离环境中运行，只有 Skill 只读文件和临时工作目录可见，无网络访问。',
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
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async ({ skill, path, args }) => {
      const item = skills.get(skill);
      if (!item || !item.scripts.includes(path)) throw new Error('此 Skill 未授权该脚本');
      return runSkillScript(item.dir, path, args ?? []);
    },
  });
}
