#!/usr/bin/env node
/**
 * dsh 插件契约检查（ADR-1 风险阀门）：升级 dsh 版本前后各跑一次。
 * 校验"我们依赖的官方扩展点仍存在且形状未变"。
 * 检查清单直接取自 DSH 适配层（src/kernel/dsh/）与平台契约（contracts/platform.json）的声明，
 * 适配层新增依赖时这里自动覆盖，不需要再手工同步。
 */

import { readFile } from 'node:fs/promises';
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
  'dsh-sdk-minimal',
  'dsh-headless',
  'dsh-tools',
  'dsh-llm',
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

const llmIdx = await readFile(join(DSH, 'dsh-llm/lib/types/index.d.ts'), 'utf8').catch(() => '');
check('ctx.llm.registerAdapter 存在', llmIdx.includes('registerAdapter'));
check('LlmAdapter 抽象类存在', llmIdx.includes('abstract class LlmAdapter'));

const approval = await readFile(join(DSH, 'dsh-user-approval/lib/types/index.d.ts'), 'utf8').catch(() => '');
check('ctx.approval 服务存在', approval.includes('approval: ApprovalService'));
check('审批策略 ask/never 存在', approval.includes("'ask'") && approval.includes("'never'"));

const { SDK_METHODS } = await import('../src/kernel/dsh/protocol.ts');
const { DSH_PACKAGES, ENGINE_TOOL_PROVIDERS } = await import('../src/kernel/dsh/runtime-config.ts');
const { PLATFORM } = await import('../src/kernel/platform-contract.ts');

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
for (const [tool, pkg] of providers) {
  const source = await readFile(join(ROOT, 'node_modules', pkg, 'lib', 'index.js'), 'utf8').catch(() => '');
  check(`工具 ${tool} 由 ${pkg} 提供`, source.includes(`'${tool}'`) || source.includes(`"${tool}"`));
}
check('服务端身份 deepseek-harness-sdk-runtime', proto.includes('deepseek-harness-sdk-runtime'));

// 5. 适配层写给 dsh 插件的每个配置项，插件的配置定义里仍然有。
//    dsh 遇到不认识的配置项不报错、静默忽略（如 0.2.2-rc.5 把 Search API 的 apiKeyEnv 改为 searchApiKeyEnv），
//    所以按全部分支各造一份装配需求生成 patch，逐项对照插件导出的 Config。
const { buildRuntimePatch } = await import('../src/kernel/dsh/runtime-config.ts');
const { GROUP_TOOLS } = await import('../src/kernel/toolset.ts');
const local = (id) => ({ id, entry: join(ROOT, 'internal-plugins', id, 'index.js'), config: {} });
const basePlan = {
  sessionLogDir: '/tmp/contract-sessions',
  contextWindow: 128000,
  outputTokens: 8192,
  allowed: Object.values(GROUP_TOOLS).flat(),
  search: true,
  read: true,
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
  const patch = buildRuntimePatch({ ...basePlan, read: web !== null, web }, GROUP_TOOLS);
  return patch.flatMap((row) => row.insert ?? [row]);
});
// 内置插件（只给 id 不给包名）的 id → 包名，取自 sdk-minimal 的装配清单
const profile = await readFile(join(DSH, 'dsh-sdk-minimal/cordis.patch.yml'), 'utf8');
const builtin = new Map([...profile.matchAll(/- id: ([\w-]+)\s+name: '([^']+)'/g)].map((m) => [m[1], m[2]]));
const configKeys = async (pkg) => {
  const mod = await import(pkg).catch(() => null);
  const schema = mod?.Config ?? mod?.default?.Config;
  const members = schema?.type === 'union' ? schema.list : [schema];
  if (!members.every((member) => member?.dict)) return null;
  return members.map((member) => new Set(Object.keys(member.dict)));
};
const seen = new Set();
for (const row of rows) {
  const pkg = row.name ?? builtin.get(row.id);
  if (!row.name && !seen.has(row.id)) {
    seen.add(row.id);
    check(`内置插件 id ${row.id} 仍在 dsh-sdk-minimal 装配清单中`, builtin.has(row.id));
  }
  if (!pkg?.startsWith('@deepseek-ai/') || !row.config) continue;
  const label = `${pkg} 配置项 ${Object.keys(row.config).sort().join('、')}`;
  if (seen.has(label)) continue;
  seen.add(label);
  const schemas = await configKeys(pkg);
  if (!schemas) {
    check(label, false, '读不到插件导出的 Config 定义');
    continue;
  }
  // 联合类型（如 mcp-client 的 stdio / http）只要有一种形态认识全部配置项即可
  const misses = schemas.map((keys) => Object.keys(row.config).filter((key) => !keys.has(key)));
  const best = misses.reduce((a, b) => (b.length < a.length ? b : a));
  check(label, best.length === 0, best.length ? `插件不认识：${best.join('、')}` : '');
}

console.log(`\n契约检查：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
