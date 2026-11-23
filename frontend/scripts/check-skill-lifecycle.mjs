/** Skill 上线与下线：状态判断、能否删除、下线与删除提示里的场景名单。 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
});
try {
  const lifecycle = await vite.ssrLoadModule('/src/utils/skill/lifecycle.ts');
  const skill = (status, publishedRevisionId, offline) => ({ status, publishedRevisionId, offline });

  // 四种状态：草稿、已发布、已发布后又有修改、已下线
  assert.equal(lifecycle.skillState(skill('draft', null, false)), 'draft');
  assert.equal(lifecycle.skillState(skill('published', 3, false)), 'published');
  assert.equal(lifecycle.skillState(skill('draft', 3, false)), 'changed');
  assert.equal(lifecycle.skillState(skill('draft', null, true)), 'offline');
  // 旧后端没有 offline 字段：按草稿处理
  assert.equal(lifecycle.skillState({ status: 'draft', publishedRevisionId: null }), 'draft');
  assert.equal(lifecycle.SKILL_STATE_LABELS.offline, '已下线');

  // 只要还在线上就不能删；草稿与已下线可以
  assert.equal(lifecycle.canDeleteSkill(skill('published', 3, false)), false);
  assert.equal(lifecycle.canDeleteSkill(skill('draft', 3, false)), false);
  assert.equal(lifecycle.canDeleteSkill(skill('draft', null, true)), true);
  assert.equal(lifecycle.canDeleteSkill(skill('draft', null, false)), true);

  // 下线提示：有场景在用时列出名称；没有时说明聊天里的影响
  const scenarios = [
    { id: 1, name: '周报', space: 'personal', published: true, draft: true },
    { id: 2, name: '客服', space: 'personal', published: false, draft: true },
  ];
  assert.match(lifecycle.unpublishNotice(scenarios), /以下场景正在使用它：「周报」、「客服」/);
  assert.match(lifecycle.unpublishNotice([]), /聊天里不能再选用/);
  assert.match(lifecycle.unpublishNotice([]), /可以重新发布/);
  assert.equal(
    lifecycle.deleteBlockedNotice(scenarios),
    '以下场景仍在使用这个技能，请先在场景中移除后再删除：「周报」、「客服」',
  );
  // 场景或会话里仍勾着、但不在可选列表里的 Skill：区分已下线与已删除
  const options = { offlineSkills: [{ id: 7, title: '周报助手' }] };
  assert.deepEqual(lifecycle.missingSkillInfo(options, 7), { title: '周报助手', reason: '已下线' });
  assert.deepEqual(lifecycle.missingSkillInfo(options, 8), { title: 'Skill #8', reason: '已删除' });
  assert.deepEqual(lifecycle.missingSkillInfo(null, 8), { title: 'Skill #8', reason: '已删除' });
  console.log('skill lifecycle checks passed');
} finally {
  await vite.close();
}
