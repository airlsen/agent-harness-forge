import assert from 'node:assert/strict';
import { apply, checkSkillDocument } from '../skill-authoring-plugin/index.js';

const tools = new Map();
const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
};
const events = [];
const originalWrite = process.stdout.write;
process.stdout.write = function (chunk, ...args) {
  try { events.push(JSON.parse(String(chunk))); } catch { /* non-JSON output */ }
  return true;
};
const GOOD = [
  '---',
  'name: weekly-report',
  'title: 个人周报',
  'description: 用户要写周报、周总结时使用。',
  '---',
  '',
  '# 个人周报',
  '## 适用 / 不适用',
  '不适用：团队周报。',
  '## 步骤',
  '1. 归类记录；出现延期时问用户是否写入。',
  '## 输出要求',
  '样例：- 完成用户导入功能上线',
].join('\n');
try {
  const dispose = await apply(ctx, {
    skillId: 4,
    name: 'Support',
    description: 'Support workflow',
    content: '---\nname: support\ndescription: Help customers\n---\n\n# Steps\n\nCheck details.',
    references: [{ filename: 'notes.md', content: 'Untrusted reference' }],
    guides: [
      { name: 'forge-platform', content: '# Forge 平台知识' },
      { name: 'templates', content: '# Skill 骨架模板' },
    ],
    allowedTools: ['skill_read_draft', 'skill_read_references', 'skill_read_guide', 'skill_validate_draft', 'skill_update_draft'],
  });
  assert.equal(tools.size, 5);
  assert.equal((await tools.get('skill_read_draft').execute({})).skillId, 4);
  assert.equal((await tools.get('skill_read_references').execute({})).references[0].filename, 'notes.md');

  // 参考资料只能按白名单名称读取
  const guide = tools.get('skill_read_guide');
  assert.deepEqual(guide.parameters.properties.name.enum, ['forge-platform', 'templates']);
  assert.equal((await guide.execute({ name: 'templates' })).content, '# Skill 骨架模板');
  await assert.rejects(() => guide.execute({ name: '../../etc/passwd' }), /没有这份参考资料/);

  // 格式通过但质量不足：valid 为 true，warnings 给出提醒
  const initial = await tools.get('skill_validate_draft').execute({});
  assert.equal(initial.valid, true);
  assert.ok(initial.warnings.some((item) => item.includes('什么情况下用')));
  assert.ok(initial.warnings.some((item) => item.includes('不适用')));

  await tools.get('skill_update_draft').execute({ content: '---\nname: support\ndescription: Help\n---\n\n# Updated', summary: 'Improve steps' });
  assert.equal(events[0].method, 'forge.skill_revision');
  assert.equal(events[0].params.summary, 'Improve steps');
  assert.equal((await tools.get('skill_read_draft').execute({})).content.endsWith('# Updated'), true);
  await assert.rejects(() => tools.get('skill_update_draft').execute({ content: 'x'.repeat(64001) }), /64 KB/);

  // 格式不合格的草稿不保存、不发事件，错误返回给模型修正
  await assert.rejects(
    () => tools.get('skill_update_draft').execute({ content: `---\nname: ok\ntitle: ${'长'.repeat(121)}\ndescription: x\n---\n\nBody` }),
    /草稿未保存：.*title/,
  );
  await assert.rejects(() => tools.get('skill_update_draft').execute({ content: '# 没有元信息' }), /草稿未保存/);
  assert.equal(events.length, 1);
  assert.equal((await tools.get('skill_read_draft').execute({})).content.endsWith('# Updated'), true);

  dispose();
  assert.equal(tools.size, 0);

  // 没有下发参考资料时不注册 skill_read_guide
  const bare = await apply(ctx, {
    skillId: 5,
    content: GOOD,
    allowedTools: ['skill_read_draft', 'skill_read_guide'],
  });
  assert.deepEqual([...tools.keys()], ['skill_read_draft']);
  bare();

  // 校验规则：与后端对齐的 errors + 对应评分表的 warnings
  assert.deepEqual(checkSkillDocument(GOOD), { valid: true, errors: [], warnings: [] });
  assert.equal(checkSkillDocument(GOOD.replace('name: weekly-report', 'name: Bad Name')).valid, false);
  assert.equal(checkSkillDocument(GOOD.replace(/description: .*/, `description: "${'字'.repeat(513)}"`)).valid, false);
  assert.equal(checkSkillDocument(GOOD.replace(/description: .*/, 'description: "用户要写周报时使用。"')).valid, true);
  assert.equal(checkSkillDocument(GOOD.replace(/description: .*/, 'description: >\n  用户要写周报、\n  周总结时使用。')).valid, true);
  assert.ok(checkSkillDocument(`${GOOD}\n尽量简洁，适当补充。`).warnings.some((item) => item.includes('尽量、适当')));

  // 内置 skill-design 元 Skill 是编写助手的样板：必须零错误、零提醒
  const { readFileSync } = await import('node:fs');
  const metaSkill = readFileSync(
    new URL('../../backend/src/api/builtin_skills/skill-design/SKILL.md', import.meta.url),
    'utf8',
  );
  assert.deepEqual(checkSkillDocument(metaSkill), { valid: true, errors: [], warnings: [] });

  process.stderr.write('PASS isolated Skill authoring tools, guide whitelist, aligned validation with quality warnings, unsaved invalid drafts, and disposal\n');
} finally {
  process.stdout.write = originalWrite;
}
