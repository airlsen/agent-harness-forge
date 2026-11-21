#!/usr/bin/env node
/**
 * 仅用于集成测试的本机 OpenAI 协议夹具，不是真实模型，也不写入业务配置。
 * 实际启动 dsh 和正式 forge-runtime 插件，验证编解码、工具、审批与文件边界。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, stat, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const dir = await mkdtemp(join(tmpdir(), 'forge-contract-'));
process.env.FORGE_RUNNER_DATA_DIR = join(dir, 'sessions');
// 关联代码夹具：代码根目录下两个项目，alpha 带 git 元数据、密钥文件与指向外部的符号链接
const codeRoot = join(dir, 'code');
process.env.FORGE_CODE_ROOT = codeRoot;
await mkdir(join(codeRoot, 'alpha', 'src'), { recursive: true });
await mkdir(join(codeRoot, 'alpha', '.git', 'refs', 'heads'), { recursive: true });
await mkdir(join(codeRoot, 'beta', 'lib'), { recursive: true });
await writeFile(join(codeRoot, 'alpha', 'src', 'app.ts'), 'export const alphaMarker = 1;\n');
await writeFile(join(codeRoot, 'alpha', 'README.md'), '# Alpha service\n');
await writeFile(join(codeRoot, 'alpha', '.env'), 'SECRET=code-sentinel\n');
await writeFile(join(codeRoot, 'alpha', '.git', 'HEAD'), 'ref: refs/heads/main\n');
await writeFile(join(codeRoot, 'alpha', '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n');
await writeFile(join(codeRoot, 'beta', 'lib', 'beta.py'), 'BETA_MARKER = True\n');
await writeFile(join(dir, 'outside.txt'), 'outside-sentinel\n');
await symlink(join(dir, 'outside.txt'), join(codeRoot, 'alpha', 'escape.txt'));
const { DshKernel, compactionConfig, BASE_TOOLS, SEARCH_TOOLS } = await import('../src/kernel/dsh-kernel.ts');
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
  const bashCase = ['BASH_SAFE', 'BASH_WRITE'].find((value) => instruction.includes(value));
  if (bashCase && !answeredTool) {
    const command =
      bashCase === 'BASH_SAFE'
        ? 'echo bash-marker && cat report.md 2>/dev/null'
        : 'echo should-not-run > bash-denied.txt';
    send({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'fixture-call-' + requests.length,
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({ description: 'Check bash routing', command }),
                },
              },
            ],
          },
        },
      ],
    });
    send({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });
    res.end('data: [DONE]\n\n');
    return;
  }
  const code = [
    'CODE_GREP_SECRET',
    'CODE_GLOB_SECRET',
    'CODE_GREP',
    'CODE_READ_ALPHA',
    'CODE_READ_BETA',
    'CODE_SECRET',
    'CODE_ESCAPE',
  ].find((value) => instruction.includes(value));
  if (code && !answeredTool) {
    const [tool, args] = {
      CODE_GREP_SECRET: ['grep', { pattern: 'SECRET|alphaMarker', path: join(codeRoot, 'alpha') }],
      CODE_GLOB_SECRET: ['glob', { pattern: '*', path: join(codeRoot, 'alpha') }],
      CODE_GREP: ['grep', { pattern: 'alphaMarker', path: join(codeRoot, 'alpha') }],
      CODE_READ_ALPHA: ['read', { file_path: join(codeRoot, 'alpha', 'src', 'app.ts') }],
      CODE_READ_BETA: ['read', { file_path: join(codeRoot, 'beta', 'lib', 'beta.py') }],
      CODE_SECRET: ['read', { file_path: join(codeRoot, 'alpha', '.env') }],
      CODE_ESCAPE: ['read', { file_path: join(codeRoot, 'alpha', 'escape.txt') }],
    }[code];
    send({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'fixture-call-' + requests.length,
                type: 'function',
                function: { name: tool, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    });
    send({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });
    res.end('data: [DONE]\n\n');
    return;
  }
  const search = ['GREP_ESCAPE', 'GREP_LINK', 'GREP_ALL', 'GREP', 'GLOB'].find((value) =>
    instruction.includes(value),
  );
  if (search && !answeredTool) {
    const args = {
      GREP_ESCAPE: { pattern: 'protected', path: dir },
      GREP_LINK: { pattern: 'protected', path: 'link.txt' },
      GREP_ALL: { pattern: 'protected' },
      GREP: { pattern: 'Integration' },
      GLOB: { pattern: '*.md' },
    }[search];
    send({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'fixture-call-' + requests.length,
                type: 'function',
                function: { name: search === 'GLOB' ? 'glob' : 'grep', arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    });
    send({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });
    res.end('data: [DONE]\n\n');
    return;
  }
  if (
    (instruction.includes('WRITE') ||
      instruction.includes('ESCAPE') ||
      instruction.includes('TIME') ||
      instruction.includes('LIST') ||
      instruction.includes('READ') ||
      instruction.includes('PRESENT')) &&
    !answeredTool
  ) {
    const tool = instruction.includes('TIME')
      ? 'current_time'
      : instruction.includes('LIST')
        ? 'workspace_list'
        : instruction.includes('READ')
          ? 'workspace_read'
          : instruction.includes('PRESENT')
            ? 'workspace_present'
            : 'workspace_write';
    if (instruction.includes('THINK'))
      send({ choices: [{ delta: { reasoning_content: '需要先查时间。' } }] });
    const path = instruction.includes('ESCAPE')
      ? '../escape.txt'
      : instruction.includes('DENY')
        ? 'denied.md'
        : 'report.md';
    const args = ['current_time', 'workspace_list'].includes(tool)
      ? '{}'
      : tool === 'workspace_read'
        ? JSON.stringify({ path: 'report.md' })
        : tool === 'workspace_present'
          ? JSON.stringify({ files: [{ path: 'report.md', description: '集成报告' }] })
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
    // 与「通用助手」一样只声明 current_time：文件读写与搜索由 Runner 基础能力补齐
    builtin_tools: ['current_time'],
    policy: {
      allowedTools: ['current_time', 'workspace_list', 'workspace_read', 'workspace_write', 'bash'],
      // 旧版本保存的策略字段：已下线，必须被忽略（写入不再逐次确认）
      requireWriteApproval: true,
      requestTimeoutSeconds: 20,
      approvalTimeoutSeconds: 2,
      maxOutputTokens: 512,
    },
  },
};
let id,
  allEvents = [],
  // 任何意外出现的确认请求都会被拒绝，从而让写入失败、断言暴露问题
  approvalAction = 'deny';
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
  async function turn(text, model, codeProjects) {
    const start = allEvents.length;
    await kernel.sendTurn(id, text, undefined, model, codeProjects);
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
  check('base capabilities load without scenario grants (present rides on write, search on read)', () =>
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.function.name).sort(),
      [...BASE_TOOLS, 'workspace_present', ...SEARCH_TOOLS].toSorted(),
    ),
  );
  check('system prompt tells the model to save requested files with workspace_write', () => {
    const system = requests[0].messages[0].content;
    assert.ok(system.includes('必须调用 workspace_write'));
    assert.ok(system.includes('workspace_present'));
    assert.ok(system.includes('grep 按正则搜索'));
  });
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
  check('fragmented tool arguments; file writes run directly without approval', () => {
    assert.equal(
      events.some((event) => event.kind === 'approval_required'),
      false,
    );
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
  events = await turn('PRESENT');
  check('present is enabled with workspace_write and declares deliverables without approval', () => {
    assert.equal(
      events.some((event) => event.kind === 'approval_required'),
      false,
    );
    const result = events.find((event) => event.kind === 'tool_result');
    assert.equal(result?.payload.isError, false);
    assert.deepEqual(JSON.parse(result.payload.result).files, [
      { path: 'report.md', bytes: 22, description: '集成报告' },
    ]);
    assert.deepEqual(events.find((event) => event.kind === 'deliverables')?.payload.files, [
      { path: 'report.md', bytes: 22, description: '集成报告' },
    ]);
  });
  const listed = (await kernel.listFiles(id)).find((file) => file.path === 'report.md');
  const raw = await kernel.readRaw(id, 'report.md');
  check('Runner lists MIME/mtime and serves exact raw bytes', () => {
    assert.equal(listed.sha256, createHash('sha256').update('# Integration fixture\n').digest('hex'));
    assert.equal(listed.mime, 'text/markdown');
    assert.ok(!Number.isNaN(Date.parse(listed.modifiedAt)));
    assert.equal(raw.mime, 'text/markdown');
    assert.equal(raw.data.toString('utf8'), '# Integration fixture\n');
  });
  const workspaceDir = join(dir, 'sessions', id, 'workspace');
  await mkdir(join(workspaceDir, 'nested', 'deep'), { recursive: true });
  await writeFile(join(workspaceDir, 'nested', 'deep', 'note.txt'), 'bye');
  await writeFile(join(workspaceDir, 'nested', 'keep.txt'), 'keep');
  await kernel.deleteFile(id, 'nested/deep/note.txt');
  const afterDelete = (await kernel.listFiles(id)).map((file) => file.path);
  check('deleting a file removes it and prunes only empty parent directories', () => {
    const paths = afterDelete;
    assert.ok(!paths.includes('nested/deep/note.txt'));
    assert.ok(paths.includes('nested/keep.txt'));
  });
  await assert.rejects(() => kernel.deleteFile(id, 'nested/deep/note.txt'), /不存在/);
  await assert.rejects(() => kernel.deleteFile(id, '../runtime.patch.json'), /超出/);
  await assert.rejects(() => kernel.deleteFile(id, 'nested'), /普通文件/);
  await kernel.deleteFile(id, 'nested/keep.txt');
  events = await turn('WRITE DENY');
  check('legacy requireWriteApproval policy is ignored: write lands without a confirmation step', () => {
    assert.equal(
      events.some((event) => event.kind === 'approval_required'),
      false,
    );
    assert.equal(events.find((event) => event.kind === 'tool_result')?.payload.isError, false);
  });
  assert.ok((await kernel.listFiles(id)).some((file) => file.path === 'denied.md'));
  await kernel.deleteFile(id, 'denied.md');
  events = await turn('ESCAPE');
  check('path traversal rejected by actual tool executor', () =>
    assert.equal(events.find((event) => event.kind === 'tool_result')?.payload.isError, true),
  );
  await assert.rejects(() => kernel.readFile(id, '../runtime.patch.json'));
  const sentinel = join(dir, 'sentinel.txt');
  await writeFile(sentinel, 'protected');
  await symlink(sentinel, join(dir, 'sessions', id, 'workspace', 'link.txt'));
  await assert.rejects(() => kernel.readFile(id, 'link.txt'));
  await assert.rejects(() => kernel.readRaw(id, 'link.txt'), /符号链接/);
  await assert.rejects(() => kernel.readRaw(id, '../runtime.patch.json'), /超出/);
  await assert.rejects(() => kernel.readRaw(id, 'missing.png'), /不存在/);
  check('Runner artifact reader also rejects traversal and symlinks', () => assert.ok(true));
  const toolResult = (list) => list.find((event) => event.kind === 'tool_result')?.payload;
  events = await turn('BASH_SAFE');
  check('real bash runs safe combinations without an approval ticket', () => {
    assert.equal(
      events.some((event) => event.kind === 'approval_required'),
      false,
    );
    assert.equal(toolResult(events)?.isError, false);
    assert.match(toolResult(events)?.result ?? '', /bash-marker/);
    assert.match(toolResult(events)?.result ?? '', /Integration fixture/);
  });
  events = await turn('BASH_WRITE');
  check('real bash write asks and a denied request does not execute', () => {
    assert.equal(events.filter((event) => event.kind === 'approval_required').length, 1);
    assert.ok(events.some((event) => event.kind === 'approval_resolved' && event.payload.action === 'deny'));
  });
  assert.ok(!(await kernel.listFiles(id)).some((file) => file.path === 'bash-denied.txt'));
  events = await turn('GREP');
  check('DSH grep (pinned search plugin) searches the session workspace', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, false);
    assert.match(result.result, /report\.md/);
    assert.match(result.result, /Line 1: # Integration fixture/);
  });
  events = await turn('GLOB');
  check('DSH glob lists workspace files by pattern', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, false);
    assert.match(result.result, /report\.md/);
  });
  events = await turn('GREP_ESCAPE');
  check('search outside the workspace is denied before ripgrep runs', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, true);
    assert.match(result.result, /超出当前会话工作区/);
    assert.doesNotMatch(result.result, /sentinel/);
  });
  events = await turn('GREP_LINK');
  check('search through a workspace symlink is denied', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, true);
    assert.match(result.result, /符号链接/);
  });
  events = await turn('GREP_ALL');
  check('workspace-wide search does not follow symlinks out of the workspace', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, false);
    assert.doesNotMatch(result.result, /link\.txt|sentinel/);
  });
  const toolNames = () => requests.at(-1).tools.map((tool) => tool.function.name);
  check('without associated code the session has no read tool and no code section', () => {
    assert.equal(toolNames().includes('read'), false);
    assert.equal(requests.at(-1).messages[0].content.includes('关联代码'), false);
  });
  await assert.rejects(
    () => kernel.sendTurn(id, 'CODE_GREP', undefined, undefined, ['missing-project']),
    /代码项目不存在/,
  );
  await assert.rejects(
    () => kernel.sendTurn(id, 'CODE_GREP', undefined, undefined, ['../alpha']),
    /代码项目不存在/,
  );
  events = await turn('CODE_GREP', undefined, ['alpha']);
  check('associating a project restarts dsh with read-only code tools and project context', () => {
    assert.ok(events.some((event) => event.kind === 'code_projects'));
    const firstRequest = requests.findLast((request) =>
      request.messages.some((message) => message.role === 'user' && message.content === 'CODE_GREP'),
    );
    const system = firstRequest.messages[0].content;
    assert.ok(system.includes(`### alpha → `) && system.includes('（git main@aaaaaaaaaaaa）'));
    assert.ok(system.includes('顶层：src/') && system.includes('# Alpha service'));
    const names = firstRequest.tools.map((tool) => tool.function.name);
    assert.ok(names.includes('read'));
    assert.ok(names.includes('bash'));
    for (const name of ['write', 'edit', 'apply_patch', 'read_image'])
      assert.equal(names.includes(name), false, name);
  });
  check('grep searches an associated project by absolute path', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, false);
    assert.match(result.result, /alphaMarker/);
  });
  events = await turn('CODE_GREP_SECRET');
  check('project-wide grep drops matches from secret files but keeps the rest', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, false);
    assert.match(result.result, /alphaMarker/);
    assert.doesNotMatch(result.result, /code-sentinel|\.env/);
  });
  events = await turn('CODE_GLOB_SECRET');
  check('project-wide glob hides secret files and version-control internals', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, false);
    assert.match(result.result, /app\.ts/);
    assert.doesNotMatch(result.result, /\.env|\.git\b/);
  });
  events = await turn('CODE_READ_ALPHA');
  check('DSH read returns associated project code; the association persists across turns', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, false);
    assert.match(result.result, /export const alphaMarker = 1;/);
  });
  events = await turn('CODE_READ_BETA');
  check('projects that are not associated are denied', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, true);
    assert.match(result.result, /只能访问会话工作区与已关联的代码项目/);
    assert.doesNotMatch(result.result, /BETA_MARKER/);
  });
  events = await turn('CODE_SECRET');
  check('secret files inside an associated project are denied', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, true);
    assert.doesNotMatch(result.result, /code-sentinel/);
  });
  events = await turn('CODE_ESCAPE');
  check('symlinks escaping an associated project are denied', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, true);
    assert.match(result.result, /符号链接/);
    assert.doesNotMatch(result.result, /outside-sentinel/);
  });
  events = await turn('CODE_READ_BETA', undefined, ['alpha', 'beta']);
  check('changing the association takes effect on the next turn (multiple projects)', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, false);
    assert.match(result.result, /BETA_MARKER = True/);
  });
  events = await turn('TIME', undefined, []);
  check('removing every project drops read and the code section again', () => {
    assert.equal(toolNames().includes('read'), false);
    assert.equal(requests.at(-1).messages[0].content.includes('关联代码'), false);
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
  await restarted.purgeWorkspace(id);
  const purgedList = await restarted.listFiles(id);
  const purgedDir = await stat(join(dir, 'sessions', id, 'workspace'));
  check('retention purge empties the workspace but keeps it usable', () => {
    assert.deepEqual(purgedList, []);
    assert.ok(purgedDir.isDirectory());
  });
  await assert.rejects(() => restarted.purgeWorkspace('not-a-session-id'), /会话标识无效/);
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
