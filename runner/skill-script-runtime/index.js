/** Execute a Skill script in a bubblewrap user/mount/network namespace. Fail closed when unavailable. */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const SCRIPT = /^scripts\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:py|js|sh)$/;
const MAX_OUTPUT = 64_000;
const TIMEOUT_MS = 10_000;

export async function runSkillScript(skillDir, path, args = []) {
  if (typeof path !== 'string' || !SCRIPT.test(path))
    throw new Error('只能运行当前 Skill 的 scripts/ 下的 .py、.js 或 .sh 文件');
  if (!Array.isArray(args) || args.length > 16 || args.some((arg) => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0')))
    throw new Error('脚本参数无效（最多 16 个，每个不超过 1024 字符）');
  const root = resolve(skillDir);
  const file = resolve(root, path);
  if (!file.startsWith(root + sep) || !existsSync(file)) throw new Error(`脚本不存在：${path}`);
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(join(root, 'scripts')).isSymbolicLink())
    throw new Error('脚本文件必须是普通文件');
  const nodeScript = path.endsWith('.js');
  const interpreter = nodeScript ? '/node' : path.endsWith('.py') ? '/usr/bin/python3' : '/bin/sh';
  if (!existsSync(nodeScript ? process.execPath : interpreter)) throw new Error(`运行环境缺少解释器：${interpreter}`);
  const work = await mkdtemp(join(tmpdir(), 'forge-skill-run-'));
  try {
    const mounts = ['/usr', '/bin', '/lib', '/lib64'].filter((dir) => existsSync(dir) && !lstatSync(dir).isSymbolicLink())
      .flatMap((dir) => ['--ro-bind', dir, dir]);
    const links = ['/bin', '/lib', '/lib64'].filter((dir) => existsSync(dir) && lstatSync(dir).isSymbolicLink())
      .flatMap((dir) => ['--symlink', readlinkSync(dir), dir]);
    const command = [
      '--die-with-parent', '--new-session', '--unshare-all',
      ...mounts, ...links, ...(nodeScript ? ['--ro-bind', process.execPath, '/node'] : []),
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--dir', '/skill', '--ro-bind', root, '/skill/current', '--bind', work, '/work',
      '--chdir', '/work', '--', interpreter, `/skill/current/${path}`, ...args,
    ];
    return await new Promise((resolveResult, reject) => {
      const child = spawn('bwrap', command, {
        env: { PATH: '/usr/bin:/bin', HOME: '/work', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let overLimit = false;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
      const collect = (stream, assign) => stream.on('data', (chunk) => {
        assign(chunk.toString('utf8'));
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT) {
          overLimit = true;
          child.kill('SIGKILL');
        }
      });
      collect(child.stdout, (value) => { stdout += value; });
      collect(child.stderr, (value) => { stderr += value; });
      child.once('error', (error) => { clearTimeout(timer); reject(new Error(`隔离运行环境不可用：${error.message}`)); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error('脚本运行超过 10 秒，已终止'));
        if (overLimit) return reject(new Error('脚本输出超过 64 KB，已终止'));
        if (code !== 0 && /bwrap:/.test(stderr)) return reject(new Error(`隔离运行环境不可用：${stderr.trim().slice(0, 300)}`));
        resolveResult({ exitCode: code, stdout, stderr });
      });
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
