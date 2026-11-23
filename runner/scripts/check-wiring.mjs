/**
 * 装配一致性检查（不启动 dsh、不调用模型）：几张「唯一登记表」之间是否对得上。
 * - 插件登记表（src/kernel/forge-plugins.ts）：入口存在，导出的 name 与登记名一致；
 * - 平台契约（contracts/platform.json）：provider 为 Forge 插件的工具确实由该插件注册，
 *   该插件注册的工具也都登记在契约里（dsh 包提供的工具由 npm run contract 核对）；
 * - 插件事件表（plugin-kit/events.js）：插件源码里出现的每个 forge.* 都已登记，登记的每个事件都能被翻译，
 *   未登记的 forge.* 会告警而不是静默丢弃；
 * - dsh 原生工具表（src/kernel/dsh/engine-tools.js）：与契约、内核工具集一致。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FORGE_EVENTS, FORGE_EVENT_PREFIX } from '../plugin-kit/events.js';
import { ENGINE_TOOLS, PATH_TOOLS } from '../src/kernel/dsh/engine-tools.js';
import { translateNotification } from '../src/kernel/dsh/protocol.ts';
import { FORGE_PLUGINS, MANIFEST_PLUGINS, forgePluginEntry } from '../src/kernel/forge-plugins.ts';
import { COMPANION_TOOLS, PLATFORM } from '../src/kernel/platform-contract.ts';
import { CODE_READ_TOOL, SEARCH_TOOLS, sessionToolset } from '../src/kernel/toolset.ts';

let checks = 0;
const check = async (name, fn) => {
  await fn();
  checks += 1;
  console.log('PASS', name);
};
const isDshPackage = (provider) => provider.startsWith('@deepseek-ai/');
const pluginNames = Object.keys(FORGE_PLUGINS);
const modules = new Map();
for (const name of pluginNames) modules.set(name, await import(pathToFileURL(forgePluginEntry(name)).href));

/** 用最小的假 ctx 装配一个插件，返回它注册的工具名（与 check-workspace 的装配方式一致） */
async function registeredTools(name, workspace) {
  const tools = [];
  const ctx = {
    llm: { registerAdapter: () => () => {} },
    tools: {
      register: (tool) => {
        tools.push(tool.name);
        return () => {};
      },
      guard: () => () => {},
    },
    skills: { register: () => () => {} },
    approval: {},
    on: () => () => {},
  };
  const dispose = await modules.get(name).apply(ctx, { workspace, allowedTools: [], skills: [] });
  if (typeof dispose === 'function') dispose();
  return tools;
}

const dir = await mkdtemp(join(tmpdir(), 'forge-wiring-'));
const previousModel = process.env.FORGE_MODEL_SECRET_CONFIG;
process.env.FORGE_MODEL_SECRET_CONFIG = JSON.stringify({
  baseUrl: 'http://127.0.0.1:9',
  model: 'wiring-check',
});
try {
  await check('every registered Forge plugin exists and exports its registered name', () => {
    for (const name of pluginNames) {
      assert.ok(existsSync(forgePluginEntry(name)), `${name} 入口不存在`);
      const mod = modules.get(name);
      assert.equal(mod.name, name, `${FORGE_PLUGINS[name].dir} 导出的 name 应为 ${name}`);
      assert.equal(typeof mod.apply, 'function', `${name} 缺少 apply`);
    }
    assert.ok(MANIFEST_PLUGINS.has('forge-runtime'));
    assert.ok(!MANIFEST_PLUGINS.has('forge-skills'), '自动装配的插件不应出现在清单白名单里');
    assert.ok(
      pluginNames.every((name) => !isDshPackage(name)),
      'dsh 官方包不进插件登记表',
    );
  });

  await check('contract tools provided by Forge plugins are actually registered by them', async () => {
    const providers = new Set(PLATFORM.tools.map((tool) => tool.provider).filter((p) => !isDshPackage(p)));
    for (const provider of providers) {
      assert.ok(Object.hasOwn(FORGE_PLUGINS, provider), `契约中的 provider ${provider} 不在插件登记表中`);
      const registered = await registeredTools(provider, join(dir, provider));
      const declared = PLATFORM.tools.filter((tool) => tool.provider === provider).map((tool) => tool.name);
      for (const tool of declared)
        assert.ok(registered.includes(tool), `契约声明 ${tool} 由 ${provider} 提供，但该插件没有注册它`);
      for (const tool of registered)
        assert.ok(
          declared.includes(tool),
          `${provider} 注册了 ${tool}，但契约中没有登记（平台策略无法管控）`,
        );
    }
  });

  await check('companion tools open with their leader and stay out of the policy list', () => {
    assert.deepEqual(COMPANION_TOOLS, { workspace_write: ['workspace_present'] });
    const withWrite = sessionToolset({ policy: { allowedTools: ['workspace_write'] } }).allowed;
    assert.ok(withWrite.includes('workspace_present'));
    const readOnly = sessionToolset({ policy: { allowedTools: ['workspace_read'] } }).allowed;
    assert.ok(!readOnly.includes('workspace_present'));
  });

  await check('dsh engine tool table agrees with the contract and the kernel toolset', () => {
    const shell = PLATFORM.tools.find((tool) => tool.name === ENGINE_TOOLS.shell);
    assert.ok(shell && isDshPackage(shell.provider), '终端工具应登记在契约中且由 dsh 包提供');
    assert.deepEqual(SEARCH_TOOLS, ENGINE_TOOLS.search);
    assert.equal(CODE_READ_TOOL, ENGINE_TOOLS.read);
    assert.deepEqual(
      Object.keys(PATH_TOOLS).toSorted(),
      [...ENGINE_TOOLS.search, ENGINE_TOOLS.read].toSorted(),
    );
    for (const name of ENGINE_TOOLS.search) assert.ok(PATH_TOOLS[name].search && PATH_TOOLS[name].results);
  });

  await check('every forge.* event used in plugin sources is registered', async () => {
    const used = new Set();
    const scan = async (path) => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = join(path, entry.name);
        if (entry.isDirectory()) await scan(full);
        else if (entry.name.endsWith('.js'))
          for (const match of (await readFile(full, 'utf8')).matchAll(/['"`](forge\.[a-z_]+)['"`]/g))
            used.add(match[1]);
      }
    };
    for (const name of pluginNames) await scan(join(forgePluginEntry(name), '..'));
    assert.ok(used.size >= 8, `只扫描到 ${used.size} 个事件，扫描范围可能不对`);
    for (const method of used)
      assert.ok(Object.hasOwn(FORGE_EVENTS, method), `插件发出未登记的事件 ${method}`);
  });

  await check('every registered event translates; unknown forge.* events warn instead of vanishing', () => {
    for (const [method, spec] of Object.entries(FORGE_EVENTS)) {
      assert.ok(method.startsWith(FORGE_EVENT_PREFIX));
      const out = translateNotification(method, { message: 'x', path: 'a.md' }, new Map());
      assert.equal(out.length, 1, `${method} 没有被翻译`);
      if (spec.kind === 'failure') assert.deepEqual(out[0], { failure: 'x', explicit: true });
      else if (spec.kind === 'files')
        assert.deepEqual(out[0].payload, { files: [{ message: 'x', path: 'a.md' }] });
      else assert.equal(out[0].kind, spec.kind);
    }
    const warnings = [];
    const warn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      assert.deepEqual(translateNotification('forge.not_registered', {}, new Map()), []);
      assert.deepEqual(translateNotification('forge.not_registered', {}, new Map()), []);
      assert.deepEqual(translateNotification('something.else', {}, new Map()), []);
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1, '同一个未登记事件只告警一次，非 forge.* 不告警');
    assert.match(warnings[0], /forge\.not_registered/);
  });
} finally {
  if (previousModel === undefined) delete process.env.FORGE_MODEL_SECRET_CONFIG;
  else process.env.FORGE_MODEL_SECRET_CONFIG = previousModel;
  await rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ scope: 'plugin / contract / event wiring, no dsh', checks, result: 'passed' }));
