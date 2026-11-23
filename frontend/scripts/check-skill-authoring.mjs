/** Skill 编写助手的对话过程：落库消息转换、流式事件处理与按轮聚合（与工作台一致）。纯函数、无网络。 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/*'] } },
});
try {
  const authoring = await vite.ssrLoadModule('/src/utils/skill/authoring.ts');
  const { buildTurns } = await vite.ssrLoadModule('/src/utils/conversation/turns.ts');
  const { builtinToolTitle } = await vite.ssrLoadModule('/src/utils/conversation/toolTitles.ts');
  const idle = (live) => authoring.authoringLiveTurn(live ?? authoring.emptyAuthoringLive(), false);

  // 1. 刷新后从落库消息还原：思考 + 工具调用归入过程块，最后一次调用之后的正文为最终回答
  const stored = [
    { id: 1, role: 'user', content: '补全步骤' },
    { id: 2, role: 'assistant', content: '', meta: { reasoning: '先读草稿' } },
    {
      id: 3,
      role: 'tool',
      content: '# 周报',
      meta: { toolCallId: 'c1', tool: 'skill_read_draft', arguments: {}, isError: false },
    },
    { id: 4, role: 'assistant', content: '已补全。', meta: {} },
    { id: 5, role: 'system', content: '忽略' },
  ];
  const [turn] = buildTurns(authoring.authoringChatMessages(stored), idle());
  assert.deepEqual(
    turn.process.map((step) => step.kind),
    ['thinking', 'tools'],
  );
  assert.equal(turn.process[1].calls[0].tool, 'skill_read_draft');
  assert.deepEqual(
    turn.answer.map((step) => step.text),
    ['已补全。'],
  );

  // 2. 旧版本的「草稿已更新」记录显示为一次更新草稿调用，后面的整段回复仍是最终回答
  const legacy = authoring.authoringChatMessages([
    { id: 1, role: 'user', content: '改一下' },
    {
      id: 2,
      role: 'tool',
      content: '草稿已更新：补充输出样例',
      meta: { revisionId: 9, kind: 'skill_revision' },
    },
    { id: 3, role: 'assistant', content: '改好了', meta: {} },
  ]);
  const [legacyTurn] = buildTurns(legacy, idle());
  const legacyCall = legacyTurn.process[0].calls[0];
  assert.equal(builtinToolTitle(legacyCall.tool), '更新草稿');
  assert.deepEqual(legacyCall.arguments, { summary: '补充输出样例' });
  assert.equal(legacyTurn.answer[0].text, '改好了');
  assert.equal(builtinToolTitle('skill_update_draft'), '更新 SKILL.md');

  // 3. 流式事件：结算回复与工具结果追加为消息，进行中的调用与正文留在实时状态
  const live = authoring.emptyAuthoringLive();
  const messages = [{ id: 'p', role: 'user', content: '补全' }];
  let seq = 0;
  const nextId = () => `p-${++seq}`;
  const apply = (kind, payload) => authoring.applyAuthoringEvent(live, messages, { kind, payload }, nextId);
  const longDraft = '正文'.repeat(2000);
  assert.equal(apply('reasoning_delta', { text: '先读' }), true);
  apply('reasoning_delta', { text: '草稿' });
  let [running] = buildTurns(
    authoring.authoringChatMessages(messages),
    authoring.authoringLiveTurn(live, true),
  );
  assert.deepEqual(running.process[0], { kind: 'thinking', text: '先读草稿', live: true });
  apply('message', { text: '', reasoning: '先读草稿', runtimeMessageId: 'm1' });
  assert.equal(live.reasoning, '');
  apply('tool_use_start', {
    toolCallId: 'c2',
    tool: 'skill_update_draft',
    arguments: { content: longDraft, summary: '补全' },
  });
  [running] = buildTurns(authoring.authoringChatMessages(messages), authoring.authoringLiveTurn(live, true));
  const pending = running.process.at(-1).calls[0];
  assert.equal(pending.pending, true);
  assert.equal(pending.arguments.content, `（${longDraft.length} 字，内容见对应修订）`);
  assert.equal(pending.arguments.summary, '补全');
  apply('tool_result', {
    toolCallId: 'c2',
    tool: 'skill_update_draft',
    arguments: { content: longDraft, summary: '补全' },
    result: '{"saved":true}',
  });
  apply('tool_result', { toolCallId: 'c2', tool: 'skill_update_draft', result: '重复' });
  assert.equal(live.tools.length, 0);
  assert.equal(messages.filter((message) => message.role === 'tool').length, 1);
  apply('message_delta', { text: '已补' });
  [running] = buildTurns(authoring.authoringChatMessages(messages), authoring.authoringLiveTurn(live, true));
  assert.deepEqual(
    running.answer.map((step) => [step.text, step.live]),
    [['已补', true]],
  );
  apply('message', { text: '已补全。', runtimeMessageId: 'm2' });
  assert.equal(apply('queued', { position: 1 }), false);
  assert.deepEqual(
    messages.map((message) => [message.id, message.role, message.content]),
    [
      ['p', 'user', '补全'],
      ['p-1', 'assistant', ''],
      ['p-2', 'tool', '{"saved":true}'],
      ['p-3', 'assistant', '已补全。'],
    ],
  );
  const [done] = buildTurns(authoring.authoringChatMessages(messages), idle(live));
  assert.deepEqual(
    done.process.map((step) => step.kind),
    ['thinking', 'tools'],
  );
  assert.equal(done.answer[0].text, '已补全。');
  console.log('PASS Skill 编写助手：落库消息还原、旧记录兼容、流式过程事件');
} finally {
  await vite.close();
}
