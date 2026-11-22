import assert from 'node:assert/strict';
import { apply, checkSkillDocument, validateFilePath } from '../skill-authoring-plugin/index.js';

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
    files: [{ path: 'references/notes.md', content: 'Untrusted reference' }],
    guides: [
      { name: 'forge-platform', content: '# Forge 平台知识' },
      { name: 'templates', content: '# Skill 骨架模板' },
    ],
    allowedTools: [
      'skill_read_draft',
      'skill_list_files',
      'skill_read_file',
      'skill_read_guide',
      'skill_validate_draft',
      'skill_update_draft',
      'skill_write_file',
      'skill_delete_file',
      'skill_test_script',
    ],
  });
  assert.equal(tools.size, 9);
  assert.equal((await tools.get('skill_read_draft').execute({})).skillId, 4);
  assert.deepEqual((await tools.get('skill_list_files').execute({})).files, [
    { path: 'references/notes.md', bytes: 19, mentioned: false },
  ]);
  assert.equal((await tools.get('skill_read_file').execute({ path: 'references/notes.md' })).content, 'Untrusted reference');
  assert.ok((await tools.get('skill_read_file').execute({ path: 'SKILL.md' })).content.includes('# Steps'));
  await assert.rejects(() => tools.get('skill_read_file').execute({ path: 'references/none.md' }), /文件不存在/);

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

  // 文件工具：写入 / 覆盖 / 删除都发修订事件；路径、类型、容量不合规时不保存
  const write = tools.get('skill_write_file');
  const created = await write.execute({ path: 'assets/report-template.md', content: '# 模板', summary: '新增模板' });
  assert.equal(created.created, true);
  assert.match(created.warnings[0], /还没有提到 assets\/report-template\.md/);
  assert.deepEqual(events.at(-1).params, {
    action: 'write_file',
    path: 'assets/report-template.md',
    content: '# 模板',
    summary: '新增模板',
  });
  assert.equal((await write.execute({ path: 'assets/report-template.md', content: '# 模板 v2' })).created, false);
  assert.equal((await write.execute({ path: 'scripts/check.py', content: 'print("ok")' })).created, true);
  await assert.rejects(() => tools.get('skill_test_script').execute({ path: 'scripts/unknown.py' }), /脚本不存在/);
  for (const [path, message] of [
    ['scripts/run.exe', /只支持/],
    ['SKILL.md', /skill_update_draft/],
    ['references/a/b.md', /目录\/文件名/],
    ['../x.md', /references\/、assets\/ 或 scripts\//],
    ['references/规则.md', /文件名只能/],
    ['references/data.json', /只支持/],
  ])
    await assert.rejects(() => write.execute({ path, content: 'x' }), message, path);
  await assert.rejects(() => write.execute({ path: 'references/big.md', content: 'x'.repeat(120001) }), /120 KB/);
  const before = events.length;
  for (let index = 0; index < 17; index += 1) await write.execute({ path: `references/r${index}.md`, content: 'r' });
  await assert.rejects(() => write.execute({ path: 'references/one-more.md', content: 'x' }), /最多 20 个/);
  await write.execute({ path: 'references/r0.md', content: 'still fine' }); // 覆盖不增加数量
  assert.equal(events.length, before + 18);
  for (let index = 0; index < 17; index += 1) await tools.get('skill_delete_file').execute({ path: `references/r${index}.md` });
  assert.deepEqual(events.at(-1).params, { action: 'delete_file', path: 'references/r16.md', summary: '' });
  await assert.rejects(() => tools.get('skill_delete_file').execute({ path: 'references/r0.md' }), /文件不存在/);
  for (let index = 0; index < 4; index += 1)
    await write.execute({ path: `assets/big${index}.md`, content: 'x'.repeat(110000) });
  await assert.rejects(() => write.execute({ path: 'assets/big4.md', content: 'x'.repeat(110000) }), /512 KB/);
  for (let index = 0; index < 4; index += 1) await tools.get('skill_delete_file').execute({ path: `assets/big${index}.md` });

  // 正文更新只发送正文（不回传文件清单），并检查正文与文件的引用是否对应
  const saved = await tools.get('skill_update_draft').execute({
    content: '---\nname: support\ndescription: Help\n---\n\n# Updated\n\n按 assets/report-template.md 输出，规则见 references/missing.md。',
  });
  assert.deepEqual(Object.keys(events.at(-1).params).sort(), ['action', 'content', 'summary']);
  assert.equal(events.at(-1).params.action, 'update_draft');
  assert.ok(saved.warnings.some((item) => item.includes('references/notes.md 没有在 SKILL.md 中提到')));
  assert.ok(saved.warnings.some((item) => item.includes('references/missing.md，但文件不存在')));
  assert.ok(!saved.warnings.some((item) => item.includes('assets/report-template.md')));
  const deleted = await tools.get('skill_delete_file').execute({ path: 'assets/report-template.md', summary: '去掉模板' });
  assert.match(deleted.warnings[0], /仍然提到 assets\/report-template\.md/);

  dispose();
  assert.equal(tools.size, 0);

  // 旧控制面下发的 references:[{filename}] 视为 references/<filename>
  const legacy = await apply(ctx, {
    skillId: 6,
    content: GOOD,
    references: [{ filename: 'old.md', content: '旧资料' }],
    allowedTools: ['skill_read_file'],
  });
  assert.equal((await tools.get('skill_read_file').execute({ path: 'references/old.md' })).content, '旧资料');
  legacy();

  assert.equal(validateFilePath(' assets/data.csv '), 'assets/data.csv');
  assert.deepEqual(
    checkSkillDocument(GOOD.replace('样例：', '样例见 assets/sample.md：'), ['assets/sample.md']).warnings,
    [],
  );
  assert.deepEqual(checkSkillDocument(`${GOOD}\n参考 scripts/run.py`).warnings, [
    'SKILL.md 提到了 scripts/run.py，但文件不存在：用 skill_write_file 创建，或删掉这处引用',
  ]);

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

  process.stderr.write('PASS isolated Skill authoring tools, file read/write/delete with limits, reference checks, guide whitelist, aligned validation, unsaved invalid drafts, and disposal\n');
} finally {
  process.stdout.write = originalWrite;
}
