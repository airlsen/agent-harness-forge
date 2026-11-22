import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../skill-scripts-plugin/index.js';
import { runSkillScript } from '../skill-script-runtime/index.js';
import { resolveCapabilities } from '../src/kernel/capabilities.ts';
import { sessionToolset } from '../src/kernel/dsh-kernel.ts';

const root = await mkdtemp(join(tmpdir(), 'forge-script-check-'));
try {
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'check.py'), 'import os\nprint("ok", os.environ.get("FORGE_RUNNER_TOKEN", "not-set"))\n');
  await assert.rejects(() => runSkillScript(root, '../secret.py'), /只能运行/);
  await assert.rejects(() => runSkillScript(root, 'scripts/check.py', ['\0']), /参数无效/);
  const skills = [{ name: 'check', content: '# Check', description: 'Check', source: 'scenario', files: [{ path: 'scripts/check.py', content: 'print("ok")' }] }];
  const caps = resolveCapabilities({ skills });
  const enabled = sessionToolset({ policy: { allowedTools: ['skill_run_script'] } }, false, caps);
  assert.ok(enabled.allowed.includes('skill_run_script'));
  assert.deepEqual(enabled.approval, ['skill_run_script']);
  assert.ok(!sessionToolset({ policy: { allowedTools: [] } }, false, caps).allowed.includes('skill_run_script'));
  const tools = new Map();
  const dispose = await apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } }, {
    skills: [{ name: 'check', dir: root, scripts: ['scripts/check.py'] }],
  });
  const execute = tools.get('skill_run_script').execute;
  await assert.rejects(() => execute({ skill: 'other', path: 'scripts/check.py' }), /未授权/);
  await assert.rejects(() => execute({ skill: 'check', path: 'scripts/other.py' }), /未授权/);
  // Restricted hosts may disable user namespaces. In that case execution must fail closed.
  try {
    const result = await execute({ skill: 'check', path: 'scripts/check.py' });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /ok not-set/);
  } catch (error) {
    assert.match(error.message, /隔离运行环境不可用/);
  }
  dispose();
  console.log('PASS Skill 脚本授权、审批上限与隔离运行失败关闭');
} finally {
  await rm(root, { recursive: true, force: true });
}
