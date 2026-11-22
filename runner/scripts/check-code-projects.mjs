#!/usr/bin/env node
/** 关联代码：项目列举、git 元数据、校验、概览，以及 read/glob/grep 的路径收窄。纯本地文件，无模型。 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'forge-code-'));
const root = join(dir, 'git');
process.env.FORGE_CODE_ROOT = root;
const { listCodeProjects, resolveCodeProjects, gitHead, projectOverview, sameProjects, validProjectName } =
  await import('../src/kernel/code-projects.ts');
const { toolPathDenial, filterSecretResults } = await import('../forge-runtime-plugin/index.js');
let checks = 0;
const check = async (name, test) => {
  await test();
  checks += 1;
  console.log('PASS', name);
};
try {
  await check('a missing code root is reported as unavailable instead of failing', () => {
    assert.deepEqual(listCodeProjects(), { root, available: false, projects: [] });
    assert.throws(() => resolveCodeProjects(['alpha']), /代码根目录不存在/);
    assert.deepEqual(resolveCodeProjects([]), []);
  });

  await mkdir(join(root, 'beta', '.git'), { recursive: true });
  await mkdir(join(root, 'alpha', '.git', 'refs', 'heads'), { recursive: true });
  await mkdir(join(root, 'alpha', 'src'), { recursive: true });
  await mkdir(join(root, 'alpha', 'node_modules'), { recursive: true });
  await mkdir(join(root, '.cache'), { recursive: true });
  await mkdir(join(dir, 'outside'), { recursive: true });
  await writeFile(join(root, 'notes.txt'), 'not a project');
  await symlink(join(dir, 'outside'), join(root, 'escape'));
  await symlink(join(root, 'alpha'), join(root, 'alpha-link'));
  await writeFile(join(root, 'alpha', '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  await writeFile(join(root, 'alpha', '.git', 'refs', 'heads', 'feature'), '');
  await rm(join(root, 'alpha', '.git', 'refs', 'heads', 'feature'));
  await mkdir(join(root, 'alpha', '.git', 'refs', 'heads', 'feature'), { recursive: true });
  await writeFile(join(root, 'alpha', '.git', 'refs', 'heads', 'feature', 'x'), 'b'.repeat(40) + '\n');
  await writeFile(join(root, 'beta', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(root, 'beta', '.git', 'packed-refs'), `# pack\n${'c'.repeat(40)} refs/heads/main\n`);
  await writeFile(join(root, 'alpha', 'README.md'), '# Alpha\n' + 'x'.repeat(5000));
  await writeFile(join(root, 'alpha', 'AGENTS.md'), '使用 pnpm；提交前运行 lint。');
  await writeFile(join(root, 'alpha', 'package.json'), '{}');

  await check('projects are the visible first-level directories, sorted, with git branch and commit', () => {
    const listed = listCodeProjects();
    assert.equal(listed.available, true);
    assert.deepEqual(
      listed.projects.map(({ name, branch, commit }) => [name, branch, commit]),
      [
        ['alpha', 'feature/x', 'b'.repeat(12)],
        // 指向根目录内项目的符号链接可以关联（解析为同一真实目录）
        ['alpha-link', 'feature/x', 'b'.repeat(12)],
        ['beta', 'main', 'c'.repeat(12)],
      ],
    );
    assert.equal(listed.projects[1].path, listed.projects[0].path);
  });

  await check('detached HEAD and worktree pointers are understood; broken metadata is ignored', async () => {
    await mkdir(join(dir, 'wt-git'), { recursive: true });
    await writeFile(join(dir, 'wt-git', 'HEAD'), 'd'.repeat(40) + '\n');
    await mkdir(join(dir, 'wt'), { recursive: true });
    await writeFile(join(dir, 'wt', '.git'), `gitdir: ${join(dir, 'wt-git')}\n`);
    assert.deepEqual(gitHead(join(dir, 'wt')), { commit: 'd'.repeat(12) });
    assert.deepEqual(gitHead(join(dir, 'outside')), {});
  });

  await check('git branches and tags metadata are extracted from loose and packed refs', async () => {
    const gitDir = join(dir, 'meta-git');
    await mkdir(join(gitDir, 'refs', 'heads', 'feature'), { recursive: true });
    await mkdir(join(gitDir, 'refs', 'tags'), { recursive: true });
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(gitDir, 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n');
    await writeFile(join(gitDir, 'refs', 'heads', 'feature', 'login'), 'b'.repeat(40) + '\n');
    await writeFile(join(gitDir, 'refs', 'tags', 'v1.0.0'), 'c'.repeat(40) + '\n');
    await writeFile(
      join(gitDir, 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${'d'.repeat(40)} refs/heads/release\n${'e'.repeat(40)} refs/tags/v0.9.0\n`,
    );
    const metaProj = join(dir, 'meta-proj');
    await mkdir(metaProj, { recursive: true });
    await writeFile(join(metaProj, '.git'), `gitdir: ${gitDir}\n`);

    const result = gitHead(metaProj);
    assert.equal(result.branch, 'main');
    assert.equal(result.commit, 'a'.repeat(12));
    assert.deepEqual(result.branches, ['feature/login', 'main', 'release']);
    assert.deepEqual(result.tags, ['v0.9.0', 'v1.0.0']);
  });

  await check('resolving the selection validates names, count, duplicates and existence', () => {
    assert.deepEqual(
      resolveCodeProjects(['beta', 'alpha']).map((project) => project.name),
      ['beta', 'alpha'],
    );
    for (const name of ['../alpha', 'alpha/src', '.cache', 'escape', 'notes.txt', 'missing', ''])
      assert.throws(() => resolveCodeProjects([name]), /代码项目不存在/, name);
    assert.throws(() => resolveCodeProjects('alpha'), /数组/);
    assert.throws(() => resolveCodeProjects(['alpha', 'alpha']), /重复/);
    assert.throws(() => resolveCodeProjects(Array.from({ length: 21 }, (_, i) => `p${i}`)), /最多/);
    assert.equal(validProjectName('a\nb'), false);
    assert.ok(sameProjects(['a', 'b'], ['b', 'a']));
    assert.equal(sameProjects(['a'], ['a', 'b']), false);
  });

  await check('the overview lists top-level entries without dependency noise and is size-bounded', () => {
    const [alpha] = resolveCodeProjects(['alpha']);
    const overview = projectOverview(alpha);
    assert.match(overview, /^顶层：src\/ {2}AGENTS\.md {2}package\.json {2}README\.md/);
    assert.doesNotMatch(overview, /node_modules|\.git\//);
    assert.match(overview, /AGENTS\.md（项目约定）：\n使用 pnpm/);
    assert.match(overview, /README\.md 开头：\n# Alpha/);
    assert.ok(overview.length <= 2402);
  });

  // read / glob / grep 的路径收窄
  const workspace = join(dir, 'workspace');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  const projects = resolveCodeProjects(['alpha']).map(({ name, path }) => ({ name, path }));
  const alpha = projects[0].path;
  await writeFile(join(alpha, '.env'), 'SECRET=1');
  await writeFile(join(alpha, '.env.example'), 'SECRET=');
  await writeFile(join(alpha, 'server.pem'), 'key');
  await mkdir(join(alpha, '.github'), { recursive: true });
  await writeFile(join(alpha, '.github', 'ci.yml'), 'on: push');
  await symlink(join(dir, 'outside'), join(alpha, 'out'));
  await symlink(join(alpha, 'src'), join(alpha, 'src-link'));
  const deny = (name, args, list = projects) => toolPathDenial(workspace, list, { name, arguments: args });
  await check('associated projects are readable and searchable by absolute path', () => {
    assert.equal(deny('read', { file_path: join(alpha, 'README.md') }), undefined);
    assert.equal(deny('grep', { pattern: 'x', path: alpha }), undefined);
    assert.equal(deny('glob', { pattern: '*.ts', path: join(alpha, 'src') }), undefined);
    // 项目内的隐藏配置（如 CI）与示例环境文件可以读取；不存在的路径交给工具报告
    assert.equal(deny('read', { file_path: join(alpha, '.github', 'ci.yml') }), undefined);
    assert.equal(deny('read', { file_path: join(alpha, '.env.example') }), undefined);
    assert.equal(deny('read', { file_path: join(alpha, 'src', 'missing.ts') }), undefined);
    assert.equal(deny('read', { file_path: join(alpha, 'src-link', 'x.ts') }), undefined);
  });
  await check('version-control internals, secrets and escaping symlinks are denied', () => {
    for (const path of [join(alpha, '.git', 'HEAD'), join(alpha, '.env'), join(alpha, 'server.pem')])
      assert.match(deny('read', { file_path: path }), /密钥|版本库/, path);
    assert.match(deny('grep', { pattern: 'x', path: join(alpha, '.git') }), /版本库/);
    assert.match(deny('read', { file_path: join(alpha, 'out', 'x.txt') }), /符号链接/);
    assert.match(deny('grep', { pattern: 'x', path: join(alpha, 'out') }), /符号链接/);
  });
  await check('anything outside the workspace and associated projects is denied', () => {
    const beta = join(root, 'beta');
    assert.match(deny('read', { file_path: join(beta, '.git', 'HEAD') }), /已关联的代码项目/);
    assert.match(deny('grep', { pattern: 'x', path: root }), /已关联的代码项目/);
    assert.match(deny('read', { file_path: '/etc/passwd' }), /已关联的代码项目/);
    assert.match(deny('read', { file_path: join(alpha, '..', 'beta') }), /已关联的代码项目/);
    // 未关联任何项目时保持原有的工作区提示
    assert.match(deny('grep', { pattern: 'x', path: alpha }, []), /超出当前会话工作区/);
  });
  await check('workspace paths keep the workspace rules; arguments are validated', () => {
    assert.equal(deny('read', { file_path: 'docs/plan.md' }), undefined);
    assert.equal(deny('grep', { pattern: 'x' }), undefined);
    // 工作区内的隐藏目录（如 Skill 草稿镜像 .skill/）可以读取，密钥类文件仍拒绝
    assert.equal(deny('read', { file_path: '.skill/SKILL.md' }), undefined);
    assert.match(deny('read', { file_path: '.env' }), /密钥/);
    assert.match(deny('read', {}), /文件路径无效/);
    assert.match(deny('read', { file_path: 'a\0b' }), /文件路径无效/);
    assert.match(deny('glob', { pattern: '*', path: '' }), /搜索路径无效/);
    // 其他工具不受影响
    assert.equal(deny('workspace_read', { path: '/etc/passwd' }), undefined);
  });
  await check(
    'secret files are removed from project-wide search results; other results are untouched',
    () => {
      const grep = {
        isError: false,
        content: [],
        value: {
          matches: [
            { path: join(alpha, 'src', 'app.ts'), lineNumber: 1, line: 'token' },
            { path: join(alpha, '.env'), lineNumber: 1, line: 'SECRET=1' },
            { path: join(alpha, 'deploy', 'server.pem'), lineNumber: 2, line: 'key' },
            { path: join(alpha, '.env.example'), lineNumber: 1, line: 'SECRET=' },
          ],
        },
      };
      const filtered = filterSecretResults(workspace, projects, { name: 'grep' }, grep);
      assert.deepEqual(Object.keys(filtered), ['isError', 'value']); // re-rendered by the tool itself
      assert.deepEqual(
        filtered.value.matches.map((match) => match.path),
        [join(alpha, 'src', 'app.ts'), join(alpha, '.env.example')],
      );
      const glob = {
        isError: false,
        value: { root: alpha, paths: [join(alpha, 'a.ts'), join(alpha, '.npmrc')] },
      };
      assert.deepEqual(filterSecretResults(workspace, projects, { name: 'glob' }, glob).value, {
        root: alpha,
        paths: [join(alpha, 'a.ts')],
      });
      // 无需剔除、错误结果、其他工具、未关联项目时原样返回
      const clean = { isError: false, value: { root: alpha, paths: [join(alpha, 'a.ts')] } };
      assert.equal(filterSecretResults(workspace, projects, { name: 'glob' }, clean), clean);
      const failed = { isError: true, content: [] };
      assert.equal(filterSecretResults(workspace, projects, { name: 'grep' }, failed), failed);
      assert.equal(filterSecretResults(workspace, projects, { name: 'read' }, grep), grep);
      assert.equal(filterSecretResults(workspace, [], { name: 'grep' }, grep), grep);
      // 工作区内的相对路径不受影响
      const local = { isError: false, value: { matches: [{ path: '.env', lineNumber: 1, line: 'x' }] } };
      assert.equal(filterSecretResults(workspace, projects, { name: 'grep' }, local), local);
    },
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ scope: 'code project association, no model', checks, result: 'passed' }));
