import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../internal-plugins/skill-scripts/index.js';
import { OUTPUTS_DIR, resetSandboxProbe, runSkillScript, sandboxMode } from '../internal-plugins/shared/skill-script-runtime/index.js';
import { resolveCapabilities } from '../src/kernel/capabilities.ts';
import { sessionToolset } from '../src/kernel/toolset.ts';

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
  // 与 bash 同等对待：直接执行，不进入逐次确认清单
  assert.deepEqual(enabled.approval, []);
  assert.ok(!sessionToolset({ policy: { allowedTools: [] } }, false, caps).allowed.includes('skill_run_script'));
  const tools = new Map();
  const dispose = await apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } }, {
    skills: [{ name: 'check', dir: root, scripts: ['scripts/check.py'] }],
  });
  const execute = tools.get('skill_run_script').execute;
  await assert.rejects(() => execute({ skill: 'other', path: 'scripts/check.py' }), /未授权/);
  await assert.rejects(() => execute({ skill: 'check', path: 'scripts/other.py' }), /未授权/);
  // 默认 auto：有 bubblewrap 时隔离运行，宿主不支持时直接运行并在结果中说明
  const result = await execute({ skill: 'check', path: 'scripts/check.py' });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ok not-set/);
  if (!result.isolated) assert.match(result.note, /隔离环境不可用/);
  dispose();

  // 运行方式配置：非法取值按 auto；bwrap 模式不可用时失败关闭，不回退直接运行
  assert.equal(sandboxMode({}), 'auto');
  assert.equal(sandboxMode({ FORGE_SKILL_SCRIPT_SANDBOX: ' NONE ' }), 'none');
  assert.equal(sandboxMode({ FORGE_SKILL_SCRIPT_SANDBOX: 'off' }), 'auto');
  const direct = await runSkillScript(root, 'scripts/check.py', [], { mode: 'none' });
  assert.equal(direct.isolated, false);
  assert.equal(direct.note, undefined);
  resetSandboxProbe();
  try {
    const strict = await runSkillScript(root, 'scripts/check.py', [], { mode: 'bwrap' });
    assert.equal(strict.isolated, true);
  } catch (error) {
    assert.match(error.message, /隔离运行环境不可用/);
  }

  // 产出保留在会话工作区 outputs/<脚本名>-<时间>/；没有产出时不留下空目录
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(
    join(root, 'scripts', 'report.py'),
    'import os, sys\nopen("report.txt", "w").write(sys.argv[1])\nos.makedirs("data")\nopen(os.path.join(os.environ["FORGE_OUTPUT_DIR"], "data", "rows.csv"), "w").write("a,b\\n")\nprint(os.path.isdir(os.environ["FORGE_SKILL_DIR"]))\n',
  );
  const kept = await runSkillScript(root, 'scripts/report.py', ['hello'], { outputRoot: workspace, mode: 'none' });
  assert.equal(kept.exitCode, 0, kept.stderr);
  assert.match(kept.stdout, /True/);
  assert.match(kept.outputDir, new RegExp(`^${OUTPUTS_DIR}/report-\\d{8}-\\d{6}$`));
  assert.deepEqual(kept.outputs.map((item) => item.path).sort(), [`${kept.outputDir}/data/rows.csv`, `${kept.outputDir}/report.txt`]);
  assert.equal(await readFile(join(workspace, kept.outputDir, 'report.txt'), 'utf8'), 'hello');
  const again = await runSkillScript(root, 'scripts/report.py', ['again'], { outputRoot: workspace, mode: 'none' });
  assert.notEqual(again.outputDir, kept.outputDir); // 同一秒重复运行追加序号，不覆盖上次产出
  const empty = await runSkillScript(root, 'scripts/check.py', [], { outputRoot: workspace, mode: 'none' });
  assert.equal(empty.outputDir, null);
  assert.deepEqual(empty.outputs, []);
  assert.equal((await readdir(join(workspace, OUTPUTS_DIR))).length, 2);
  console.log('PASS Skill 脚本授权、免确认执行、运行方式配置与 outputs/ 产出保留');
} finally {
  await rm(root, { recursive: true, force: true });
}
