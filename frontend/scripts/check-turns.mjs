#!/usr/bin/env node
/** buildTurns 聚合逻辑单元检查：纯函数、无网络。一轮 = 一条用户消息 + 一个 AI 块。 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/*'] } },
});
const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
  console.log('PASS', name);
};
const idle = { running: false, reasoning: '', text: '', activeTools: [] };
const user = (id, content = '任务') => ({ id, role: 'user', content, meta: {} });
const assistant = (id, content, meta = {}) => ({ id, role: 'assistant', content, meta });
const tool = (id, callId, name = 'workspace_read') => ({
  id,
  role: 'tool',
  content: '{"ok":true}',
  meta: { toolCallId: callId, tool: name, arguments: { path: 'a.txt' }, isError: false },
});
try {
  const { buildTurns } = await vite.ssrLoadModule('/src/utils/turns.ts');

  check('一轮 = 用户消息 + 一个 AI 块；思考与正文是同一块内的步骤', () => {
    const turns = buildTurns([user(1), assistant(2, '回答', { reasoning: '先想想' })], idle);
    assert.equal(turns.length, 1);
    assert.deepEqual(
      turns[0].steps.map((s) => s.kind),
      ['thinking', 'text'],
    );
    assert.equal(turns[0].steps[0].text, '先想想');
    assert.equal(turns[0].steps[1].text, '回答');
  });

  check('连续工具调用并入一组；正文会断开分组', () => {
    const turns = buildTurns(
      [user(1), tool(2, 'c1'), tool(3, 'c2', 'workspace_write'), assistant(4, '中间说明'), tool(5, 'c3')],
      idle,
    );
    assert.deepEqual(
      turns[0].steps.map((s) => s.kind),
      ['tools', 'text', 'tools'],
    );
    assert.equal(turns[0].steps[0].calls.length, 2);
    assert.equal(turns[0].steps[2].calls.length, 1);
  });

  check('只思考未出正文的步骤保留为思考步骤', () => {
    const turns = buildTurns([user(1), assistant(2, '', { reasoning: '推理中' }), tool(3, 'c1')], idle);
    assert.deepEqual(
      turns[0].steps.map((s) => s.kind),
      ['thinking', 'tools'],
    );
  });

  check('运行中的思考/工具/正文流式并入最后一轮同一个 AI 块', () => {
    const turns = buildTurns([user(1), assistant(2, '已完成', {}), user(3), tool(4, 'c1')], {
      running: true,
      reasoning: '又在想',
      text: '部分回答',
      activeTools: [{ id: 'c2', tool: 'workspace_write', pending: true }],
    });
    assert.equal(turns.length, 2);
    assert.equal(turns[1].running, true);
    // 思考步骤会断开工具分组：新一轮思考后的调用是新的连续组
    assert.deepEqual(
      turns[1].steps.map((s) => s.kind),
      ['tools', 'thinking', 'tools', 'text'],
    );
    assert.equal(turns[1].steps[2].calls[0].pending, true);
    // 思考一旦开始输出正文/调工具即结束：不再是 live（前端折叠成「已思考」）
    assert.equal(turns[1].steps[1].live, false);
    assert.equal(turns[1].steps[3].live, true);
  });

  check('只在推理流式时思考保持 live；开始调工具或出正文即视为思考结束', () => {
    const thinkingOnly = buildTurns([user(1)], {
      running: true,
      reasoning: '推理中',
      text: '',
      activeTools: [],
    });
    assert.equal(thinkingOnly[0].steps[0].live, true);
    const toolStarted = buildTurns([user(1)], {
      running: true,
      reasoning: '推理中',
      text: '',
      activeTools: [{ id: 'c1', tool: 'workspace_read', pending: true }],
    });
    assert.equal(toolStarted[0].steps[0].live, false);
    assert.deepEqual(
      toolStarted[0].steps.map((s) => s.kind),
      ['thinking', 'tools'],
    );
  });

  check('进行中的调用并入紧邻的连续工具组', () => {
    const turns = buildTurns([user(1), tool(2, 'c1')], {
      running: true,
      reasoning: '',
      text: '',
      activeTools: [{ id: 'c2', tool: 'workspace_write', pending: true }],
    });
    assert.equal(turns[0].steps.length, 1);
    assert.deepEqual(
      turns[0].steps[0].calls.map((c) => c.id),
      ['c1', 'c2'],
    );
    // 非运行态不叠加 live 内容
    const settled = buildTurns([user(1)], { ...idle, text: '不应出现' });
    assert.equal(settled[0].steps.length, 0);
  });

  check('每轮记录生成回复的模型显示名，旧消息回退为模型 ID，未记录时为空', () => {
    const turns = buildTurns(
      [
        user(1),
        assistant(2, '回答', { model: 'deepseek-chat', modelName: '企业 Chat' }),
        user(3),
        assistant(4, '旧回答', { model: 'deepseek-chat' }),
        user(5),
        assistant(6, '更早', {}),
      ],
      idle,
    );
    assert.deepEqual(
      turns.map((turn) => turn.model),
      ['企业 Chat', 'deepseek-chat', ''],
    );
  });

  check('切换轮带切换标记，用户消息上的模型优先于回复（执行中也能显示）', () => {
    const switched = {
      modelName: 'Reasoner',
      model: 'reasoner-v1',
      modelSwitch: {
        from: { name: 'Chat', model: 'chat-v1' },
        to: { name: 'Reasoner', model: 'reasoner-v1' },
      },
    };
    const turns = buildTurns(
      [
        { ...user(1), meta: { modelName: 'Chat' } },
        assistant(2, '回答', { modelName: 'Chat' }),
        { ...user(3), meta: switched },
      ],
      { running: true, reasoning: '', text: '流式中', activeTools: [] },
    );
    assert.deepEqual(
      turns.map((turn) => [turn.model, turn.switch]),
      [
        ['Chat', null],
        ['Reasoner', { from: 'Chat', to: 'Reasoner' }],
      ],
    );
  });
  check('workspace_present 结果成为本轮交付物；失败调用与其他轮不受影响，同路径以后声明为准', () => {
    const present = (id, callId, files, isError = false) => ({
      id,
      role: 'tool',
      content: isError ? '文件不存在' : JSON.stringify({ files }),
      meta: { toolCallId: callId, tool: 'workspace_present', arguments: { files }, isError },
    });
    const turns = buildTurns(
      [
        user(1),
        present(2, 'p1', [{ path: 'report.md', bytes: 10 }]),
        present(3, 'p2', [{ path: 'missing.md', bytes: 0 }], true),
        present(4, 'p3', [
          { path: 'chart.png', bytes: 20 },
          { path: 'report.md', bytes: 12, description: '终版' },
        ]),
        assistant(5, '已完成'),
        user(6),
        assistant(7, '无文件'),
      ],
      idle,
    );
    assert.deepEqual(turns[0].deliverables, [
      { path: 'report.md', bytes: 12, description: '终版' },
      { path: 'chart.png', bytes: 20 },
    ]);
    assert.deepEqual(turns[1].deliverables, []);
    // 交付声明仍作为一次工具调用保留在过程步骤里
    assert.equal(turns[0].steps[0].calls.length, 3);
  });
} finally {
  await vite.close();
}
console.log(JSON.stringify({ result: 'passed', checks: checks.length }));
