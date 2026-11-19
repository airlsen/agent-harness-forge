/**
 * 会话关联代码：代码根目录（环境变量 FORGE_CODE_ROOT，默认 /usr/data/git）下的每个一级子目录是一个项目。
 *
 * - 用户在聊天里勾选项目，只有选中的项目会挂载给本会话，且只读；
 * - 模型用绝对路径访问：glob/grep 传 path、read 传 file_path，路径由 forge-runtime 的 guard 收窄到
 *   会话工作区 ∪ 已关联项目（解析符号链接后判断，拒绝 .git 内部与密钥类文件）；
 * - 关联项目变化在下一轮生效：Runner 以新配置重启 dsh 并接续同一份会话日志。
 */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** 一次会话最多关联的项目数 */
export const MAX_CODE_PROJECTS = 20;
/** 代码根目录下最多列出的项目数 */
const MAX_LISTED_PROJECTS = 500;
/** 每个项目注入系统提示的概览上限（字符） */
const OVERVIEW_CHARS = 2400;
/** 目录概览中忽略的依赖、构建产物目录 */
const NOISE = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);

export interface CodeProject {
  name: string;
  /** 解析符号链接后的绝对路径 */
  path: string;
  branch?: string;
  commit?: string;
}
export interface CodeProjectList {
  root: string;
  available: boolean;
  projects: CodeProject[];
}

export function codeRoot() {
  return resolve(process.env.FORGE_CODE_ROOT || '/usr/data/git');
}
function failure(message: string, statusCode = 422) {
  return Object.assign(new Error(message), { statusCode });
}
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** 项目名就是根目录下的一级目录名：不允许路径分隔符、隐藏目录与控制字符 */
export function validProjectName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    !name.startsWith('.') &&
    !/[\\/\0-\x1f]/.test(name)
  );
}

/** 读取 .git/HEAD 得到分支与提交（不依赖 git 命令；失败时返回空） */
export function gitHead(dir: string): { branch?: string; commit?: string } {
  try {
    let gitDir = join(dir, '.git');
    // worktree / submodule：.git 是一个指向真实目录的文件
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim();
      if (!pointer) return {};
      gitDir = resolve(dir, pointer);
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return /^[0-9a-f]{40}$/.test(head) ? { commit: head.slice(0, 12) } : {};
    const branch = ref.replace(/^refs\/heads\//, '');
    let commit = '';
    try {
      commit = readFileSync(join(gitDir, ref), 'utf8').trim();
    } catch {
      const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8');
      commit =
        packed
          .split('\n')
          .find((line) => line.endsWith(' ' + ref))
          ?.split(' ')[0] ?? '';
    }
    return { branch, ...(/^[0-9a-f]{40}$/.test(commit) ? { commit: commit.slice(0, 12) } : {}) };
  } catch {
    return {};
  }
}

/** 解析一个项目：必须是根目录下真实存在的目录，符号链接解析后仍在根目录内 */
function resolveProject(root: string, name: string): CodeProject | null {
  if (!validProjectName(name)) return null;
  try {
    const path = realpathSync(join(root, name));
    if (!inside(root, path) || path === root || !statSync(path).isDirectory()) return null;
    return { name, path, ...gitHead(path) };
  } catch {
    return null;
  }
}

/** 列出代码根目录下的项目（一级目录，按名称排序）；根目录不存在时 available=false */
export function listCodeProjects(): CodeProjectList {
  const configured = codeRoot();
  let root: string;
  try {
    root = realpathSync(configured);
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    return { root: configured, available: false, projects: [] };
  }
  const projects = readdirSync(root)
    .filter(validProjectName)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => resolveProject(root, name))
    .filter((project): project is CodeProject => project !== null)
    .slice(0, MAX_LISTED_PROJECTS);
  return { root: configured, available: true, projects };
}

/** 校验并解析会话选中的项目；任何一个不存在都拒绝（422），保证模型看到的列表与实际挂载一致 */
export function resolveCodeProjects(names: unknown): CodeProject[] {
  if (names === undefined || names === null) return [];
  if (!Array.isArray(names)) throw failure('codeProjects 必须是项目名数组');
  if (names.length > MAX_CODE_PROJECTS) throw failure(`一次最多关联 ${MAX_CODE_PROJECTS} 个代码项目`);
  if (new Set(names).size !== names.length) throw failure('关联的代码项目有重复');
  if (!names.length) return [];
  let root: string;
  try {
    root = realpathSync(codeRoot());
  } catch {
    throw failure(`代码根目录不存在：${codeRoot()}`);
  }
  return names.map((name) => {
    const project = resolveProject(root, name);
    if (!project) throw failure(`代码项目不存在或不可访问：${String(name)}`);
    return project;
  });
}

/** 比较两次关联是否相同（顺序无关） */
export function sameProjects(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');
}

/** 只读取文件开头（最多 chars×4 字节，足够覆盖 UTF-8 中文），避免大文件整体读入 */
function head(path: string, chars: number) {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(chars * 4);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    // 截断处可能落在多字节字符中间：解码后丢弃末尾的替换字符
    const text = buffer
      .subarray(0, size)
      .toString('utf8')
      .replace(/\uFFFD+$/, '');
    const points = Array.from(text);
    return points.length > chars || size === buffer.length ? points.slice(0, chars).join('') + '\n…' : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * 项目概览：顶层目录与文件、README 与 AGENTS.md 开头，帮助模型直接定位，而不必先盲目 glob。
 * 只读取少量元数据，不递归扫描。
 */
export function projectOverview(project: CodeProject): string {
  let entries: string[] = [];
  try {
    entries = readdirSync(project.path, { withFileTypes: true })
      .filter((entry) => !NOISE.has(entry.name) && entry.name !== '.git')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''));
  } catch {
    // 目录不可读时只给出路径
  }
  const shown = entries.slice(0, 60);
  const lines = [
    `顶层：${shown.join('  ') || '（空）'}${entries.length > shown.length ? `  …共 ${entries.length} 项` : ''}`,
  ];
  const guide = ['AGENTS.md', 'CLAUDE.md'].map((name) => join(project.path, name)).find(existsSync);
  if (guide) lines.push(`${guide.slice(project.path.length + 1)}（项目约定）：\n${head(guide, 1200)}`);
  const readme = ['README.md', 'README.zh.md', 'README', 'readme.md']
    .map((name) => join(project.path, name))
    .find(existsSync);
  if (readme) lines.push(`${readme.slice(project.path.length + 1)} 开头：\n${head(readme, 800)}`);
  const text = lines.join('\n');
  return text.length > OVERVIEW_CHARS ? text.slice(0, OVERVIEW_CHARS) + '\n…' : text;
}
