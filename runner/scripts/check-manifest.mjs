#!/usr/bin/env node
/** 会话清单检查：生成的类型与 Schema 同步；入口校验拒绝错版本与残缺清单；早期 Bundle 形状不再被接受。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render } from './gen-manifest-types.mjs';
import { fixtureManifest } from './fixtures.mjs';
import { MANIFEST_VERSION, parseManifest } from '../src/kernel/manifest.ts';

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}

const generated = new URL('../src/kernel/manifest.generated.ts', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('../../contracts/session-manifest.schema.json', import.meta.url), 'utf8'));

const fresh = await render();
check('generated manifest types match the committed schema', () =>
  assert.equal(readFileSync(generated, 'utf8'), fresh, 'manifest.generated.ts 已过期：请执行 make contracts'),
);

check('runner supports exactly the schema manifest version', () =>
  assert.equal(schema.properties.version.const, MANIFEST_VERSION),
);

check('a complete manifest passes through unchanged', () => {
  const manifest = fixtureManifest({ tools: { builtin: ['todo_write'] } });
  assert.equal(parseManifest(manifest), manifest);
});

const rejects = (input, pattern) => {
  assert.throws(
    () => parseManifest(input),
    (error) => error.statusCode === 422 && pattern.test(error.message),
  );
};
check('other manifest versions are rejected with an upgrade hint', () => {
  rejects({ ...fixtureManifest(), version: 2 }, /版本 2 不受支持.*同步升级/);
  rejects({ ...fixtureManifest(), version: undefined }, /版本 undefined/);
});
check('missing or malformed fields are named in the error', () => {
  rejects(undefined, /缺少会话清单/);
  rejects({ ...fixtureManifest(), systemPrompt: {} }, /systemPrompt/);
  rejects({ ...fixtureManifest(), tools: { builtin: 'current_time', plugin: [] } }, /tools/);
  rejects({ ...fixtureManifest(), pluginBindings: [null], policyRef: 1 }, /pluginBindings、policyRef/);
});
check('the legacy bundle shape is no longer accepted', () => {
  rejects(
    { profile_patch: { systemPrompt: { identity: 'x' } }, plugin_mounts: ['forge-runtime'], policy_ref: 'p', meta: {} },
    /版本 undefined/,
  );
});
console.log(JSON.stringify({ checks: checks.length, result: 'passed' }));
