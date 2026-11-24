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
const tool = (id, callId, name = 'read') => ({
  id,
  role: 'tool',
  content: '{"ok":true}',
  meta: { toolCallId: callId, tool: name, arguments: { path: 'a.txt' }, isError: false },
});
try {
  const { buildTurns, latestUnavailable, processStats, processSummary, toolArgSummary } =
    await vite.ssrLoadModule('/src/utils/conversation/turns.ts');

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
      [user(1), tool(2, 'c1'), tool(3, 'c2', 'write'), assistant(4, '中间说明'), tool(5, 'c3')],
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
      activeTools: [{ id: 'c2', tool: 'write', pending: true }],
    });
    assert.equal(turns.length, 2);
    assert.equal(turns[1].running, true);
    // 同一次请求里正文先于工具调用；思考与正文会断开工具分组
    assert.deepEqual(
      turns[1].steps.map((s) => s.kind),
      ['tools', 'thinking', 'text', 'tools'],
    );
    assert.equal(turns[1].steps[3].calls[0].pending, true);
    // 思考一旦开始输出正文/调工具即结束；已转入工具调用的正文也不再流式
    assert.equal(turns[1].steps[1].live, false);
    assert.equal(turns[1].steps[2].live, false);
    // 运行中已显示的正文留在原位（answer），不被收进过程块；过程块只含思考与工具
    assert.deepEqual(
      turns[1].answer.map((s) => [s.text, s.live]),
      [['部分回答', false]],
    );
    assert.deepEqual(
      turns[1].process.map((s) => s.kind),
      ['tools', 'thinking', 'tools'],
    );
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
      activeTools: [{ id: 'c1', tool: 'read', pending: true }],
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
      activeTools: [{ id: 'c2', tool: 'write', pending: true }],
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

  check('切换模型后，用户消息上的模型优先于回复（执行中也能显示）', () => {
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
      turns.map((turn) => turn.model),
      ['Chat', 'Reasoner'],
    );
    // 消息流里不再渲染模型切换分隔条
    assert.equal('switch' in turns[1], false);
  });
  check(
    'present 结果成为本轮交付物（旧会话的 workspace_present 同样识别）；失败调用与其他轮不受影响，同路径以后声明为准',
    () => {
      const present = (id, callId, files, isError = false, name = 'present') => ({
        id,
        role: 'tool',
        content: isError ? '文件不存在' : JSON.stringify({ files }),
        meta: { toolCallId: callId, tool: name, arguments: { files }, isError },
      });
      const turns = buildTurns(
        [
          user(1),
          present(2, 'p1', [{ path: 'report.md', bytes: 10 }]),
          present(3, 'p2', [{ path: 'missing.md', bytes: 0 }], true),
          present(
            4,
            'p3',
            [
              { path: 'chart.png', bytes: 20 },
              { path: 'report.md', bytes: 12, description: '终版' },
            ],
            false,
            'workspace_present',
          ),
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
    },
  );

  check('多次模型请求的思考、工具与中间说明合成一个过程块，最终回答单独显示', () => {
    // 截图场景：思考 → 说明 → 列文件 → 思考 → 写入 → 思考 → 写入 → 思考 → 最终回答
    const turns = buildTurns(
      [
        user(1),
        assistant(2, '我先查看工作区状态', { reasoning: '想一想' }),
        tool(3, 'c1', 'glob'),
        assistant(4, '', { reasoning: '第一批' }),
        tool(5, 'c2', 'write'),
        assistant(6, '', { reasoning: '第二批' }),
        tool(7, 'c3', 'write'),
        assistant(8, '已生成全部文件', { reasoning: '收尾' }),
      ],
      idle,
    );
    const [turn] = turns;
    assert.deepEqual(
      turn.process.map((s) => s.kind),
      ['thinking', 'text', 'tools', 'thinking', 'tools', 'thinking', 'tools', 'thinking'],
    );
    assert.deepEqual(
      turn.answer.map((s) => s.text),
      ['已生成全部文件'],
    );
    const stats = processStats(turn.process);
    assert.equal(stats.calls, 3);
    assert.equal(processSummary(stats), '已思考 · 调用 3 个工具');
  });

  check('没有工具调用时：思考进过程块，正文全部是最终回答', () => {
    const [turn] = buildTurns([user(1), assistant(2, '回答', { reasoning: '先想想' })], idle);
    assert.deepEqual(
      turn.process.map((s) => s.kind),
      ['thinking'],
    );
    assert.deepEqual(
      turn.answer.map((s) => s.text),
      ['回答'],
    );
    assert.equal(processSummary(processStats(turn.process)), '已思考');
    const [plain] = buildTurns([user(1), assistant(2, '直接回答')], idle);
    assert.equal(plain.process.length, 0);
  });

  check('运行中：正文之后又开始调工具，正文仍原位显示；最终回答流式时在过程块之后', () => {
    const narrating = buildTurns([user(1)], {
      running: true,
      reasoning: '想',
      text: '我先看看',
      activeTools: [{ id: 'c1', tool: 'glob', pending: true }],
    })[0];
    assert.deepEqual(
      narrating.answer.map((s) => s.text),
      ['我先看看'],
    );
    const stats = processStats(narrating.process);
    assert.equal(stats.pending.length, 1);
    const answering = buildTurns([user(1), tool(2, 'c1')], {
      running: true,
      reasoning: '收尾',
      text: '结论是',
      activeTools: [],
    })[0];
    assert.deepEqual(
      answering.process.map((s) => s.kind),
      ['tools', 'thinking'],
    );
    assert.equal(answering.answer[0].live, true);
  });

  check('运行中显示过的中间说明不会消失；轮次结束后才整理进过程块，只留最终回答', () => {
    const history = [user(1), assistant(2, '我先看看文件'), tool(3, 'c1')];
    // 说明之后开始调第二个工具：说明仍在 answer 里显示
    const running = buildTurns(history, {
      running: true,
      reasoning: '',
      text: '',
      activeTools: [{ id: 'c2', tool: 'read', pending: true }],
    })[0];
    assert.deepEqual(
      running.answer.map((s) => s.text),
      ['我先看看文件'],
    );
    assert.deepEqual(
      running.process.map((s) => s.kind),
      ['tools'],
    );
    // 最终回答流式输出时排在说明之后，两段都可见
    const answering = buildTurns(history, {
      running: true,
      reasoning: '',
      text: '结论是',
      activeTools: [],
    })[0];
    assert.deepEqual(
      answering.answer.map((s) => [s.text, s.live]),
      [
        ['我先看看文件', false],
        ['结论是', true],
      ],
    );
    // 结束后：说明收进过程块，answer 只剩最终回答
    const [done] = buildTurns([...history, assistant(4, '结论是 42')], idle);
    assert.deepEqual(
      done.process.map((s) => s.kind),
      ['text', 'tools'],
    );
    assert.deepEqual(
      done.answer.map((s) => s.text),
      ['结论是 42'],
    );
  });

  check('工具参数摘要：路径、文件、说明、命令依次优先，过长截断', () => {
    assert.equal(toolArgSummary({ path: 'src/a.ts', command: 'ls' }), 'src/a.ts');
    assert.equal(toolArgSummary({ files: [{ path: 'a' }, { path: 'b' }] }), 'a、b');
    assert.equal(toolArgSummary({ content: '正文', summary: '补全步骤' }), '补全步骤');
    assert.equal(toolArgSummary({ command: '  curl https://x  ' }), 'curl https://x');
    assert.equal(toolArgSummary({ command: 'x'.repeat(60) }, 10), 'xxxxxxxxxx…');
    assert.equal(toolArgSummary({ n: 1 }), '{"n":1}');
    assert.equal(toolArgSummary(null), '');
  });

  check('过程摘要统计失败的调用', () => {
    const failed = { ...tool(3, 'c2'), meta: { ...tool(3, 'c2').meta, isError: true } };
    const [turn] = buildTurns([user(1), tool(2, 'c1'), failed, assistant(4, '完成')], idle);
    assert.equal(processSummary(processStats(turn.process)), '调用 2 个工具 · 1 个失败');
  });

  check('latestUnavailable：只取最后一条用户消息记录的未生效扩展能力', () => {
    const withCaps = (id, unavailable) => ({
      id,
      role: 'user',
      content: '任务',
      meta: { capabilities: { skills: [], mcp: [], web: null, unavailable } },
    });
    const jira = { kind: 'mcp', id: 3, title: 'Jira' };
    const web = { kind: 'web', id: null, title: '联网搜索' };
    assert.deepEqual(latestUnavailable([]), []);
    assert.deepEqual(latestUnavailable([{ user: user(1) }]), []);
    // 早先的未生效项已恢复：以最后一轮为准
    assert.deepEqual(latestUnavailable([{ user: withCaps(1, [jira]) }, { user: withCaps(2, []) }]), []);
    assert.deepEqual(
      latestUnavailable([{ user: withCaps(1, []) }, { user: withCaps(2, [jira, web]) }, { user: null }]),
      [jira, web],
    );
    // 格式异常的条目被忽略
    assert.deepEqual(latestUnavailable([{ user: withCaps(1, [null, { kind: 'other' }, jira]) }]), [jira]);
  });
} finally {
  await vite.close();
}
console.log(JSON.stringify({ result: 'passed', checks: checks.length }));
