#!/usr/bin/env node
/**
 * 执行日志与 dsh 事件翻译的单元检查（不启动 dsh）：
 * - 执行日志：编号、流式增量不落盘、回执压缩、重启后编号不复用、半行容错、条数上限；
 * - 事件翻译：dsh 通知 → Forge 事件（工具调用 / 结果 / 消息 / 用量 / 失败原因）。
 */
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { EventJournal } = await import('../src/kernel/journal.ts');
const { translateNotification, approvalReply, SESSION_EVENT } = await import('../src/kernel/dsh/protocol.ts');

const dir = await mkdtemp(join(tmpdir(), 'forge-journal-'));
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log('PASS', name);
};
try {
  const root = join(dir, 'a');
  const journal = EventJournal.open(root);
  const first = journal.append('message', { text: 'hi' }, 'llm');
  const delta = journal.append('message_delta', { text: 'h' }, 'llm');
  const second = journal.append('done', { status: 'idle' }, 'system');
  check('durable events are numbered from 1; deltas reuse the current seq and are not stored', () => {
    assert.equal(first.seq, 1);
    assert.equal(delta.seq, 1);
    assert.equal(delta.transient, true);
    assert.equal(first.transient, undefined);
    assert.equal(second.seq, 2);
    assert.deepEqual(journal.after(0).map((event) => event.kind), ['message', 'done']);
    assert.equal(readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n').length, 2);
  });
  check('after(seq) returns only later events', () => {
    assert.deepEqual(journal.after(1).map((event) => event.seq), [2]);
    assert.deepEqual(journal.after(2), []);
  });
  // 进程在写一行中途退出
  appendFileSync(join(root, 'events.jsonl'), '{"seq":3,"kind":"mess');
  const reopened = EventJournal.open(root);
  check('reopening keeps seq and ignores a half-written trailing line', () => {
    assert.equal(reopened.lastSeq, 2);
    assert.deepEqual(reopened.after(0).map((event) => event.seq), [1, 2]);
    assert.equal(reopened.append('message', {}, 'llm').seq, 3);
    // 修复后追加的事件独占一行，再次打开仍然完整
    assert.deepEqual(EventJournal.open(root).after(0).map((event) => event.seq), [1, 2, 3]);
  });
  reopened.ack(3);
  check('acking everything empties the log but the next seq never reuses old numbers', () => {
    assert.deepEqual(reopened.after(0), []);
    assert.equal(readFileSync(join(root, 'events.jsonl'), 'utf8'), '');
    const again = EventJournal.open(root);
    assert.equal(again.lastSeq, 3);
    assert.equal(again.append('message', {}, 'llm').seq, 4);
  });
  check('ack never moves past the last seq and never moves backwards', () => {
    const j = EventJournal.open(join(dir, 'b'));
    j.append('message', {}, 'llm');
    j.append('message', {}, 'llm');
    j.ack(99);
    assert.equal(j.append('message', {}, 'llm').seq, 3);
    j.ack(1);
    assert.deepEqual(j.after(0).map((event) => event.seq), [3]);
  });
  check('a missing journal reports as absent', () => {
    assert.equal(EventJournal.exists(join(dir, 'missing')), false);
    assert.equal(EventJournal.exists(root), true);
  });

  const calls = new Map();
  const event = (type, data) => translateNotification(SESSION_EVENT, { event: { type, data } }, calls);
  const call = event('tool/call', { callId: 'c1', name: 'bash', arguments: { command: 'ls' } });
  const result = event('tool/result', {
    message: { toolCallId: 'c1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
  });
  check('tool call and result translate to Forge tool events, result carries the tool name', () => {
    assert.equal(call[0].kind, 'trajectory');
    assert.deepEqual(call[1], {
      kind: 'tool_use_start',
      payload: { toolCallId: 'c1', tool: 'bash', arguments: { command: 'ls' } },
      source: 'tools',
    });
    assert.deepEqual(result[1].payload, {
      toolCallId: 'c1',
      tool: 'bash',
      arguments: { command: 'ls' },
      result: 'a\nb',
      isError: false,
    });
  });
  const message = event('assistant/message', {
    message: {
      id: 'm1',
      content: [
        { type: 'reasoning', text: 'r' },
        { type: 'text', text: 't' },
      ],
    },
    usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: 3, reasoningTokens: 2 },
  });
  check('assistant message yields message + cost_tick (cached input counted once)', () => {
    assert.deepEqual(message[1].payload, { text: 't', reasoning: 'r', runtimeMessageId: 'm1', partial: false });
    assert.deepEqual(message[2].payload, { tokensIn: 15, tokensOut: 3, reasoningTokens: 2 });
  });
  check('failed turn reasons become failures; completed turns do not', () => {
    assert.deepEqual(event('turn/end', { reason: { kind: 'completed' } }).slice(1), []);
    assert.deepEqual(event('turn/end', { reason: { kind: 'error', error: { message: 'boom' } } })[1], {
      failure: 'boom',
    });
    assert.match(event('turn/end', { reason: { kind: 'max-tokens' } })[1].failure, /单次输出上限/);
  });
  check('plugin notifications map to Forge events; gateway errors are explicit failures', () => {
    assert.deepEqual(translateNotification('forge.delta', { text: 'x' }, calls), [
      { kind: 'message_delta', payload: { text: 'x' }, source: 'llm' },
    ]);
    assert.deepEqual(translateNotification('forge.error', { message: 'bad' }, calls), [
      { failure: 'bad', explicit: true },
    ]);
    assert.deepEqual(translateNotification('unknown.method', {}, calls), []);
  });
  check('approval outcomes map to dsh replies', () => {
    assert.deepEqual(approvalReply('approve'), { outcome: 'allowed-once' });
    assert.deepEqual(approvalReply('deny'), { outcome: 'rejected' });
    assert.deepEqual(approvalReply('timeout'), { outcome: 'rejected' });
    assert.deepEqual(approvalReply('cancelled'), { outcome: 'cancelled' });
  });
  console.log(`journal OK (${passed} checks)`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
