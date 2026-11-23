#!/usr/bin/env node
/**
 * 扩展能力集成检查：真实启动 dsh，装配 Skill（运行时注册 + 按修订物化的只读快照目录）、stdio MCP（本机夹具服务）
 * 与联网工具（DeepSeek 搜索 + HTTP 抓取，只检查装配，不发外部请求）。模型是本机 OpenAI 协议夹具。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fixtureManifest } from './fixtures.mjs';

const dir = await mkdtemp(join(tmpdir(), 'forge-caps-'));
process.env.FORGE_RUNNER_DATA_DIR = join(dir, 'sessions');
process.env.FORGE_CODE_ROOT = join(dir, 'code');
// 模拟宿主上的敏感变量：stdio MCP 子进程不应看到
process.env.FORGE_RUNNER_TOKEN = 'runner-token-sentinel';
const { SessionKernel } = await import('../src/kernel/session-kernel.ts');
const { sessionToolset } = await import('../src/kernel/toolset.ts');
const {
  resolveCapabilities,
  mcpPublicToolName,
  capabilitySummary,
  skillSnapshotId,
  capabilityFingerprint,
  SkillContentCache,
} = await import('../src/kernel/capabilities.ts');
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
  content: '# 报告规范\n\n标题用「周报」开头，结论先行。详见 references/glossary.md，按 assets/template.md 输出。',
  revisionId: 42,
  files: [
    { path: 'references/glossary.md', content: 'GLOSSARY-SENTINEL\n' },
    { path: 'assets/template.md', content: 'TEMPLATE-SENTINEL\n' },
  ],
  source: 'scenario',
};
// 完整原文（含 front matter）：原样写成快照目录里的 SKILL.md
skill.document = `---\nname: report-style\ndescription: "${skill.description}"\n---\n\n${skill.content}`;
const snapshotOf = (value) => skillSnapshotId(resolveCapabilities({ skills: [value] }).skills[0]);
const SNAPSHOT = snapshotOf(skill);
/** 控制面已知 Runner 有这一版时只发的引用：不带原文、正文与附件 */
const refOf = (value, snapshot = snapshotOf(value)) => {
  const { document: _d, content: _c, files: _f, ...meta } = value;
  return { ...meta, snapshot };
};
const skillDir = (snapshot = SNAPSHOT) => join(dir, 'sessions', id, 'skills', 'report-style', snapshot);
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
  for (const path of ['../x', 'references/../x.md', 'scripts/run.exe', 'references/a/b.md', 'SKILL.md', 'assets/.env'])
    assert.throws(
      () => resolveCapabilities({ skills: [{ ...skill, files: [{ path, content: '' }] }] }),
      /附加文件无效/,
      path,
    );
  assert.throws(
    () => resolveCapabilities({ skills: [{ ...skill, files: [skill.files[0], skill.files[0]] }] }),
    /附加文件无效/,
  );
  assert.equal(resolveCapabilities({ skills: [{ ...skill, files: [{ path: 'scripts/run.py', content: 'print(1)' }] }] }).skills[0].files[0].path, 'scripts/run.py');
  const big = 'x'.repeat(110_000);
  assert.throws(
    () =>
      resolveCapabilities({
        skills: [{ ...skill, files: [1, 2, 3, 4, 5].map((n) => ({ path: `assets/f${n}.md`, content: big })) }],
      }),
    /合计超过 512 KB/,
  );
  // 旧控制面的 references:[{filename,content}] 仍可用，视为 references/<filename>
  const { files: _files, ...legacySkill } = skill;
  assert.deepEqual(
    resolveCapabilities({ skills: [{ ...legacySkill, references: [{ filename: 'glossary.md', content: 'g' }] }] })
      .skills[0].files,
    [{ path: 'references/glossary.md', content: 'g' }],
  );
  // 原文与修订号可选（旧控制面不下发），下发时校验
  const { document: _document, revisionId: _revisionId, ...oldControlPlane } = skill;
  const legacy = resolveCapabilities({ skills: [oldControlPlane] }).skills[0];
  assert.equal(legacy.document, undefined);
  assert.equal(legacy.revisionId, undefined);
  assert.match(skillSnapshotId(legacy), /^0-[0-9a-f]{12}$/);
  assert.throws(() => resolveCapabilities({ skills: [{ ...skill, document: 'a\0b' }] }), /原文 无效/);
  assert.throws(() => resolveCapabilities({ skills: [{ ...skill, document: 'x'.repeat(64_001) }] }), /原文/);
  for (const revisionId of [0, -1, 1.5, '42', 2 ** 60])
    assert.throws(() => resolveCapabilities({ skills: [{ ...skill, revisionId }] }), /修订号无效/, String(revisionId));
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
await check('skill snapshot ids are content-addressed and match the control plane', () => {
  // 与 backend/tests/test_capabilities.py 的同一夹具保持一致：两端算法必须得到相同目录名
  const fixture = {
    revisionId: 7,
    document: '---\nname: demo\n---\n\n# 演示\n',
    content: '# 演示\n',
    files: [
      { path: 'references/b.md', content: 'B' },
      { path: 'assets/a.md', content: '甲' },
    ],
  };
  assert.equal(skillSnapshotId(fixture), '7-805488fce25c');
  // 文件顺序不影响结果；任一字节变化都会得到新目录
  assert.equal(skillSnapshotId({ ...fixture, files: [...fixture.files].reverse() }), '7-805488fce25c');
  assert.notEqual(skillSnapshotId({ ...fixture, document: fixture.document + ' ' }), '7-805488fce25c');
  assert.notEqual(
    skillSnapshotId({ ...fixture, files: [fixture.files[0], { path: 'assets/a.md', content: '乙' }] }),
    '7-805488fce25c',
  );
  assert.match(SNAPSHOT, /^42-[0-9a-f]{12}$/);
});
await check('skill refs resolve from a lookup; unknown snapshots ask for full content (409)', () => {
  const full = resolveCapabilities({ skills: [skill] });
  assert.equal(full.skills[0].snapshot, SNAPSHOT);
  const cache = new SkillContentCache();
  cache.remember(full.skills);
  const viaRef = resolveCapabilities({ skills: [refOf(skill)] }, (snapshot) => cache.get(snapshot));
  assert.equal(viaRef.skills[0].document, skill.document);
  assert.deepEqual(viaRef.skills[0].files, skill.files);
  // 引用与全文解析出的能力指纹相同：只发引用不会触发重启
  assert.equal(capabilityFingerprint(viaRef), capabilityFingerprint(full));
  // 已解析的集合再次传入原样返回（Runner 入口校验后，执行时不重复解析）
  assert.equal(resolveCapabilities(viaRef), viaRef);
  // 没有内容的快照：汇总后以 409 + missingSkills 抛出
  const other = { ...skill, name: 'other-style', revisionId: 9 };
  assert.throws(
    () => resolveCapabilities({ skills: [refOf(skill), refOf(other)] }, () => undefined),
    (error) =>
      error.statusCode === 409 &&
      error.code === 'SKILL_CONTENT_REQUIRED' &&
      JSON.stringify(error.missingSkills) === JSON.stringify([SNAPSHOT, snapshotOf(other)]),
  );
  // 引用必须带合法快照，且修订号与快照前缀一致；全文附带的快照必须与内容一致
  const { snapshot: _s, ...noSnapshot } = refOf(skill);
  assert.throws(() => resolveCapabilities({ skills: [noSnapshot] }), /正文 无效/);
  assert.throws(() => resolveCapabilities({ skills: [refOf(skill, '7-' + SNAPSHOT.split('-')[1])] }), /快照标识无效/);
  assert.throws(() => resolveCapabilities({ skills: [{ ...skill, snapshot: '42-000000000000' }] }), /快照标识与内容不一致/);
  assert.equal(resolveCapabilities({ skills: [{ ...skill, snapshot: SNAPSHOT }] }).skills[0].snapshot, SNAPSHOT);
});
await check('skill content cache evicts least recently used snapshots beyond its byte limit', () => {
  const cache = new SkillContentCache(250);
  const make = (revisionId) =>
    resolveCapabilities({ skills: [{ ...skill, revisionId, content: 'x'.repeat(100), document: undefined, files: [] }] })
      .skills[0];
  const [a, b, c] = [1, 2, 3].map(make);
  cache.remember([a]);
  cache.remember([b]);
  assert.ok(cache.get(a.snapshot)); // a 最近使用过
  cache.remember([c]);
  assert.equal(cache.size, 2);
  assert.ok(cache.get(a.snapshot) && cache.get(c.snapshot));
  assert.equal(cache.get(b.snapshot), undefined);
});
await check('MCP public names mirror dsh-mcp-client (normalization + hash suffix)', () => {
  assert.equal(mcpPublicToolName('demo', 'echo'), 'mcp__demo__echo');
  const odd = mcpPublicToolName('demo', 'search.docs');
  assert.match(odd, /^mcp__demo__search_docs_[a-f0-9]{12}$/);
  assert.ok(mcpPublicToolName('demo', 'x'.repeat(80)).length <= 64);
});
await check('session toolset adds skill/read, web tools and granted MCP tools only', () => {
  const toolset = sessionToolset(
    { tools: { builtin: ['current_time'] }, policy: { allowedTools: ['current_time'] } },
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
  // 没有附加文件的 Skill 不开放 read
  const plain = resolveCapabilities({ skills: [{ ...skill, files: [] }] });
  assert.equal(sessionToolset({ policy: { allowedTools: [] } }, false, plain).read, false);
});
await check('Skill workbench exposes editing tools only — no business skill snapshot', () => {
  // 编写会话不下发业务 Skill 快照（capabilities.skills 为空），因此不开放 skill / read / skill_run_script
  const workbench = sessionToolset(
    { tools: { builtin: ['skill_update_draft', 'skill_read_draft'] },
      policy: { allowedTools: ['skill_update_draft', 'skill_read_draft'] } },
    false, resolveCapabilities({ skills: [] }),
  );
  assert.ok(workbench.allowed.includes('skill_update_draft'));
  assert.ok(workbench.allowed.includes('skill_read_draft'));
  assert.ok(!workbench.allowed.includes('skill'));
  assert.ok(!workbench.allowed.includes('read'));
  assert.ok(!workbench.allowed.includes('skill_run_script'));
  assert.ok(!workbench.allowed.includes('bash'));
});
await check('summary records revision and snapshot but never leaks skill bodies, credentials, commands or env', () => {
  const summary = capabilitySummary(resolveCapabilities(caps));
  assert.equal(summary.skills[0].revisionId, 42);
  assert.equal(summary.skills[0].snapshot, SNAPSHOT);
  const text = JSON.stringify(summary);
  for (const secret of ['web-key-sentinel', 'MCP_GREETING', mcpScript, 'GLOSSARY-SENTINEL', '结论先行', 'description: '])
    assert.ok(!text.includes(secret), secret);
});
await check('system prompt explains skills, MCP confirmation and web citation rules', () => {
  const prompt = buildSystemPrompt('x', [], [], {
    skills: [{ name: 'report-style', hasFiles: true }],
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
  REFERENCE: ['read', { file_path: () => join(skillDir(), 'references', 'glossary.md') }],
  ASSET: ['read', { file_path: () => join(skillDir(), 'assets', 'template.md') }],
  MANIFEST: ['read', { file_path: () => join(skillDir(), 'SKILL.md') }],
  // 新修订装配后再读旧快照：文件仍在磁盘上，但已不在只读根内
  STALE: ['read', { file_path: () => join(skillDir(), 'references', 'glossary.md') }],
  ECHO: ['mcp__demo__echo', { text: 'hi' }],
  NOTE: ['mcp__demo__write_note', { note: 'n1' }],
  HIDDEN: ['mcp__demo__hidden', {}],
};
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  // dsh 注入的会话上下文（工作目录等）也以 user 角色发送，0.2.2-rc.5 起为 <system-reminder> 包装
  const lastUser = body.messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      typeof message.content === 'string' &&
      !message.content.startsWith('<system-reminder>'),
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
const manifest = fixtureManifest({
  systemPrompt: { identity: 'Capability contract test.' },
  tools: { builtin: ['current_time'] },
  policy: {
    allowedTools: ['current_time'],
    requestTimeoutSeconds: 20,
    approvalTimeoutSeconds: 5,
    maxOutputTokens: 512,
  },
});
const kernel = new SessionKernel();
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
  await kernel.sendTurn(id, text, undefined, undefined, capabilities);
  return events.slice(start);
}
const result = (list) => list.find((event) => event.kind === 'tool_result')?.payload;
try {
  const handle = await kernel.createSession(
    manifest,
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
    const replay = kernel.eventsAfter(id, 0);
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
  await check('skill tool loads the registered body and points at the versioned snapshot directory', () => {
    const payload = result(list);
    assert.equal(payload.isError, false);
    assert.ok(payload.result.includes('结论先行'));
    assert.ok(payload.result.includes(skillDir()));
  });
  await check('snapshot directory is byte-identical to the revision (SKILL.md + files, read-only)', async () => {
    const { statSync } = await import('node:fs');
    assert.equal(await readFile(join(skillDir(), 'SKILL.md'), 'utf8'), skill.document);
    for (const file of skill.files) assert.equal(await readFile(join(skillDir(), file.path), 'utf8'), file.content);
    assert.equal(statSync(join(skillDir(), 'SKILL.md')).mode & 0o777, 0o400);
  });
  list = await turn('REFERENCE');
  await check('skill references are readable through read (read-only root)', () => {
    const payload = result(list);
    assert.equal(payload.isError, false, payload.result);
    assert.ok(payload.result.includes('GLOSSARY-SENTINEL'));
  });
  list = await turn('ASSET');
  await check('skill assets are materialized next to references (full directory)', async () => {
    const payload = result(list);
    assert.equal(payload.isError, false, payload.result);
    assert.ok(payload.result.includes('TEMPLATE-SENTINEL'));
    const { statSync } = await import('node:fs');
    const file = join(skillDir(), 'assets', 'template.md');
    assert.equal(statSync(file).mode & 0o777, 0o400);
  });
  list = await turn('MANIFEST');
  await check('SKILL.md in the snapshot is readable as the original document', () => {
    const payload = result(list);
    assert.equal(payload.isError, false, payload.result);
    assert.ok(payload.result.includes('name: report-style'));
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
    assert.equal(changed?.payload.skills[0].snapshot, SNAPSHOT);
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
  list = await turn('REFERENCE', { skills: [refOf(skill)], mcp: [], web: null });
  await check('a snapshot ref (no body, no files) reuses the content Runner already has without restarting', () => {
    assert.equal(
      list.some((event) => event.kind === 'capabilities'),
      false,
    );
    const payload = result(list);
    assert.equal(payload.isError, false, payload.result);
    assert.ok(payload.result.includes('GLOSSARY-SENTINEL'));
  });
  await check('refs resolve across sessions from the Runner cache; unknown snapshots are rejected with 409', () => {
    assert.equal(kernel.resolveTurnCapabilities({ skills: [refOf(skill)] }).skills[0].content, skill.content);
    assert.throws(
      () => kernel.resolveTurnCapabilities({ skills: [refOf(skill, '42-000000000000')] }, id),
      (error) => error.statusCode === 409 && error.missingSkills[0] === '42-000000000000',
    );
    // 新进程（缓存为空）只收到引用：同样要求补发全文
    assert.throws(
      () => new SessionKernel().resolveTurnCapabilities({ skills: [refOf(skill)] }),
      (error) => error.statusCode === 409 && error.missingSkills[0] === SNAPSHOT,
    );
  });
  // 发布新修订：新快照目录，旧快照保留在磁盘上但模型不可再读
  const revised = {
    ...skill,
    revisionId: 43,
    document: skill.document.replace('结论先行', '结论先行（第二版）'),
    content: skill.content.replace('结论先行', '结论先行（第二版）'),
  };
  const NEXT = snapshotOf(revised);
  list = await turn('STALE', { skills: [revised], mcp: [], web: null });
  await check('a new revision gets a new snapshot; the old snapshot stays on disk but is no longer readable', async () => {
    const { existsSync } = await import('node:fs');
    assert.match(NEXT, /^43-[0-9a-f]{12}$/);
    assert.equal(list.find((event) => event.kind === 'capabilities')?.payload.skills[0].snapshot, NEXT);
    assert.equal(await readFile(join(skillDir(NEXT), 'SKILL.md'), 'utf8'), revised.document);
    assert.ok(existsSync(join(skillDir(SNAPSHOT), 'references', 'glossary.md')));
    const payload = result(list);
    assert.ok(!payload || payload.isError, payload?.result);
    assert.ok(!(payload?.result ?? '').includes('GLOSSARY-SENTINEL'));
  });
  // 只有 SKILL.md 的 Skill：同样有快照目录与目录型 resourceBase，但不开放 read
  const bare = { ...revised, files: [] };
  list = await turn('SKILL', { skills: [bare], mcp: [], web: null });
  await check('a skill with only SKILL.md still gets a snapshot directory', async () => {
    const payload = result(list);
    assert.equal(payload.isError, false, payload.result);
    assert.ok(payload.result.includes(skillDir(snapshotOf(bare))));
    assert.equal(await readFile(join(skillDir(snapshotOf(bare)), 'SKILL.md'), 'utf8'), bare.document);
    assert.deepEqual(toolNames(), ['current_time', 'skill']);
  });
  list = await turn('PLAIN', { skills: [], mcp: [], web: null });
  await check('removing every capability drops skill and read tools', () =>
    assert.deepEqual(toolNames(), ['current_time']),
  );
} finally {
  await kernel.dispose();
  server.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(`capability checks passed: ${passed}`);
