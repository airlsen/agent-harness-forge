#!/usr/bin/env node
/**
 * dsh 插件契约检查（ADR-1 风险阀门）：升级 dsh 版本前后各跑一次。
 * 校验"我们依赖的官方扩展点仍存在且形状未变"。
 * 检查清单直接取自 DSH 适配层（src/kernel/dsh/）与平台契约（contracts/platform.json）的声明，
 * 适配层新增依赖时这里自动覆盖，不需要再手工同步。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DSH = join(ROOT, 'node_modules', '@deepseek-ai');

let pass = 0,
  fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// 1. 关键包在位
for (const pkg of [
  'dsh',
  'dsh-sdk-protocol',
  'dsh-sdk-app',
  'dsh-base',
  'dsh-headless',
  'dsh-tools',
  'dsh-llm-pi-ai',
  'dsh-user-approval',
]) {
  const exists = await readFile(join(DSH, pkg, 'package.json'), 'utf8')
    .then(() => true)
    .catch(() => false);
  check(`包在位 @deepseek-ai/${pkg}`, exists);
}

// 2. 扩展点形状（源码级）
const toolsEvents = await readFile(join(DSH, 'dsh-tools/lib/types/events.d.ts'), 'utf8').catch(() => '');
check("'tools/pre-execute' 瀑布存在", toolsEvents.includes("'tools/pre-execute'"));
check("'tools/execute' 瀑布存在", toolsEvents.includes("'tools/execute'"));

// 模型出口：llm-pi-ai 的 OpenAI 兼容协议（modelRow 的 api）；实时输出：agent 的流式片段广播（forge-runtime/live-stream.js）
const { supportedProtocols } = await import('@deepseek-ai/dsh-llm-pi-ai');
check('llm-pi-ai 支持 openai-completions 协议', supportedProtocols().includes('openai-completions'));
const agentTypes = await readFile(join(DSH, 'dsh-agent/lib/types/runtime-types.d.ts'), 'utf8').catch(() => '');
check("agent 事件 'agent/assistant-stream' 存在", agentTypes.includes("'agent/assistant-stream'"));

const approval = await readFile(join(DSH, 'dsh-user-approval/lib/types/index.d.ts'), 'utf8').catch(() => '');
check('ctx.approval 服务存在', approval.includes('approval: ApprovalService'));
check('审批策略 ask/never 存在', approval.includes("'ask'") && approval.includes("'never'"));

const { SDK_METHODS } = await import('../src/kernel/dsh/protocol.ts');
const { DeepSeekHarness, HarnessClient } = await import('@deepseek-ai/dsh-sdk-client');
for (const method of ['start', 'run', 'resumeSession', 'close'])
  check(`官方 DeepSeekHarness.${method} 可用`, typeof DeepSeekHarness.prototype[method] === 'function');
for (const method of ['start', 'onRequest', 'subscribe'])
  check(`官方 HarnessClient.${method} 可用`, typeof HarnessClient.prototype[method] === 'function');
const { DSH_PACKAGES, ENGINE_TOOL_PROVIDERS } = await import('../src/kernel/dsh/runtime-config.ts');
const { PLATFORM } = await import('../src/kernel/platform-contract.ts');
const { GROUP_TOOLS } = await import('../src/kernel/toolset.ts');

const proto = await readFile(join(DSH, 'dsh-sdk-protocol/lib/types/types.d.ts'), 'utf8').catch(() => '');
for (const m of SDK_METHODS) {
  check(`SDK 方法 ${m}`, proto.includes(`'${m}'`));
}

// 3. 适配层挂载的每个包都已安装（dsh 拆包、改名时立即发现）
for (const pkg of new Set(DSH_PACKAGES)) {
  const exists = await readFile(join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')
    .then(() => true)
    .catch(() => false);
  check(`适配层依赖 ${pkg}`, exists);
}

// 4. 工具仍由声明的包提供：平台契约中 provider 为 dsh 包的工具 + 适配层使用的 dsh 原生工具
const providers = [
  ...PLATFORM.tools
    .filter((tool) => tool.provider.startsWith('@deepseek-ai/'))
    .map((tool) => [tool.name, tool.provider]),
  ...Object.entries(ENGINE_TOOL_PROVIDERS),
];
const checkedTools = new Set();
for (const [tool, pkg] of providers) {
  if (checkedTools.has(`${tool}@${pkg}`)) continue;
  checkedTools.add(`${tool}@${pkg}`);
  const source = await readFile(join(ROOT, 'node_modules', pkg, 'lib', 'index.js'), 'utf8').catch(() => '');
  check(`工具 ${tool} 由 ${pkg} 提供`, source.includes(`'${tool}'`) || source.includes(`"${tool}"`));
}
check('服务端身份 deepseek-harness-sdk-runtime', proto.includes('deepseek-harness-sdk-runtime'));

// 5. sdk 底座的每个内置插件都已归类，适配层写给插件的每个配置项插件仍然认识。
//    sdk profile 的完整装配清单（dsh-base + dsh-sdk-app 补丁）直接让 dsh 自己展开，不手工解析补丁文件。
const { DSH_PROFILE } = await import('../src/kernel/dsh/protocol.ts');
const { SDK_KEPT, SDK_SWITCHED, SDK_OFF, buildRuntimePatch } = await import('../src/kernel/dsh/runtime-config.ts');
const dshHome = mkdtempSync(join(tmpdir(), 'forge-contract-dsh-'));
let composed = '';
try {
  composed = execFileSync(
    process.execPath,
    [join(DSH, 'dsh', 'lib', 'bin.js'), '--profile', DSH_PROFILE, '--dump-default-config'],
    { env: { ...process.env, DSH_HOME: dshHome }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
} catch (error) {
  check(`展开 ${DSH_PROFILE} profile 装配清单`, false, error.message);
} finally {
  rmSync(dshHome, { recursive: true, force: true });
}
const builtin = new Map([...composed.matchAll(/^- id: ([\w-]+)\n {2}name: '([^']+)'/gm)].map((m) => [m[1], m[2]]));
check(`${DSH_PROFILE} profile 展开出内置插件`, builtin.size > 50, `${builtin.size} 个`);
// 三张表互不重叠，且覆盖 sdk 的全部内置插件：升级带来没归类的新插件、或旧插件被移除，都在这里报出来
const tables = { SDK_KEPT, SDK_SWITCHED: Object.keys(SDK_SWITCHED), SDK_OFF };
const owner = new Map();
for (const [table, ids] of Object.entries(tables))
  for (const id of ids) {
    if (owner.has(id)) check(`插件 ${id} 只归入一张表`, false, `同时在 ${owner.get(id)} 与 ${table}`);
    owner.set(id, table);
  }
const unclassified = [...builtin.keys()].filter((id) => !owner.has(id));
check(
  `sdk 的每个内置插件都已归入 SDK_KEPT / SDK_SWITCHED / SDK_OFF`,
  unclassified.length === 0,
  unclassified.length ? `未归类：${unclassified.join('、')}（请在 runtime-config.ts 中决定保留、按能力开关还是关闭）` : '',
);
const vanished = [...owner.keys()].filter((id) => !builtin.has(id));
check(
  '归类表里的插件 id 都仍在 sdk 装配清单中',
  vanished.length === 0,
  vanished.length ? `已不存在：${vanished.join('、')}` : '',
);

// 按全部分支各造一份装配需求生成 patch，逐项对照插件导出的 Config。
// dsh 遇到不认识的配置项不报错、静默忽略（如 0.2.2-rc.5 把 Search API 的 apiKeyEnv 改为 searchApiKeyEnv）。
const local = (id) => ({ id, entry: join(ROOT, 'internal-plugins', id, 'index.js'), config: {} });
const basePlan = {
  sessionLogDir: '/tmp/contract-sessions',
  spillDir: '/tmp/contract-spill',
  workspace: '/tmp/contract-workspace',
  contextWindow: 128000,
  outputTokens: 8192,
  model: { id: 'contract-model', baseUrl: 'https://example.com/v1', requestTimeoutMs: 300000 },
  allowed: Object.values(GROUP_TOOLS).flat(),
  sandbox: 'workspace-write',
  runtime: local('forge-runtime'),
  plugins: [],
  skills: { plugin: local('forge-skills') },
  mcp: {
    cwd: '/tmp',
    servers: [
      { serverName: 'stdio_probe', transport: 'stdio', command: 'node', args: [], env: {} },
      { serverName: 'http_probe', transport: 'streamable-http', url: 'https://example.com/mcp', headers: {} },
    ],
  },
};
const webVariants = ['deepseek-official', 'deepseek-search-api'].map((provider) => ({
  search: true,
  fetch: true,
  provider,
  baseUrl: 'https://example.com/v1',
  source: 'scenario',
}));
const rows = [null, ...webVariants].flatMap((web) => {
  const patch = buildRuntimePatch({ ...basePlan, web }, GROUP_TOOLS);
  return patch.flatMap((row) => row.insert ?? [row]);
});
// DeepSeek 模型：模型路由另带 DeepSeek 思考格式的兼容项
rows.push(
  ...buildRuntimePatch(
    { ...basePlan, model: { ...basePlan.model, id: 'deepseek-chat' }, web: null },
    GROUP_TOOLS,
  ).filter((row) => row.id === 'llm-pi-ai'),
);
// 能力全关的会话：只读沙箱、没有任何可选能力
rows.push(
  ...buildRuntimePatch({ ...basePlan, allowed: [], sandbox: 'read-only', skills: null, mcp: { cwd: '/tmp', servers: [] }, web: null }, GROUP_TOOLS).flatMap(
    (row) => row.insert ?? [row],
  ),
);
const configSchema = async (pkg) => {
  const mod = await import(pkg).catch(() => null);
  const schema = mod?.Config ?? mod?.default?.Config;
  const members = schema?.type === 'union' ? schema.list : [schema];
  return members.every((member) => member?.dict) ? schema : null;
};
/**
 * 配置里插件不认识的字段（逐层核对：对象、字典、数组、联合类型），返回字段路径。
 * 例如模型路由 providers.forge.models[0].compat 里写错的兼容项也能查出来。
 */
function unknownKeys(value, schema, path = '') {
  if (!schema || value === null || typeof value !== 'object') return [];
  if (schema.type === 'union')
    return schema.list
      .map((member) => unknownKeys(value, member, path))
      .reduce((a, b) => (b.length < a.length ? b : a));
  if (schema.type === 'dict')
    return Object.entries(value).flatMap(([key, item]) => unknownKeys(item, schema.inner, `${path}.${key}`));
  if (schema.type === 'array' && Array.isArray(value))
    return value.flatMap((item, index) => unknownKeys(item, schema.inner, `${path}[${index}]`));
  if (!schema.dict) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    Object.hasOwn(schema.dict, key)
      ? unknownKeys(item, schema.dict[key], path ? `${path}.${key}` : key)
      : [path ? `${path}.${key}` : key],
  );
}
const seen = new Set();
for (const row of rows) {
  const pkg = row.name ?? builtin.get(row.id);
  if (!row.name && !seen.has(row.id)) {
    seen.add(row.id);
    check(`patch 引用的内置插件 id ${row.id} 仍在 ${DSH_PROFILE} 装配清单中`, builtin.has(row.id));
  }
  if (!pkg?.startsWith('@deepseek-ai/') || !row.config) continue;
  const label = `${pkg} 配置项 ${Object.keys(row.config).sort().join('、')}${
    row.id === 'llm-pi-ai' && JSON.stringify(row.config).includes('"deepseek"') ? '（DeepSeek 路由）' : ''
  }`;
  if (seen.has(label)) continue;
  seen.add(label);
  const schema = await configSchema(pkg);
  if (!schema) {
    check(label, false, '读不到插件导出的 Config 定义');
    continue;
  }
  // 联合类型（如 mcp-client 的 stdio / http）只要有一种形态认识全部配置项即可
  const misses = unknownKeys(row.config, schema);
  check(label, misses.length === 0, misses.length ? `插件不认识：${misses.join('、')}` : '');
}

// 6. 所有 dsh 包同一版本、每个 @deepseek-ai 包只装一份。
//    升级时漏改某个版本号，npm 会把同一模块装出两份不同版本：Forge 插件直接引用的 dsh 包
//    与 dsh 用到的不是同一份，问题隐蔽且难查。基准是 package.json 中 @deepseek-ai/dsh 的锁定版本；
//    cordis、schemastery 等 @deepseek-ai 通用库版本独立，只要求不重复。
const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const pinned = manifest.dependencies['@deepseek-ai/dsh'];
const isDsh = (name) => /^@deepseek-ai\/dsh(-|$)/.test(name);
const drifted = Object.entries(manifest.dependencies).filter(
  ([name, version]) => isDsh(name) && version !== pinned,
);
check(
  `package.json 中 dsh 包都锁定为 ${pinned}`,
  drifted.length === 0,
  drifted.map(([name, version]) => `${name}@${version}`).join('、'),
);
const installed = new Map();
const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
for (const [path, entry] of Object.entries(lock.packages)) {
  const name = /node_modules\/(@deepseek-ai\/[^/]+)$/.exec(path)?.[1];
  if (name) installed.set(name, [...(installed.get(name) ?? []), entry.version]);
}
const dshNames = [...installed.keys()].filter(isDsh);
const offVersion = dshNames.filter((name) => installed.get(name).some((version) => version !== pinned));
check(
  `锁文件中 ${dshNames.length} 个 dsh 包都是 ${pinned}`,
  dshNames.length > 0 && offVersion.length === 0,
  offVersion.map((name) => `${name}@${installed.get(name).join('/')}`).join('、'),
);
const duplicated = [...installed].filter(([, versions]) => versions.length > 1);
check(
  '每个 @deepseek-ai 包只装一份',
  duplicated.length === 0,
  duplicated.map(([name, versions]) => `${name}（${versions.join('、')}）`).join('；'),
);
const actual = JSON.parse(await readFile(join(DSH, 'dsh', 'package.json'), 'utf8')).version;
check(
  `实际安装的 dsh 与锁定版本一致`,
  actual === pinned,
  actual === pinned ? '' : `node_modules 中为 ${actual}，请重新 npm ci`,
);

console.log(`\n契约检查：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
