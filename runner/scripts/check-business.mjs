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
import { fixtureManifest } from './fixtures.mjs';

const dir = await mkdtemp(join(tmpdir(), 'forge-contract-'));
const outsideWrite = join(process.cwd(), `.sandbox-escape-${process.pid}.txt`);
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
const { SessionKernel, effectiveOutputTokens, turnTimeoutSeconds, syncSkillDraft } =
  await import('../src/kernel/session-kernel.ts');
const { BASE_TOOLS, SEARCH_TOOLS } = await import('../src/kernel/toolset.ts');
const { compactionConfig } = await import('../src/kernel/dsh/index.ts');
let restarted;
const kernel = new SessionKernel(),
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
  // dsh 注入的会话上下文（工作目录等）也以 user 角色发送，0.2.2-rc.5 起为 <system-reminder> 包装
  const lastUser = body.messages.findLastIndex(
    (message) => message.role === 'user' && !message.content.startsWith('<system-reminder>'),
  );
  const instruction = body.messages[lastUser]?.content ?? '';
  const answeredTool = body.messages.slice(lastUser + 1).some((message) => message.role === 'tool');
  if (instruction.includes('HTTP_ERROR')) {
    res.writeHead(401);
    res.end('test fixture authorization failure');
    return;
  }
  // 模拟 DeepSeek 思考模式：历史里任何调用过工具的 assistant 消息缺少 reasoning_content 都返回 400
  if (
    body.model.includes('deepseek') &&
    body.messages.some(
      (message) =>
        message.role === 'assistant' && message.tool_calls?.length && message.reasoning_content === undefined,
    )
  ) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: 'The reasoning_content in the thinking mode must be passed back to the API.',
          type: 'invalid_request_error',
        },
      }),
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  // dsh 自动压缩上下文时的摘要请求（压缩指令作为最后一条 user 消息）
  if (instruction.includes('compaction engine')) {
    send({ choices: [{ delta: { reasoning_content: 'fixture summary thinking' } }] });
    send({
      choices: [
        {
          delta: { content: '## Primary Request and Intent\n- fixture compacted summary' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });
    res.end('data: [DONE]\n\n');
    return;
  }
  // 超长回复（约 23 万字符）：下一次请求前对话超过压缩阈值，dsh 会自动压缩
  if (instruction.includes('HUGE_CONTEXT')) {
    send({
      choices: [
        {
          delta: { content: 'fixture huge context ' + 'long fixture text. '.repeat(12000) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 60000, completion_tokens: 10 },
    });
    res.end('data: [DONE]\n\n');
    return;
  }
  // 输出到上限时正在生成工具调用：正文之后跟一段被截断的 write 参数
  if (instruction.includes('CUT_TOOL')) {
    send({ choices: [{ delta: { content: 'cut tool partial' } }] });
    send({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'cut-call',
                type: 'function',
                function: { name: 'write', arguments: '{"file_path":"cases.md","content":"# 用例' },
              },
            ],
          },
          finish_reason: 'length',
        },
      ],
    });
    res.end('data: [DONE]\n\n');
    return;
  }
  // 思考就用完了输出额度：只有思考、没有正文和工具调用
  if (instruction.includes('CUT_REASONING')) {
    send({ choices: [{ delta: { reasoning_content: '需求很长，先逐条拆解' } }] });
    send({ choices: [{ delta: {}, finish_reason: 'length' }] });
    res.end('data: [DONE]\n\n');
    return;
  }
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
  if (instruction.includes('THINK') && !instruction.includes('LIST')) {
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
  const bashCase = ['BASH_SAFE', 'BASH_WRITE', 'BASH_MAKE', 'BASH_OUTSIDE', 'BASH_ESCALATE', 'BASH_TOKEN'].find((value) =>
    instruction.includes(value),
  );
  if (bashCase && !answeredTool) {
    const command = {
      BASH_SAFE: 'echo bash-marker && cat report.md 2>/dev/null',
      BASH_WRITE: 'echo pwned > /etc/passwd',
      // 会话工作区内可写；工作区外（如上级目录）被 dsh 沙箱拒绝
      BASH_MAKE: 'echo made-by-bash > bash-made.txt && echo done',
      // 临时目录在沙箱里本来就可写，越界目标放在 Runner 目录下
      BASH_OUTSIDE: `echo escaped > ${outsideWrite}`,
      BASH_ESCALATE: `echo escalated > ${outsideWrite}`,
      BASH_TOKEN: 'echo https://user:ghp_secrettoken1234567890abcdefghijklmnop@github.com/x.git',
    }[bashCase];
    // 越界写入：模型带上 sandbox_permissions 与给用户看的理由，请求突破沙箱
    const escalation =
      bashCase === 'BASH_ESCALATE'
        ? { sandbox_permissions: 'danger-full-access', justification: '需要把结果写到会话目录之外' }
        : {};
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
                  arguments: JSON.stringify({ description: 'Check bash routing', command, ...escalation }),
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
  const fileCase = ['WRITE', 'ESCAPE', 'HIDDEN', 'LIST', 'READ', 'PRESENT', 'EDIT'].find((value) =>
    instruction.includes(value),
  );
  if (fileCase && !answeredTool) {
    const tool = { LIST: 'glob', READ: 'read', PRESENT: 'present', EDIT: 'edit' }[fileCase] ?? 'write';
    if (instruction.includes('THINK'))
      send({ choices: [{ delta: { reasoning_content: '需要先列出文件。' } }] });
    const path = instruction.includes('ESCAPE')
      ? '../escape.txt'
      : instruction.includes('HIDDEN')
        ? '.skill/SKILL.md'
        : instruction.includes('DENY')
          ? 'denied.md'
          : 'report.md';
    const args = JSON.stringify(
      {
        glob: { pattern: '*.md' },
        read: { file_path: 'report.md' },
        present: { files: [{ path: 'report.md', description: '集成报告' }] },
        edit: { file_path: 'edited.md', old_string: 'draft', new_string: 'final' },
        write: { file_path: path, content: '# Integration fixture\n' },
      }[tool],
    );
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
const manifest = fixtureManifest({
  systemPrompt: {
    identity: 'Integration contract test only.',
    // 场景提示词里的模板占位符必须原样保留，不能让 dsh 当作变量插值而使请求失败
    domain: 'Do not contact external services. Keep {{placeholder}} literal.',
  },
  // 旧版本保存的场景只声明 current_time（已由 DSH 时间上下文替代）：文件读写与搜索由 Runner 基础能力补齐
  tools: { builtin: ['current_time'] },
  policy: {
    // 旧版本保存的工具名：Runner 按平台契约换成 read / write
    allowedTools: ['current_time', 'workspace_list', 'workspace_read', 'workspace_write', 'bash'],
    // 旧版本保存的策略字段：已下线，必须被忽略（写入不再逐次确认）
    requireWriteApproval: true,
    requestTimeoutSeconds: 20,
    approvalTimeoutSeconds: 2,
    maxOutputTokens: 512,
  },
});
let id,
  allEvents = [],
  // 任何意外出现的确认请求都会被拒绝，从而让写入失败、断言暴露问题
  approvalAction = 'deny';
try {
  const handle = await kernel.createSession(manifest, {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'protocol-fixture-not-a-model',
    apiKey: 'test-key-do-not-use',
    contextWindow: 64000,
  });
  id = handle.sessionId;
  kernel.onEvent(id, (event) => {
    allEvents.push(event);
    if (event.kind === 'approval_required' && approvalAction !== 'wait')
      void kernel.resolveApproval(id, event.payload.ticketId, { action: approvalAction });
  });
  async function turn(text, model, codeProjects) {
    const start = allEvents.length;
    await kernel.sendTurn(id, text, model, codeProjects);
    return allEvents.slice(start);
  }
  check('a whole turn may run 30 minutes by default; env overrides with a 60s floor', () => {
    assert.equal(turnTimeoutSeconds({}), 1800);
    assert.equal(turnTimeoutSeconds({ RUNNER_TURN_TIMEOUT_SECONDS: '3600' }), 3600);
    assert.equal(turnTimeoutSeconds({ RUNNER_TURN_TIMEOUT_SECONDS: '5' }), 60);
    assert.equal(turnTimeoutSeconds({ RUNNER_TURN_TIMEOUT_SECONDS: 'abc' }), 1800);
  });
  check('output cap follows policy but never exceeds half the context window', () => {
    assert.equal(effectiveOutputTokens(64000, undefined), 16384);
    assert.equal(effectiveOutputTokens(128000, 65536), 64000);
    assert.equal(effectiveOutputTokens(8192, 16384), 4096);
    assert.equal(effectiveOutputTokens(1000000, 4096), 4096);
  });
  check('compaction budget fits every common context window (dsh compaction-basic formula)', () => {
    for (let [window, output] of [
      [8192, 4096],
      [32000, 4096],
      [64000, 4096],
      [128000, 8192],
      [1000000, 8192],
      [8192, 16384],
      [32000, 16384],
      [64000, 16384],
      [128000, 65536],
    ]) {
      output = effectiveOutputTokens(window, output);
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
    assert.equal(requests[0].messages[0].role, 'system');
    assert.ok(requests[0].messages[0].content.startsWith('Integration contract test'));
  });
  check('system prompt: scenario prompt first and literal; no sdk coding persona or harness identity', () => {
    const system = requests[0].messages[0].content;
    assert.ok(system.includes('Keep {{placeholder}} literal.'));
    assert.doesNotMatch(system, /DeepSeek Harness|coding agent powered by/);
  });
  check('current time reaches the model as context, without a tool call', () => {
    const context = JSON.stringify(requests[0].messages.slice(1));
    assert.match(context, new RegExp(String(new Date().getFullYear())));
    assert.equal(
      requests[0].tools.some((tool) => tool.function.name === 'current_time'),
      false,
    );
  });
  check('token usage includes cached input exactly once', () =>
    assert.deepEqual(events.find((event) => event.kind === 'cost_tick')?.payload, {
      tokensIn: 100,
      tokensOut: 10,
    }),
  );
  check('base capabilities load without scenario grants (edit/present ride on write, search on read)', () =>
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.function.name).sort(),
      [...BASE_TOOLS, 'edit', 'present', ...SEARCH_TOOLS].toSorted(),
    ),
  );
  check('system prompt tells the model to save requested files with write', () => {
    const system = requests[0].messages[0].content;
    assert.ok(system.includes('必须调用 write'));
    assert.ok(system.includes('present'));
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
  check('reasoning from earlier turns of the same model is replayed (DSH-consistent)', () => {
    const assistant = requests
      .at(-1)
      .messages.find((message) => message.role === 'assistant' && message.content === '思考后的回答');
    assert.ok(assistant, 'earlier answer remains in history');
    assert.equal(assistant.reasoning_content, '先分析一下。');
  });
  events = await turn('THINK LIST');
  check('reasoning inside the current tool loop is replayed to the gateway', () => {
    assert.ok(events.some((event) => event.kind === 'tool_result'));
    const followUp = requests.at(-1).messages;
    const call = followUp.find((message) => message.role === 'assistant' && message.tool_calls?.length);
    assert.equal(call?.reasoning_content, '需要先列出文件。');
  });
  events = await turn('WRITE');
  check(
    'reasoning of an earlier tool-call turn is replayed in the next turn (DeepSeek 400 regression)',
    () => {
      const call = requests
        .at(-1)
        .messages.find(
          (message) =>
            message.role === 'assistant' && message.tool_calls?.[0]?.function.name === 'glob',
        );
      assert.equal(call?.reasoning_content, '需要先列出文件。');
    },
  );
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
  assert.equal(await kernel.files.readFile(id, 'report.md'), '# Integration fixture\n');
  events = await turn('LIST');
  check('DSH glob lists the written artifact', () =>
    assert.match(events.find((event) => event.kind === 'tool_result').payload.result, /report\.md/),
  );
  events = await turn('READ');
  check('DSH read returns actual file content of a workspace-relative path', () =>
    assert.match(events.find((event) => event.kind === 'tool_result').payload.result, /# Integration fixture/),
  );
  await writeFile(join(dir, 'sessions', id, 'workspace', 'edited.md'), '# draft plan\n');
  events = await turn('EDIT');
  check('DSH edit changes a workspace file in place and reports it as an artifact', () => {
    assert.equal(events.find((event) => event.kind === 'tool_result')?.payload.isError, false);
    assert.deepEqual(events.find((event) => event.kind === 'files')?.payload.files, [
      { path: 'edited.md', bytes: 13 },
    ]);
  });
  assert.equal(await kernel.files.readFile(id, 'edited.md'), '# final plan\n');
  await kernel.files.deleteFile(id, 'edited.md');
  events = await turn('HIDDEN');
  check('writes into hidden folders such as the .skill/ mirror are denied', () => {
    const result = events.find((event) => event.kind === 'tool_result')?.payload;
    assert.equal(result?.isError, true);
    assert.match(result.result, /隐藏/);
  });
  events = await turn('PRESENT');
  check('present is enabled with write and declares deliverables without approval', () => {
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
  const listed = (await kernel.files.listFiles(id)).find((file) => file.path === 'report.md');
  const raw = await kernel.files.readRaw(id, 'report.md');
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
  await kernel.files.deleteFile(id, 'nested/deep/note.txt');
  const afterDelete = (await kernel.files.listFiles(id)).map((file) => file.path);
  check('deleting a file removes it and prunes only empty parent directories', () => {
    const paths = afterDelete;
    assert.ok(!paths.includes('nested/deep/note.txt'));
    assert.ok(paths.includes('nested/keep.txt'));
  });
  await assert.rejects(() => kernel.files.deleteFile(id, 'nested/deep/note.txt'), /不存在/);
  await assert.rejects(() => kernel.files.deleteFile(id, '../runtime.patch.json'), /超出/);
  await assert.rejects(() => kernel.files.deleteFile(id, 'nested'), /普通文件/);
  await kernel.files.deleteFile(id, 'nested/keep.txt');
  events = await turn('WRITE DENY');
  check('legacy requireWriteApproval policy is ignored: write lands without a confirmation step', () => {
    assert.equal(
      events.some((event) => event.kind === 'approval_required'),
      false,
    );
    assert.equal(events.find((event) => event.kind === 'tool_result')?.payload.isError, false);
  });
  assert.ok((await kernel.files.listFiles(id)).some((file) => file.path === 'denied.md'));
  await kernel.files.deleteFile(id, 'denied.md');
  events = await turn('ESCAPE');
  check('path traversal rejected by actual tool executor', () =>
    assert.equal(events.find((event) => event.kind === 'tool_result')?.payload.isError, true),
  );
  await assert.rejects(() => kernel.files.readFile(id, '../runtime.patch.json'));
  const sentinel = join(dir, 'sentinel.txt');
  await writeFile(sentinel, 'protected');
  await symlink(sentinel, join(dir, 'sessions', id, 'workspace', 'link.txt'));
  await assert.rejects(() => kernel.files.readFile(id, 'link.txt'));
  await assert.rejects(() => kernel.files.readRaw(id, 'link.txt'), /符号链接/);
  await assert.rejects(() => kernel.files.readRaw(id, '../runtime.patch.json'), /超出/);
  await assert.rejects(() => kernel.files.readRaw(id, 'missing.png'), /不存在/);
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
  check('real bash denied command does not execute', () => {
    const result = toolResult(events);
    assert.equal(result?.isError, true);
    assert.match(result?.result ?? '', /安全策略|系统核心路径/);
  });
  events = await turn('BASH_MAKE');
  check('bash writes inside the session workspace (one-shot shell, cwd = workspace)', () => {
    assert.equal(toolResult(events)?.isError, false);
    assert.match(toolResult(events)?.result ?? '', /done/);
  });
  assert.equal(await kernel.files.readFile(id, 'bash-made.txt'), 'made-by-bash\n');
  await kernel.files.deleteFile(id, 'bash-made.txt');
  events = await turn('BASH_TOKEN');
  check('bash output is sanitized before the model sees it', () => {
    assert.match(toolResult(events)?.result ?? '', /user:\*\*\*@github\.com/);
    assert.doesNotMatch(toolResult(events)?.result ?? '', /ghp_secret/);
  });
  if (kernel.sandbox.status === 'enforced') {
    events = await turn('BASH_OUTSIDE');
    check('the dsh sandbox blocks bash writes outside the workspace (no approval granted)', () => {
      assert.match(toolResult(events)?.result ?? '', /sandbox|denied|Permission denied|Read-only/i);
    });
    await assert.rejects(() => stat(outsideWrite));
    events = await turn('BASH_ESCALATE');
    check('sandbox escalation asks the user with a Chinese reason; a denial keeps the command blocked', () => {
      const ask = events.find((event) => event.kind === 'approval_required');
      assert.equal(ask?.payload.tool, 'bash');
      assert.equal(
        ask?.payload.reason,
        '这条命令需要突破终端沙箱（不受沙箱限制，可读写服务器上的任意位置）。原因：需要把结果写到会话目录之外',
      );
      assert.equal(toolResult(events)?.isError, true);
    });
    await assert.rejects(() => stat(outsideWrite));
  } else console.log('SKIP sandbox write boundary: this host has no bwrap / Landlock');
  assert.ok(!(await kernel.files.listFiles(id)).some((file) => file.path === 'pwned.txt'));
  assert.ok(!(await kernel.files.listFiles(id)).some((file) => file.path === 'bash-denied.txt'));
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
  check('read is a base tool; without associated code there is no code section', () => {
    assert.equal(toolNames().includes('read'), true);
    assert.equal(requests.at(-1).messages[0].content.includes('关联代码'), false);
  });
  await assert.rejects(
    () => kernel.sendTurn(id, 'CODE_GREP', undefined, ['missing-project']),
    /代码项目不存在/,
  );
  await assert.rejects(() => kernel.sendTurn(id, 'CODE_GREP', undefined, ['../alpha']), /代码项目不存在/);
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
    for (const name of ['apply_patch', 'read_image', 'working_directory'])
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
  events = await turn('PLAIN', undefined, []);
  check('removing every project drops the code section again', () => {
    assert.equal(requests.at(-1).messages[0].content.includes('关联代码'), false);
  });
  events = await turn('HTTP_ERROR');
  check('gateway HTTP failure produces error, not success', () => {
    const error = events.find((event) => event.kind === 'error');
    assert.ok(error);
    assert.match(error.payload.message, /HTTP 401/);
    assert.match(error.payload.message, /凭据/);
    assert.match(error.payload.message, /test fixture authorization failure/);
    assert.equal(events.at(-1)?.payload.status, 'error');
  });
  for (const [instruction, expected] of [
    ['MAX_TOKENS', /单次输出上限/],
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
  events = await turn('CUT_TOOL');
  check('tool call cut by the output cap ends softly: partial text kept, incomplete call never runs', () => {
    assert.ok(
      events.some((event) => event.kind === 'message_delta' && event.payload.text === 'cut tool partial'),
    );
    assert.equal(
      events.some((event) => event.kind === 'tool_use_start'),
      false,
    );
    assert.ok(events.some((event) => event.kind === 'error' && /单次输出上限/.test(event.payload.message)));
    assert.equal(events.at(-1)?.payload.status, 'error');
  });
  events = await turn('PLAIN');
  check('the next turn continues from the cut text without a dangling tool call', () => {
    assert.ok(events.some((event) => event.kind === 'message'));
    const history = requests.at(-1).messages;
    assert.ok(
      history.some(
        (message) =>
          message.role === 'assistant' &&
          typeof message.content === 'string' &&
          message.content.includes('cut tool partial'),
      ),
    );
    assert.equal(
      history.some((message) => (message.tool_calls ?? []).some((call) => call.id === 'cut-call')),
      false,
    );
  });
  events = await turn('CUT_REASONING');
  check('reasoning that uses up the output cap is reported as the cap, not an empty response', () => {
    assert.ok(events.some((event) => event.kind === 'error' && /单次输出上限/.test(event.payload.message)));
    assert.equal(
      events.some((event) => event.kind === 'error' && /空响应/.test(event.payload.message)),
      false,
    );
    assert.equal(events.at(-1)?.payload.status, 'error');
  });
  const switched = {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'switched-fixture-model',
    apiKey: 'second-test-key',
    contextWindow: 32000,
  };
  await assert.rejects(
    () => kernel.sendTurn(id, 'PLAIN', { model: 'missing-base-url' }),
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
    // 上一个模型的思考不交给新模型
    const earlier = request.messages.find(
      (message) => message.role === 'assistant' && message.content === '思考后的回答',
    );
    assert.equal(earlier?.reasoning_content, undefined);
  });
  events = await turn('PLAIN');
  check('the switched model stays in effect for later turns', () =>
    assert.equal(requests.at(-1).model, 'switched-fixture-model'),
  );
  const beforeDeepSeek = requests.length;
  events = await turn('PLAIN', { ...switched, model: 'deepseek-fixture-flash' });
  check('switching to DeepSeek pads reasoning_content so tool history from other models is accepted', () => {
    assert.equal(
      events.some((event) => event.kind === 'error'),
      false,
      JSON.stringify(events.find((event) => event.kind === 'error')),
    );
    const request = requests[beforeDeepSeek];
    assert.equal(request.model, 'deepseek-fixture-flash');
    const assistants = request.messages.filter((message) => message.role === 'assistant');
    assert.ok(assistants.some((message) => message.tool_calls?.length));
    assert.ok(assistants.every((message) => typeof message.reasoning_content === 'string'));
    // 其他模型的思考内容不带过来，只补空字符串
    assert.equal(assistants.find((message) => message.content === '思考后的回答')?.reasoning_content, '');
  });
  events = await turn('THINK LIST');
  events = await turn('PLAIN');
  check('DeepSeek keeps working after its own tool-call turn (no 400 on the next message)', () => {
    assert.equal(
      events.some((event) => event.kind === 'error'),
      false,
    );
    const call = requests
      .at(-1)
      .messages.findLast(
        (message) =>
          message.role === 'assistant' && message.tool_calls?.[0]?.function.name === 'glob',
      );
    assert.equal(call?.reasoning_content, '需要先列出文件。');
  });
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
  assert.equal(await kernel.files.readFile(id, 'report.md'), '# Integration fixture\n');
  restarted = new SessionKernel();
  assert.equal(await restarted.files.readFile(id, 'report.md'), '# Integration fixture\n');
  check('artifacts remain readable after archive and Runner reconstruction', () =>
    assert.equal(kernel.size, 0),
  );
  // Runner 重启：新内核内存为空，按原 id 与控制面快照恢复后，必须从磁盘会话日志接续完整上下文
  const fixtureModel = (name) => ({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: name,
    apiKey: 'test-key-do-not-use',
    contextWindow: 64000,
  });
  await assert.rejects(
    () => restarted.sendTurn(id, 'PLAIN'),
    (error) => error.statusCode === 404,
  );
  // 执行日志：Runner 重启后、会话尚未恢复时，控制面仍能从磁盘补读重启前产生的事件
  const durableBefore = allEvents.filter((event) => !event.kind.endsWith('_delta'));
  const lastSeqBefore = durableBefore.at(-1).seq;
  const fromDisk = restarted.eventsAfter(id, lastSeqBefore - 5);
  check('journal: an unloaded session serves persisted events from disk by seq', () => {
    assert.deepEqual(
      fromDisk.map((event) => event.seq),
      durableBefore.slice(-5).map((event) => event.seq),
    );
    assert.equal(fromDisk.at(-1).kind, 'done');
    assert.deepEqual(restarted.eventsAfter(id, lastSeqBefore), []);
  });
  check('journal: durable events have strictly increasing seq; deltas take no number of their own', () => {
    durableBefore.forEach(
      (event, index) => index && assert.equal(event.seq, durableBefore[index - 1].seq + 1),
    );
    const delta = allEvents.find((event) => event.kind === 'message_delta');
    assert.ok(delta && durableBefore.some((event) => event.seq === delta.seq));
    assert.ok(!fromDisk.some((event) => event.kind.endsWith('_delta')));
  });
  assert.throws(
    () => restarted.eventsAfter('22222222-2222-4222-8222-222222222222', 0),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    () => restarted.restoreSession('00000000-0000-4000-8000-000000000000', manifest, fixtureModel('m')),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    () => restarted.restoreSession('../escape', manifest, fixtureModel('m')),
    (error) => error.statusCode === 422,
  );
  await assert.rejects(
    () => restarted.restoreSession(id, manifest, { model: 'missing-base-url' }),
    (error) => error.statusCode === 422,
  );
  const [restoredHandle, concurrentHandle] = await Promise.all([
    restarted.restoreSession(id, manifest, fixtureModel('restored-fixture-model')),
    restarted.restoreSession(id, manifest, fixtureModel('restored-fixture-model')),
  ]);
  const restartedEvents = [];
  restarted.onEvent(id, (event) => restartedEvents.push(event));
  const beforeRestore = requests.length;
  await restarted.sendTurn(id, 'PLAIN');
  check('restoreSession resumes the persisted dsh log after a Runner restart (same id, full history)', () => {
    assert.equal(restoredHandle.sessionId, id);
    assert.equal(concurrentHandle.sessionId, id);
    assert.equal(restarted.size, 1);
    assert.ok(restartedEvents.some((event) => event.kind === 'message'));
    const request = requests[beforeRestore];
    assert.equal(request.model, 'restored-fixture-model');
    for (const earlier of ['THINK', 'AFTER_INTERRUPT'])
      assert.ok(
        request.messages.some((message) => message.role === 'user' && message.content === earlier),
        `history keeps ${earlier}`,
      );
  });
  check('journal: seq continues across a Runner restart instead of starting over', () => {
    // 恢复时引擎启动阶段的事件（插件加载等）同样接着编号
    assert.ok(restoredHandle.lastSeq >= lastSeqBefore);
    assert.equal(restarted.eventsAfter(id, 0)[0].seq <= lastSeqBefore, true);
    assert.equal(restarted.eventsAfter(id, lastSeqBefore)[0].seq, lastSeqBefore + 1);
  });
  // 回合归属在 Runner：startTurn 立即返回，回合在后台执行到底；调用方不订阅也不影响执行与记录
  const submitted = restarted.startTurn(id, 'PLAIN');
  assert.throws(
    () => restarted.startTurn(id, 'PLAIN'),
    (error) => error.statusCode === 409,
  );
  assert.equal(restarted.state(id).turnActive, true);
  await new Promise((resolve) => {
    const off = restarted.onEvent(id, (event) => event.kind === 'done' && (off(), resolve()));
  });
  const detached = restarted.eventsAfter(id, submitted.after);
  check('journal: a submitted turn runs detached and is fully recoverable from its start seq', () => {
    assert.equal(detached[0].seq, submitted.after + 1);
    assert.ok(detached.some((event) => event.kind === 'message'));
    assert.deepEqual(detached.at(-1).payload, { status: 'idle', turnId: submitted.turnId });
    assert.equal(restarted.state(id).turnActive, false);
  });
  restarted.ackEvents(id, detached.at(-2).seq);
  check('journal: acknowledged events are dropped, the rest stay readable', () => {
    assert.deepEqual(
      restarted.eventsAfter(id, 0).map((event) => event.seq),
      [detached.at(-1).seq],
    );
  });
  // 已在内存中：替换为新配置，下一轮以新配置重启并接续同一份日志
  await restarted.restoreSession(id, manifest, fixtureModel('reconfigured-fixture-model'));
  const beforeReconfigure = requests.length;
  await restarted.sendTurn(id, 'PLAIN');
  check('restoreSession on a live session swaps the config and resumes on the next turn', () => {
    const request = requests[beforeReconfigure];
    assert.equal(request.model, 'reconfigured-fixture-model');
    assert.ok(
      request.messages.some((message) => message.role === 'user' && message.content === 'AFTER_INTERRUPT'),
    );
  });
  // 对话过长触发 dsh 自动压缩：摘要是后台请求，只显示“正在整理”状态，摘要文字不能进入实时回复
  await restarted.sendTurn(id, 'HUGE_CONTEXT');
  const beforeCompaction = restartedEvents.length;
  await restarted.sendTurn(id, 'PLAIN');
  const compacting = restartedEvents.slice(beforeCompaction);
  check(
    'context compaction runs in the background: status events only, summary never streams as a reply',
    () => {
      assert.ok(requests.some((request) => JSON.stringify(request.messages).includes('compaction engine')));
      // 每次压缩都有开始与结束；第一次成功，之后 dsh 可能再试一次（摘要已无法更小时以 failed 结束，本轮照常完成）
      const phases = compacting
        .filter((event) => event.kind === 'compaction')
        .map((event) => event.payload.phase);
      assert.deepEqual(phases.slice(0, 2), ['start', 'end']);
      phases.forEach((phase, index) => assert.equal(phase === 'start', index % 2 === 0));
      assert.equal(phases.length % 2, 0);
      for (const event of compacting.filter((item) => item.kind.endsWith('_delta')))
        assert.doesNotMatch(event.payload.text, /compacted summary|summary thinking/);
      assert.equal(compacting.find((event) => event.kind === 'message')?.payload.text, 'fixture response');
      assert.equal(compacting.at(-1)?.payload.status, 'idle');
    },
  );
  await restarted.disposeSession(id);
  // 日志目录存在但内容无法恢复：返回 410，且不留下半成品会话（控制面据此走降级）
  const corruptId = '11111111-1111-4111-8111-111111111111';
  await mkdir(join(dir, 'sessions', corruptId, 'session-log'), { recursive: true });
  await writeFile(join(dir, 'sessions', corruptId, 'session-log', 'garbage.jsonl'), 'not a dsh log\n');
  await assert.rejects(
    () => restarted.restoreSession(corruptId, manifest, fixtureModel('m')),
    (error) => error.statusCode === 410,
  );
  check('unrecoverable session log fails with 410 and leaves no half-restored session', () =>
    assert.equal(restarted.has(corruptId), false),
  );
  const authoring = fixtureManifest({
    skillAuthoring: { content: 'v1', files: [{ path: 'references/a.md', content: 'a1' }] },
  });
  syncSkillDraft(authoring, { action: 'update_draft', content: 'v2', summary: 's' });
  syncSkillDraft(authoring, { action: 'write_file', path: 'references/a.md', content: 'a2' });
  syncSkillDraft(authoring, { action: 'write_file', path: 'scripts/run.py', content: 'print(1)' });
  syncSkillDraft(authoring, { action: 'delete_file', path: 'references/a.md' });
  syncSkillDraft(fixtureManifest(), { action: 'update_draft', content: 'ignored' });
  check('agent draft edits keep the manifest draft current for later engine restarts', () =>
    assert.deepEqual(authoring.skillAuthoring, {
      content: 'v2',
      files: [{ path: 'scripts/run.py', content: 'print(1)' }],
    }),
  );
  await restarted.files.purgeWorkspace(id);
  const purgedList = await restarted.files.listFiles(id);
  const purgedDir = await stat(join(dir, 'sessions', id, 'workspace'));
  check('retention purge empties the workspace but keeps it usable', () => {
    assert.deepEqual(purgedList, []);
    assert.ok(purgedDir.isDirectory());
  });
  await assert.rejects(() => restarted.files.purgeWorkspace('not-a-session-id'), /会话标识无效/);
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
  await restarted?.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
  await rm(outsideWrite, { force: true });
}
