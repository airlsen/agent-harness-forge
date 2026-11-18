#!/usr/bin/env node
/**
 * 仅用于集成测试的本机 OpenAI 协议夹具，不是真实模型，也不写入业务配置。
 * 实际启动 dsh 和正式 forge-runtime 插件，验证编解码、工具、审批与文件边界。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const dir = await mkdtemp(join(tmpdir(), 'forge-contract-'));
process.env.FORGE_RUNNER_DATA_DIR = join(dir, 'sessions');
const { DshKernel, compactionConfig } = await import('../src/kernel/dsh-kernel.ts');
const kernel = new DshKernel(),
  requests = [],
  checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
  console.log('PASS', name);
}
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const lastUser = body.messages.findLastIndex(
    (message) => message.role === 'user' && !message.content.startsWith('Current runtime context.'),
  );
  const instruction = body.messages[lastUser]?.content ?? '';
  const answeredTool = body.messages.slice(lastUser + 1).some((message) => message.role === 'tool');
  if (instruction.includes('HTTP_ERROR')) {
    res.writeHead(401);
    res.end('test fixture authorization failure');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  if (['MAX_TOKENS', 'TRUNCATED', 'FILTERED'].some((value) => instruction.includes(value))) {
    send({
      choices: [
        {
          delta: { content: 'fixture partial output' },
          ...(instruction.includes('TRUNCATED')
            ? {}
            : { finish_reason: instruction.includes('MAX_TOKENS') ? 'length' : 'content_filter' }),
        },
      ],
    });
    res.end('data: [DONE]\n\n');
    return;
  }
  if (instruction.includes('HOLD')) {
    send({ choices: [{ delta: { content: 'fixture pending' } }] });
    const timer = setTimeout(() => res.end(), 20000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (instruction.includes('THINK') && !instruction.includes('TIME')) {
    send({ choices: [{ delta: { reasoning_content: '先分析' } }] });
    send({ choices: [{ delta: { reasoning_content: '一下。' } }] });
    send({ choices: [{ delta: { content: '思考后的' } }] });
    send({
      choices: [{ delta: { content: '回答' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 12,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 7 },
      },
    });
    res.end('data: [DONE]\n\n');
    return;
  }
  if (
    (instruction.includes('WRITE') ||
      instruction.includes('ESCAPE') ||
      instruction.includes('TIME') ||
      instruction.includes('LIST') ||
      instruction.includes('READ')) &&
    !answeredTool
  ) {
    const tool = instruction.includes('TIME')
      ? 'current_time'
      : instruction.includes('LIST')
        ? 'workspace_list'
        : instruction.includes('READ')
          ? 'workspace_read'
          : 'workspace_write';
    if (instruction.includes('THINK')) send({ choices: [{ delta: { reasoning_content: '需要先查时间。' } }] });
    const path = instruction.includes('ESCAPE')
      ? '../escape.txt'
      : instruction.includes('DENY')
        ? 'denied.md'
        : 'report.md';
    const args = ['current_time', 'workspace_list'].includes(tool)
      ? '{}'
      : tool === 'workspace_read'
        ? JSON.stringify({ path: 'report.md' })
        : JSON.stringify({ path, content: '# Integration fixture\n' });
    send({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'fixture-call-' + requests.length,
                type: 'function',
                function: { name: tool, arguments: args.slice(0, 9) },
              },
            ],
          },
        },
      ],
    });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(9) } }] } }] });
    send({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } },
    });
  } else {
    send({ choices: [{ delta: { content: 'fixture ' } }] });
    send({
      choices: [{ delta: { content: answeredTool ? 'tool received' : 'response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } },
    });
  }
  res.end('data: [DONE]\n\n');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const bundle = {
  profile_patch: {
    systemPrompt: {
      identity: 'Integration contract test only.',
      domain: 'Do not contact external services.',
    },
  },
  plugin_mounts: ['forge-runtime'],
  skill_files: {},
  mcp: [],
  model_route: { primary: 'default', fallbacks: [] },
  policy_ref: 'test',
  meta: {
    builtin_tools: ['current_time', 'workspace_list', 'workspace_read', 'workspace_write'],
    policy: {
      allowedTools: ['current_time', 'workspace_list', 'workspace_read', 'workspace_write'],
      requireWriteApproval: true,
      requestTimeoutSeconds: 20,
      approvalTimeoutSeconds: 2,
      maxOutputTokens: 512,
    },
  },
};
let id,
  allEvents = [],
  approvalAction = 'approve';
try {
  const handle = await kernel.createSession(
    bundle,
    { tenantId: 'test', userId: 'test', roles: [] },
    {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'protocol-fixture-not-a-model',
      apiKey: 'test-key-do-not-use',
      contextWindow: 64000,
    },
  );
  id = handle.sessionId;
  kernel.onEvent(id, (event) => {
    allEvents.push(event);
    if (event.kind === 'approval_required' && approvalAction !== 'wait')
      void kernel.resolveApproval(id, event.payload.ticketId, { action: approvalAction });
  });
  async function turn(text, model) {
    const start = allEvents.length;
    await kernel.sendTurn(id, text, undefined, model);
    return allEvents.slice(start);
  }
  check('compaction budget fits every common context window (dsh compaction-basic formula)', () => {
    for (const [window, output] of [
      [8192, 4096],
      [32000, 4096],
      [64000, 4096],
      [128000, 8192],
      [1000000, 8192],
    ]) {
      const { headroomTokens, maxTokens } = compactionConfig(window, output);
      const budget = window - output;
      const threshold = Math.floor(Math.min(window * 0.8, budget - headroomTokens));
      assert.ok(budget - headroomTokens > 0, `${window}: pressure budget`);
      assert.ok(Math.floor(budget * 0.16) < threshold, `${window}: retain below threshold`);
      assert.ok(maxTokens <= output && maxTokens <= headroomTokens, `${window}: summary cap`);
      assert.ok(headroomTokens <= 65536, `${window}: never above dsh default`);
    }
  });
  let events = await turn('PLAIN');
  check('real dsh + formal gateway text stream', () =>
    assert.equal(events.find((event) => event.kind === 'message')?.payload.text, 'fixture response'),
  );
  check('gateway receives leading system message and correct model', () => {
    assert.equal(requests[0].model, 'protocol-fixture-not-a-model');
    assert.ok(requests[0].messages[0].content.includes('Integration contract test'));
    assert.equal(requests[0].messages[0].role, 'system');
  });
  check('token usage includes cached input exactly once', () =>
    assert.deepEqual(events.find((event) => event.kind === 'cost_tick')?.payload, {
      tokensIn: 100,
      tokensOut: 10,
    }),
  );
  check('only whitelisted schemas are exposed', () =>
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.function.name).sort(),
      bundle.meta.builtin_tools.toSorted(),
    ),
  );
  events = await turn('THINK');
  check('reasoning streams live and settles onto the message', () => {
    assert.deepEqual(
      events.filter((event) => event.kind === 'reasoning_delta').map((event) => event.payload.text),
      ['先分析', '一下。'],
    );
    const message = events.find((event) => event.kind === 'message');
    assert.equal(message?.payload.text, '思考后的回答');
    assert.equal(message?.payload.reasoning, '先分析一下。');
  });
  check('reasoning tokens ride with usage accounting', () =>
    assert.deepEqual(events.find((event) => event.kind === 'cost_tick')?.payload, {
      tokensIn: 100,
      tokensOut: 12,
      reasoningTokens: 7,
    }),
  );
  events = await turn('PLAIN');
  check('reasoning from earlier turns is not replayed as provider history', () => {
    const assistant = requests
      .at(-1)
      .messages.find((message) => message.role === 'assistant' && message.content === '思考后的回答');
    assert.ok(assistant, 'earlier answer remains in history');
    assert.equal(assistant.reasoning_content, undefined);
  });
  events = await turn('THINK TIME');
  check('reasoning inside the current tool loop is replayed to the gateway', () => {
    assert.ok(events.some((event) => event.kind === 'tool_result'));
    const followUp = requests.at(-1).messages;
    const call = followUp.find((message) => message.role === 'assistant' && message.tool_calls?.length);
    assert.equal(call?.reasoning_content, '需要先查时间。');
  });
  events = await turn('WRITE');
  check('fragmented tool arguments and approval round trip', () => {
    assert.ok(events.some((event) => event.kind === 'approval_required'));
    assert.equal(events.find((event) => event.kind === 'tool_result')?.payload.isError, false);
    assert.ok(
      events.some((event) => event.kind === 'message' && event.payload.text === 'fixture tool received'),
    );
  });
  check('actual artifact written', () => assert.ok(events.some((event) => event.kind === 'files')));
  assert.equal(await kernel.readFile(id, 'report.md'), '# Integration fixture\n');
  events = await turn('TIME');
  check('current_time executor returns an actual ISO time', () =>
    assert.ok(JSON.parse(events.find((event) => event.kind === 'tool_result').payload.result).iso),
  );
  events = await turn('LIST');
  check('workspace_list executor returns actual artifact metadata', () =>
    assert.equal(
      JSON.parse(events.find((event) => event.kind === 'tool_result').payload.result).files[0].path,
      'report.md',
    ),
  );
  events = await turn('READ');
  check('workspace_read executor returns actual file content', () =>
    assert.equal(
      JSON.parse(events.find((event) => event.kind === 'tool_result').payload.result).content,
      '# Integration fixture\n',
    ),
  );
  approvalAction = 'deny';
  events = await turn('WRITE DENY');
  check('denied approval never writes a file', () =>
    assert.equal(events.find((event) => event.kind === 'tool_result')?.payload.isError, true),
  );
  assert.equal(
    (await kernel.listFiles(id)).some((file) => file.path === 'denied.md'),
    false,
  );
  approvalAction = 'approve';
  events = await turn('ESCAPE');
  check('path traversal rejected by actual tool executor', () =>
    assert.equal(events.find((event) => event.kind === 'tool_result')?.payload.isError, true),
  );
  await assert.rejects(() => kernel.readFile(id, '../runtime.patch.json'));
  const sentinel = join(dir, 'sentinel.txt');
  await writeFile(sentinel, 'protected');
  await symlink(sentinel, join(dir, 'sessions', id, 'workspace', 'link.txt'));
  await assert.rejects(() => kernel.readFile(id, 'link.txt'));
  check('Runner artifact reader also rejects traversal and symlinks', () => assert.ok(true));
  approvalAction = 'wait';
  events = await turn('WRITE DENY');
  check('approval timeout defaults to rejection', () => {
    assert.ok(
      events.some((event) => event.kind === 'approval_resolved' && event.payload.action === 'timeout'),
    );
    assert.equal(events.find((event) => event.kind === 'tool_result')?.payload.isError, true);
  });
  events = await turn('HTTP_ERROR');
  check('gateway HTTP failure produces error, not success', () => {
    assert.ok(events.some((event) => event.kind === 'error'));
    assert.equal(events.at(-1)?.payload.status, 'error');
  });
  for (const [instruction, expected] of [
    ['MAX_TOKENS', /输出达到长度上限/],
    ['TRUNCATED', /响应流提前结束/],
    ['FILTERED', /被拦截/],
  ]) {
    events = await turn(instruction);
    check(`${instruction} retains partial text and never reports success`, () => {
      assert.ok(
        events.some(
          (event) => event.kind === 'message_delta' && event.payload.text === 'fixture partial output',
        ),
      );
      assert.ok(events.some((event) => event.kind === 'error' && expected.test(event.payload.message)));
      assert.equal(events.at(-1)?.payload.status, 'error');
    });
  }
  const switched = {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'switched-fixture-model',
    apiKey: 'second-test-key',
    contextWindow: 32000,
  };
  await assert.rejects(
    () => kernel.sendTurn(id, 'PLAIN', undefined, { model: 'missing-base-url' }),
    (error) => error.statusCode === 422,
  );
  assert.equal(kernel.isBusy(id), false);
  const beforeSwitch = requests.length;
  events = await turn('PLAIN', switched);
  check('mid-session model switch restarts with the new model and resumes the same history', () => {
    assert.ok(events.some((event) => event.kind === 'message'));
    const request = requests[beforeSwitch];
    assert.equal(request.model, 'switched-fixture-model');
    assert.ok(request.messages.some((message) => message.role === 'user' && message.content === 'THINK'));
  });
  events = await turn('PLAIN');
  check('the switched model stays in effect for later turns', () =>
    assert.equal(requests.at(-1).model, 'switched-fixture-model'),
  );
  const running = kernel.sendTurn(id, 'HOLD');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      off();
      reject(new Error('HOLD did not start'));
    }, 10000);
    const off = kernel.onEvent(id, (event) => {
      if (event.kind === 'message_delta') {
        clearTimeout(timeout);
        off();
        resolve();
      }
    });
  });
  await kernel.interrupt(id);
  await running;
  check('interruption completes and clears busy state', () => {
    assert.equal(kernel.isBusy(id), false);
    assert.equal(allEvents.at(-1)?.payload.status, 'error');
  });
  const restored = await turn('AFTER_INTERRUPT');
  check('same Runner process can reopen dsh session log after interrupt', () =>
    assert.ok(restored.some((event) => event.kind === 'message')),
  );
  await kernel.disposeSession(id);
  assert.equal(await kernel.readFile(id, 'report.md'), '# Integration fixture\n');
  const restarted = new DshKernel();
  assert.equal(await restarted.readFile(id, 'report.md'), '# Integration fixture\n');
  check('artifacts remain readable after archive and Runner reconstruction', () =>
    assert.equal(kernel.size, 0),
  );
  console.log(
    JSON.stringify({
      scope: 'test-only protocol fixture; NOT real-model acceptance',
      checks: checks.length,
      events: allEvents.length,
      requests: requests.length,
      result: 'passed',
    }),
  );
} catch (error) {
  console.error('INTEGRATION FAILED:', error.message);
  console.error('Fixture request count:', requests.length);
  console.error(JSON.stringify(allEvents, null, 2));
  process.exitCode = 1;
} finally {
  await kernel.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
