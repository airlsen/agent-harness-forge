/**
 * Skill 脚本运行时：skill_test_script（编写会话）与 skill_run_script（业务会话）共用。
 *
 * - 运行方式由 FORGE_SKILL_SCRIPT_SANDBOX 决定：
 *   auto（默认）宿主有可用的 bubblewrap 时隔离运行，否则直接用解释器运行；
 *   bwrap 只允许隔离运行，不可用时报错；none 一律直接运行。
 *   隔离运行时 Skill 目录只读挂载到 /skill/current，可以联网（与 bash 一致）；直接运行时没有这些限制。
 * - 工作目录：传入 outputRoot（会话工作区）时，脚本在 outputs/<脚本名>-<时间>/ 下运行，
 *   跑完保留其中的文件（会话文件同步后用户可见）；没有产出时删除空目录。未传时使用临时目录，跑完删除。
 * - 两种方式都提供 FORGE_SKILL_DIR（Skill 目录）与 FORGE_OUTPUT_DIR（工作目录）环境变量。
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

const SCRIPT = /^scripts\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:py|js|sh)$/;
const MAX_OUTPUT = 64_000;
/** 单次运行上限：与 bash 命令一致的 5 分钟 */
const TIMEOUT_MS = 300_000;
/** 返回给模型的产出文件清单上限（文件本身全部保留在工作区） */
const MAX_LISTED_OUTPUTS = 50;
export const OUTPUTS_DIR = 'outputs';
const MODES = new Set(['auto', 'bwrap', 'none']);

/** 当前运行方式；非法取值按 auto 处理 */
export function sandboxMode(env = process.env) {
  const value = String(env.FORGE_SKILL_SCRIPT_SANDBOX ?? 'auto').trim().toLowerCase();
  return MODES.has(value) ? value : 'auto';
}

// auto 模式下 bubblewrap 不可用的原因：首次失败后记住，后续直接运行，不再反复尝试
let bwrapUnavailable = '';
/** 测试用：清除缓存的 bubblewrap 检测结果 */
export function resetSandboxProbe() {
  bwrapUnavailable = '';
}

class SandboxUnavailable extends Error {}

/** 本地时间戳 20261122-113005，用作产出目录名的一部分 */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 在 outputRoot/outputs/ 下新建本次运行的目录：<脚本名>-<时间>，同一秒重复运行时追加序号 */
async function createOutputDir(outputRoot, path) {
  const root = resolve(outputRoot);
  const parent = join(root, OUTPUTS_DIR);
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('outputs 目录不能是符号链接');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const name = basename(path).replace(/\.[^.]+$/, '') || 'script';
  const base = `${name}-${stamp()}`;
  for (let index = 1; index < 100; index += 1) {
    const dir = join(parent, index === 1 ? base : `${base}-${index}`);
    try {
      await mkdir(dir, { mode: 0o700 });
      return { dir, relative: `${OUTPUTS_DIR}/${basename(dir)}` };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('无法创建脚本产出目录');
}

/** 列出目录中的产出文件（相对 prefix 的路径与大小），跳过符号链接 */
async function listOutputs(dir, prefix) {
  const files = [];
  let total = 0;
  const walk = async (current, relative, depth) => {
    if (depth > 8) return;
    for (const item of await readdir(current, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const full = join(current, item.name);
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(full, path, depth + 1);
      else if (item.isFile()) {
        total += 1;
        if (files.length < MAX_LISTED_OUTPUTS) files.push({ path: `${prefix}/${path}`, bytes: (await lstat(full)).size });
      }
    }
  };
  await walk(dir, '', 0);
  return { files, total };
}

/** 启动解释器并收集输出（5 分钟、64 KB 上限）；bwrap 自身报错时抛出 SandboxUnavailable */
function execute(command, args, options, sandboxed) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let overLimit = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    const collect = (stream, assign) =>
      stream.on('data', (chunk) => {
        assign(chunk.toString('utf8'));
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT) {
          overLimit = true;
          child.kill('SIGKILL');
        }
      });
    collect(child.stdout, (value) => {
      stdout += value;
    });
    collect(child.stderr, (value) => {
      stderr += value;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (sandboxed) reject(new SandboxUnavailable(`bubblewrap 无法启动：${error.message}`));
      else reject(new Error(`无法启动解释器 ${command}：${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`脚本运行超过 ${TIMEOUT_MS / 60000} 分钟，已终止`));
      if (overLimit) return reject(new Error('脚本输出超过 64 KB，已终止'));
      // bwrap 自身失败（如宿主禁止创建命名空间）时 stderr 以 "bwrap:" 开头，脚本并没有运行
      if (sandboxed && code !== 0 && /^bwrap:/m.test(stderr) && !stdout)
        return reject(new SandboxUnavailable(stderr.trim().slice(0, 300)));
      resolveResult({ exitCode: code, stdout, stderr });
    });
  });
}

function runIsolated(root, path, args, work, nodeScript) {
  const interpreter = nodeScript ? '/node' : path.endsWith('.py') ? '/usr/bin/python3' : '/bin/sh';
  if (!existsSync(nodeScript ? process.execPath : interpreter))
    throw new SandboxUnavailable(`隔离环境缺少解释器：${interpreter}`);
  const mounts = ['/usr', '/bin', '/lib', '/lib64']
    .filter((dir) => existsSync(dir) && !lstatSync(dir).isSymbolicLink())
    .flatMap((dir) => ['--ro-bind', dir, dir]);
  const links = ['/bin', '/lib', '/lib64']
    .filter((dir) => existsSync(dir) && lstatSync(dir).isSymbolicLink())
    .flatMap((dir) => ['--symlink', readlinkSync(dir), dir]);
  // 共享宿主网络（与 bash 一致），并只读挂载域名解析与证书配置，脚本才能访问外部服务
  const netFiles = ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl', '/etc/ca-certificates', '/etc/pki']
    .filter((path) => existsSync(path))
    .flatMap((path) => ['--ro-bind', path, path]);
  const command = [
    '--die-with-parent', '--new-session', '--unshare-all', '--share-net',
    ...mounts, ...links, ...netFiles, ...(nodeScript ? ['--ro-bind', process.execPath, '/node'] : []),
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/skill', '--ro-bind', root, '/skill/current', '--bind', work, '/work',
    '--chdir', '/work', '--', interpreter, `/skill/current/${path}`, ...args,
  ];
  return execute(
    'bwrap',
    command,
    {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/work',
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        FORGE_SKILL_DIR: '/skill/current',
        FORGE_OUTPUT_DIR: '/work',
      },
    },
    true,
  );
}

function runDirect(root, path, args, work, nodeScript) {
  const interpreter = nodeScript ? process.execPath : path.endsWith('.py') ? 'python3' : 'sh';
  return execute(
    interpreter,
    [join(root, path), ...args],
    {
      cwd: work,
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: work,
        LANG: process.env.LANG || 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONIOENCODING: 'utf-8',
        FORGE_SKILL_DIR: root,
        FORGE_OUTPUT_DIR: work,
      },
    },
    false,
  );
}

/**
 * 运行 Skill 目录中的一个脚本。
 * @param {string} skillDir Skill 目录（含 SKILL.md 与 scripts/）
 * @param {string} path 脚本相对路径，例如 scripts/check.py
 * @param {string[]} args 脚本参数（不经过 Shell）
 * @param {{ outputRoot?: string, mode?: string }} options outputRoot 为会话工作区时保留产出
 */
export async function runSkillScript(skillDir, path, args = [], options = {}) {
  if (typeof path !== 'string' || !SCRIPT.test(path))
    throw new Error('只能运行当前 Skill 的 scripts/ 下的 .py、.js 或 .sh 文件');
  if (!Array.isArray(args) || args.length > 16 || args.some((arg) => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0')))
    throw new Error('脚本参数无效（最多 16 个，每个不超过 1024 字符）');
  const root = resolve(skillDir);
  const file = resolve(root, path);
  if (!file.startsWith(root + sep) || !existsSync(file)) throw new Error(`脚本不存在：${path}`);
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(join(root, 'scripts')).isSymbolicLink())
    throw new Error('脚本文件必须是普通文件');
  const mode = MODES.has(options.mode) ? options.mode : sandboxMode();
  const nodeScript = path.endsWith('.js');
  const output = options.outputRoot ? await createOutputDir(options.outputRoot, path) : null;
  const work = output ? output.dir : await mkdtemp(join(tmpdir(), 'forge-skill-run-'));
  let result;
  let isolated = false;
  let note = '';
  try {
    if (mode === 'none' || (mode === 'auto' && bwrapUnavailable)) {
      result = await runDirect(root, path, args, work, nodeScript);
      note = mode === 'none' ? '' : `隔离环境不可用（${bwrapUnavailable}），已直接运行`;
    } else {
      try {
        result = await runIsolated(root, path, args, work, nodeScript);
        isolated = true;
      } catch (error) {
        if (!(error instanceof SandboxUnavailable)) throw error;
        if (mode === 'bwrap') throw new Error(`隔离运行环境不可用：${error.message}`);
        bwrapUnavailable = error.message;
        result = await runDirect(root, path, args, work, nodeScript);
        note = `隔离环境不可用（${error.message}），已直接运行`;
      }
    }
  } catch (error) {
    if (output) await removeIfEmpty(work);
    throw error;
  } finally {
    if (!output) await rm(work, { recursive: true, force: true });
  }
  const value = { ...result, isolated, ...(note ? { note } : {}) };
  if (!output) return value;
  const outputs = await listOutputs(work, output.relative);
  if (!outputs.total) {
    await removeIfEmpty(work);
    return { ...value, outputDir: null, outputs: [] };
  }
  return {
    ...value,
    outputDir: output.relative,
    outputs: outputs.files,
    ...(outputs.total > outputs.files.length ? { outputsTotal: outputs.total } : {}),
  };
}

async function removeIfEmpty(dir) {
  try {
    await rmdir(dir);
  } catch {
    // 目录非空或已不存在
  }
}
