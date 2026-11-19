#!/usr/bin/env node
/**
 * 扩展能力集成检查：真实启动 dsh，装配 Skill（运行时注册 + 只读参考资料）、stdio MCP（本机夹具服务）
 * 与联网工具（DeepSeek 搜索 + HTTP 抓取，只检查装配，不发外部请求）。模型是本机 OpenAI 协议夹具。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const dir = await mkdtemp(join(tmpdir(), 'forge-caps-'));
process.env.FORGE_RUNNER_DATA_DIR = join(dir, 'sessions');
process.env.FORGE_CODE_ROOT = join(dir, 'code');
// 模拟宿主上的敏感变量：stdio MCP 子进程不应看到
process.env.FORGE_RUNNER_TOKEN = 'runner-token-sentinel';
const { DshKernel, sessionToolset } = await import('../src/kernel/dsh-kernel.ts');
const { resolveCapabilities, mcpPublicToolName, capabilitySummary } =
  await import('../src/kernel/capabilities.ts');
const { buildSystemPrompt } = await import('../src/kernel/system-prompt.ts');

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log('PASS', name);
};

// —— stdio MCP 夹具：echo（只读）、write_note（需确认）、hidden（未授权）；env 报告子进程可见的变量 ——
const mcpScript = join(dir, 'mcp-fixture.mjs');
await writeFile(
  mcpScript,
  `import { createInterface } from 'node:readline';
const tools = [
  { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'write_note', description: 'Write a note', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } },
  { name: 'hidden', description: 'Not granted', inputSchema: { type: 'object', properties: {} } },
];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === 'initialize')
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools } });
  else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    const env = Object.keys(process.env).filter((key) => /FORGE|SECRET|TOKEN|KEY|MCP_GREETING/.test(key)).sort();
    const text = name === 'echo' ? 'echo:' + args.text + ' env=' + env.join(',') + ' greeting=' + process.env.MCP_GREETING : 'noted:' + args.note;
    send({ id: message.id, result: { content: [{ type: 'text', text }] } });
  } else send({ id: message.id, result: {} });
}
`,
);

const skill = {
  name: 'report-style',
  title: '报告规范',
  description: '撰写周报时使用的格式规范',
  whenToUse: '用户要求写周报',
  content: '# 报告规范\n\n标题用「周报」开头，结论先行。详见 references/glossary.md。',
  references: [{ filename: 'glossary.md', content: 'GLOSSARY-SENTINEL\n' }],
  source: 'scenario',
};
const mcp = {
  serverName: 'demo',
  title: '演示 MCP',
  source: 'chat',
  transport: 'stdio',
  command: process.execPath,
  args: [mcpScript],
  env: { MCP_GREETING: 'hello' },
  tools: [
    { name: 'echo', permission: 'read' },
    { name: 'write_note', permission: 'approval' },
  ],
};
const web = {
  search: true,
  fetch: true,
  provider: 'deepseek-official',
  apiKey: 'web-key-sentinel',
  source: 'scenario',
};
const caps = { skills: [skill], mcp: [mcp], web };

// —— 纯函数 ——
await check('capabilities are validated: names, transports, duplicates, references', () => {
  assert.deepEqual(resolveCapabilities(undefined), { skills: [], mcp: [], web: null });
  assert.throws(() => resolveCapabilities({ skills: [{ ...skill, name: 'Bad Name' }] }), /Skill 名称无效/);
  assert.throws(() => resolveCapabilities({ skills: [skill, skill] }), /Skill 名称重复/);
  assert.throws(
    () => resolveCapabilities({ skills: [{ ...skill, references: [{ filename: '../x', content: '' }] }] }),
    /参考资料无效/,
  );
  assert.throws(() => resolveCapabilities({ mcp: [{ ...mcp, transport: 'sse' }] }), /传输方式不受支持/);
  assert.throws(
    () => resolveCapabilities({ mcp: [{ ...mcp, transport: 'streamable-http', url: 'http://x.test/mcp' }] }),
    /HTTPS/,
  );
  assert.throws(() => resolveCapabilities({ mcp: [{ ...mcp, tools: [] }] }), /没有可用工具/);
  assert.throws(
    () => resolveCapabilities({ web: { search: true, provider: 'nope', apiKey: 'k' } }),
    /提供方/,
  );
  assert.equal(resolveCapabilities({ web: { search: false, fetch: false } }).web, null);
});
await check('MCP public names mirror dsh-mcp-client (normalization + hash suffix)', () => {
  assert.equal(mcpPublicToolName('demo', 'echo'), 'mcp__demo__echo');
  const odd = mcpPublicToolName('demo', 'search.docs');
  assert.match(odd, /^mcp__demo__search_docs_[a-f0-9]{12}$/);
  assert.ok(mcpPublicToolName('demo', 'x'.repeat(80)).length <= 64);
});
await check('session toolset adds skill/read, web tools and granted MCP tools only', () => {
  const toolset = sessionToolset(
    { builtin_tools: ['current_time'], policy: { allowedTools: ['current_time'] } },
    false,
    resolveCapabilities(caps),
  );
  assert.deepEqual(toolset.allowed, [
    'current_time',
    'read',
    'skill',
    'web_search',
    'web_fetch',
    'mcp__demo__echo',
    'mcp__demo__write_note',
  ]);
  assert.deepEqual(toolset.approval, ['mcp__demo__write_note']);
  assert.equal(toolset.read, true);
  // 没有参考资料的 Skill 不开放 read
  const plain = resolveCapabilities({ skills: [{ ...skill, references: [] }] });
  assert.equal(sessionToolset({ policy: { allowedTools: [] } }, false, plain).read, false);
});
await check('summary never leaks skill bodies, credentials, commands or env', () => {
  const text = JSON.stringify(capabilitySummary(resolveCapabilities(caps)));
  for (const secret of ['web-key-sentinel', 'MCP_GREETING', mcpScript, 'GLOSSARY-SENTINEL', '结论先行'])
    assert.ok(!text.includes(secret), secret);
});
await check('system prompt explains skills, MCP confirmation and web citation rules', () => {
  const prompt = buildSystemPrompt('x', [], [], {
    skills: [{ name: 'report-style', hasReferences: true }],
    mcp: [{ serverName: 'demo', tools: [{ publicName: 'mcp__demo__write_note', approval: true }] }],
    webSearch: true,
    webFetch: true,
  });
  assert.ok(prompt.includes('skill 工具'));
  assert.ok(prompt.includes('/名称'));
  assert.ok(prompt.includes('需要用户确认'));
  assert.ok(prompt.includes('web_search'));
  assert.ok(prompt.includes('注明来源'));
  assert.equal(buildSystemPrompt('x').includes('## Skill'), false);
});

// —— 集成：真实 dsh ——
const requests = [];
const plan = {
  SKILL: ['skill', { name: 'report-style' }],
  REFERENCE: [
    'read',
    { file_path: () => join(dir, 'sessions', id, 'skills', 'report-style', 'references', 'glossary.md') },
  ],
  ECHO: ['mcp__demo__echo', { text: 'hi' }],
  NOTE: ['mcp__demo__write_note', { note: 'n1' }],
  HIDDEN: ['mcp__demo__hidden', {}],
};
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const lastUser = body.messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      typeof message.content === 'string' &&
      !message.content.startsWith('Current runtime context.'),
  );
  const instruction = body.messages[lastUser]?.content ?? '';
  const answered = body.messages.slice(lastUser + 1).some((message) => message.role === 'tool');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  const key = Object.keys(plan).find((value) => instruction.includes(value));
  if (key && !answered) {
    const [name, args] = plan[key];
    const resolved = Object.fromEntries(
      Object.entries(args).map(([field, value]) => [field, typeof value === 'function' ? value() : value]),
    );
    send({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-' + requests.length,
                type: 'function',
                function: { name, arguments: JSON.stringify(resolved) },
              },
            ],
          },
        },
      ],
    });
    send({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  } else {
    send({
      choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    });
  }
  res.end('data: [DONE]\n\n');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const bundle = {
  profile_patch: { systemPrompt: { identity: 'Capability contract test.' } },
  plugin_mounts: ['forge-runtime'],
  skill_files: {},
  mcp: [],
  model_route: { primary: 'default', fallbacks: [] },
  policy_ref: 'test',
  meta: {
    builtin_tools: ['current_time'],
    policy: {
      allowedTools: ['current_time'],
      requestTimeoutSeconds: 20,
      approvalTimeoutSeconds: 5,
      maxOutputTokens: 512,
    },
  },
};
const kernel = new DshKernel();
const events = [];
let id;
let approval = 'approve';
const toolNames = () =>
  requests
    .at(-1)
    .tools.map((tool) => tool.function.name)
    .sort();
async function turn(text, capabilities) {
  const start = events.length;
  await kernel.sendTurn(id, text, undefined, undefined, undefined, capabilities);
  return events.slice(start);
}
const result = (list) => list.find((event) => event.kind === 'tool_result')?.payload;
try {
  const handle = await kernel.createSession(
    bundle,
    { tenantId: 't', userId: 'u', roles: [] },
    {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'fixture',
      apiKey: 'model-key-sentinel',
      contextWindow: 64000,
    },
    undefined,
    caps,
  );
  id = handle.sessionId;
  kernel.onEvent(id, (event) => {
    events.push(event);
    if (event.kind === 'approval_required')
      void kernel.resolveApproval(id, event.payload.ticketId, { action: approval });
  });

  let list = await turn('PLAIN');
  void list;
  await check('model sees skill, read, web and granted MCP tools; ungranted MCP tool stays hidden', () => {
    assert.deepEqual(toolNames(), [
      'current_time',
      'mcp__demo__echo',
      'mcp__demo__write_note',
      'read',
      'skill',
      'web_fetch',
      'web_search',
    ]);
  });
  await check('runtime skills are registered at boot', async () => {
    const replay = [];
    for await (const event of kernel.replay(id)) replay.push(event);
    assert.deepEqual(replay.find((event) => event.kind === 'skills_loaded')?.payload.skills, [
      'report-style',
    ]);
  });
  await check('skill catalog reaches the model without the skill body', () => {
    const text = JSON.stringify(requests.at(-1).messages);
    assert.ok(text.includes('report-style'));
    assert.ok(!text.includes('结论先行'));
  });
  list = await turn('SKILL');
  await check('skill tool loads the registered body and points at the reference directory', () => {
    const payload = result(list);
    assert.equal(payload.isError, false);
    assert.ok(payload.result.includes('结论先行'));
    assert.ok(payload.result.includes(join('skills', 'report-style')));
  });
  list = await turn('REFERENCE');
  await check('skill references are readable through read (read-only root)', () => {
    const payload = result(list);
    assert.equal(payload.isError, false, payload.result);
    assert.ok(payload.result.includes('GLOSSARY-SENTINEL'));
  });
  list = await turn('ECHO');
  await check('stdio MCP tool runs with configured env and without host secrets', () => {
    const payload = result(list);
    assert.equal(payload.isError, false, payload.result);
    assert.ok(payload.result.includes('echo:hi'));
    assert.ok(payload.result.includes('greeting=hello'));
    for (const leaked of ['FORGE_MODEL_SECRET_CONFIG', 'FORGE_WEB_SEARCH_API_KEY', 'FORGE_RUNNER_TOKEN'])
      assert.ok(!payload.result.includes(leaked), leaked);
    assert.equal(
      list.some((event) => event.kind === 'approval_required'),
      false,
    );
  });
  list = await turn('NOTE');
  await check('MCP tools marked for confirmation ask the user every time', () => {
    const ask = list.find((event) => event.kind === 'approval_required');
    assert.equal(ask?.payload.tool, 'mcp__demo__write_note');
    assert.ok(result(list).result.includes('noted:n1'));
  });
  approval = 'deny';
  list = await turn('NOTE');
  await check('a rejected confirmation blocks the MCP call', () => {
    assert.ok(list.some((event) => event.kind === 'approval_required'));
    assert.ok(!(result(list)?.result ?? '').includes('noted:'));
  });
  list = await turn('HIDDEN');
  await check('ungranted MCP tools cannot be executed', () => {
    const payload = result(list);
    assert.ok(!payload || payload.isError);
  });
  await turn('/report-style 写一份周报');
  await check('users can invoke a skill directly with /name', () => {
    const text = JSON.stringify(requests.at(-1).messages);
    assert.ok(text.includes('skill_content'));
    assert.ok(text.includes('结论先行'));
  });
  // 下一轮移除 MCP 与联网：Runner 以新配置重启接续，工具随之消失
  list = await turn('PLAIN', { skills: [skill], mcp: [], web: null });
  await check('capability changes apply from the next turn (restart + resume)', () => {
    assert.deepEqual(toolNames(), ['current_time', 'read', 'skill']);
    const changed = list.find((event) => event.kind === 'capabilities');
    assert.deepEqual(changed?.payload.mcp, []);
    assert.equal(changed?.payload.web, null);
    // 历史仍在：之前的 echo 结果在上下文里
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('echo:hi'));
  });
  list = await turn('PLAIN');
  await check('omitting capabilities keeps the current set without restarting', () => {
    assert.equal(
      list.some((event) => event.kind === 'capabilities'),
      false,
    );
    assert.deepEqual(toolNames(), ['current_time', 'read', 'skill']);
  });
  list = await turn('PLAIN', { skills: [], mcp: [], web: null });
  await check('removing every capability drops skill and read tools', () =>
    assert.deepEqual(toolNames(), ['current_time']),
  );
  await check('materialized skill references are removed when the skill goes away', async () => {
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(dir, 'sessions', id, 'skills', 'report-style')), false);
  });
} finally {
  await kernel.dispose();
  server.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(`capability checks passed: ${passed}`);
