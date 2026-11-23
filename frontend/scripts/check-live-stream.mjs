#!/usr/bin/env node
/**
 * 流式展示的性能约定（真实 store，HTTP 与事件流为桩）：
 * - 打开会话只读取过程事件，底层轨迹只计数，流式片段不进入页面状态；
 * - 片段合并后再写入实时正文，其他事件到达前先写入；快照整体替换；持久事件按序号去重；
 * - 进行中的工具调用随事件维护。
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createPinia, setActivePinia } from 'pinia';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/*'] } },
});
const realFetch = globalThis.fetch;
const checks = [];
const passed = (name) => {
  checks.push(name);
  console.log('PASS live stream:', name);
};
const response = (data) =>
  new Response(JSON.stringify({ code: 0, data, message: '' }), {
    headers: { 'Content-Type': 'application/json' },
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, message) {
  for (let i = 0; i < 200; ++i) {
    if (test()) return;
    await sleep(2);
  }
  assert.fail(message);
}

let chat;
try {
  const { createLiveBuffer, isLiveDelta } = await vite.ssrLoadModule('/src/utils/conversation/liveBuffer.ts');

  {
    const applied = [];
    const buffer = createLiveBuffer((text, reasoning) => applied.push([text, reasoning]), 20);
    buffer.push('message_delta', '一');
    buffer.push('reasoning_delta', '想');
    buffer.push('message_delta', '二');
    assert.deepEqual(applied, []);
    await sleep(40);
    assert.deepEqual(applied, [['一二', '想']]);
    buffer.push('message_delta', '三');
    buffer.flush();
    assert.deepEqual(applied.at(-1), ['三', '']);
    buffer.push('message_delta', '丢弃');
    buffer.clear();
    await sleep(40);
    assert.equal(applied.length, 2);
    assert.equal(isLiveDelta('reasoning_delta'), true);
    assert.equal(isLiveDelta('message'), false);
    passed('片段在一个间隔内合并写入；flush 立即写入，clear 丢弃');
  }

  const { usePlatform } = await vite.ssrLoadModule('/src/stores/platform.ts');
  const { useConversation, PROCESS_KINDS } = await vite.ssrLoadModule('/src/stores/conversation.ts');
  setActivePinia(createPinia());
  const app = usePlatform();
  chat = useConversation();
  app.authenticated = true;
  app.user = { username: 'unit-fixture-only' };
  app.scenarios = [];

  const requests = [];
  let push = null;
  let status = 'running';
  const encoder = new TextEncoder();
  const sse = (event, id) => `${id ? `id: ${id}\n` : ''}event: kernel\ndata: ${JSON.stringify(event)}\n\n`;
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url === '/api/agent/sessions') return response({ items: [] });
    if (url === '/api/agent/sessions/21')
      return response({
        id: 21,
        scenarioId: 1,
        modelId: 7,
        status,
        lastEventSeq: 5,
        trajectoryEventCount: 3,
        messages: [{ id: 1, role: 'user', content: '问', meta: {} }],
        pendingApprovals: [],
        bundle: { meta: {} },
      });
    if (url.startsWith('/api/agent/sessions/21/trajectory')) {
      // 与后端一致：按 cursor 分页，nextCursor 为本页最后一条的序号
      const cursor = Number(new URL(url, 'http://x').searchParams.get('cursor'));
      const events = [
        { seq: 2, kind: 'session', source: 'system', payload: {} },
        {
          seq: 4,
          kind: 'tool_use_start',
          source: 'tools',
          payload: { toolCallId: 'c1', tool: 'current_time' },
        },
      ].filter((event) => event.seq > cursor);
      return response({ events, nextCursor: events.at(-1)?.seq ?? cursor });
    }
    if (url === '/api/agent/sessions/21/files') return response({ items: [] });
    if (url.startsWith('/api/agent/sessions/21/events?')) {
      const body = new ReadableStream({
        start(controller) {
          push = (text) => controller.enqueue(encoder.encode(text));
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    assert.fail(`Unexpected request: ${url}`);
  };

  await chat.open(21);
  const trajectoryUrl = requests.find((url) => url.includes('/trajectory'));
  assert.equal(
    new URL(trajectoryUrl, 'http://x').searchParams.get('kinds'),
    PROCESS_KINDS.join(','),
    '只读取过程事件',
  );
  // session 不是过程事件：不保留
  assert.deepEqual(
    chat.events.map((event) => event.kind),
    ['tool_use_start'],
  );
  assert.equal(chat.trajectoryEventCount, 3);
  assert.equal(chat.lastSeq, 5);
  assert.deepEqual(
    chat.activeTools.map((call) => call.id),
    ['c1'],
  );
  assert.equal(chat.liveText, '');
  await until(() => push, '事件流未连接');
  assert.ok(requests.some((url) => url.endsWith('/events?after=5')));
  passed('打开运行中的会话：只读取过程事件，底层轨迹只计数，从已读位置续读');

  push(
    sse({ seq: 4, kind: 'tool_use_start', source: 'tools', payload: { toolCallId: 'c1', tool: 'x' } }, 4) +
      sse({ kind: 'live_snapshot', source: 'system', payload: { text: '已', reasoning: '想' } }),
  );
  await until(() => chat.liveText === '已', '快照未写入');
  assert.equal(chat.liveReasoning, '想');
  assert.equal(chat.events.length, 1, '重复的持久事件被忽略');
  push(
    sse({ kind: 'message_delta', source: 'llm', payload: { text: '经' } }) +
      sse({ kind: 'message_delta', source: 'llm', payload: { text: '输出' } }) +
      sse({ kind: 'reasoning_delta', source: 'llm', payload: { text: '完' } }),
  );
  await sleep(5);
  assert.equal(chat.liveText, '已', '片段先合并，不逐个写入');
  await until(() => chat.liveText === '已经输出', '片段未合并写入');
  assert.equal(chat.liveReasoning, '想完');
  passed('快照整体替换实时正文；片段合并后写入；重复的持久事件被忽略');

  push(
    sse({ seq: 6, kind: 'trajectory', source: 'dsh', payload: { type: 'x' } }, 6) +
      sse({ seq: 7, kind: 'tool_result', source: 'tools', payload: { toolCallId: 'c1', result: 'ok' } }, 7) +
      sse({ kind: 'message_delta', source: 'llm', payload: { text: '。' } }) +
      sse(
        {
          seq: 8,
          kind: 'message',
          source: 'llm',
          payload: { text: '已经输出。', runtimeMessageId: 'm1' },
        },
        8,
      ),
  );
  await until(() => chat.lastSeq === 8, '持久事件未处理');
  assert.equal(chat.trajectoryEventCount, 4);
  assert.deepEqual(
    chat.events.map((event) => event.kind),
    ['tool_use_start', 'tool_result', 'message'],
  );
  assert.deepEqual(chat.activeTools, []);
  assert.equal(chat.messages.at(-1).content, '已经输出。');
  assert.equal(chat.liveText, '', '回复结算前先写入片段，结算后清空');
  assert.equal(chat.liveReasoning, '');
  passed('回复结算前先写入已攒下的片段；工具结果移出进行中；底层轨迹只计数');

  push(sse({ kind: 'message_delta', source: 'llm', payload: { text: '未写入' } }));
  await sleep(5);
  status = 'idle';
  push(sse({ seq: 9, kind: 'done', source: 'system', payload: { status: 'idle' } }, 9));
  push('event: settled\ndata: {}\n\n');
  await until(() => chat.current.status === 'idle', '结算未回读会话');
  assert.equal(chat.liveText, '');
  passed('回合结束：回读会话，实时正文清空');

  console.log(JSON.stringify({ result: 'passed', checks: checks.length }));
} finally {
  chat?.clear();
  globalThis.fetch = realFetch;
  await vite.close();
}
