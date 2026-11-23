/**
 * Skill 目录：SKILL.md 之外 references/、assets/、scripts/ 下的文件。规则与控制面 skill_files.py 保持一致，
 * 前端只用于提前提示，最终以接口校验为准。
 */
import type { SkillFile } from '../../types/skill';

export const SKILL_MAIN_FILE = 'SKILL.md';
export type SkillFileDir = 'references' | 'assets' | 'scripts';
export const SKILL_FILE_DIRS: readonly {
  dir: SkillFileDir;
  extensions: readonly string[];
  hint: string;
}[] = [
  { dir: 'references', extensions: ['.md', '.txt'], hint: '需要时才读的资料：规则、术语表、口径说明' },
  {
    dir: 'assets',
    extensions: ['.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.html'],
    hint: '照着用的模板和样例',
  },
  { dir: 'scripts', extensions: ['.py', '.js', '.sh'], hint: '可在隔离环境中试运行的脚本' },
];
export const MAX_SKILL_FILE_BYTES = 120_000;
export const MAX_SKILL_FILES = 20;
export const MAX_SKILL_FILES_TOTAL_BYTES = 512_000;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function dirOf(path: string): SkillFileDir | null {
  const dir = path.split('/')[0];
  return dir === 'references' || dir === 'assets' || dir === 'scripts' ? dir : null;
}
export function fileNameOf(path: string) {
  return path.slice(path.indexOf('/') + 1);
}
function extensionOf(name: string) {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index).toLowerCase() : '';
}
export function acceptFor(dir: SkillFileDir) {
  return SKILL_FILE_DIRS.find((item) => item.dir === dir)!.extensions.join(',');
}

/** 校验目录下的文件名，返回错误说明；合法时返回空字符串。 */
export function fileNameError(dir: SkillFileDir, name: string) {
  const value = name.trim();
  if (!value) return '请输入文件名';
  if (!FILE_NAME.test(value)) return '文件名只能使用英文字母、数字、点、下划线和短横线，以字母或数字开头';
  const { extensions } = SKILL_FILE_DIRS.find((item) => item.dir === dir)!;
  if (!extensions.includes(extensionOf(value))) return `${dir}/ 只支持 ${extensions.join('、')} 文件`;
  return '';
}

/**
 * 把上传文件的名字整理成合法文件名（中文、空格等替换为短横线）；整理后没有可用的名字时返回空字符串，
 * 由用户在对话框里重新命名。
 */
export function suggestFileName(dir: SkillFileDir, original: string) {
  const base = original.split(/[\\/]/).pop() ?? '';
  const extension = extensionOf(base);
  const stem = (extension ? base.slice(0, -extension.length) : base)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|[-_.]+$/g, '')
    .slice(0, 100);
  if (!stem) return '';
  const name = `${stem}${extension}`;
  return fileNameError(dir, name) ? '' : name;
}

/** 文件树：三个目录始终显示（空目录也显示），文件按名称排序。 */
export function skillFileTree(files: readonly SkillFile[]) {
  return SKILL_FILE_DIRS.map(({ dir, hint }) => ({
    dir,
    hint,
    files: files
      .filter((file) => dirOf(file.path) === dir)
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path)),
  }));
}

/** 新建文件时的初始内容：Markdown 带一个标题，其他格式为空。 */
export function initialFileContent(path: string) {
  const name = fileNameOf(path);
  return extensionOf(name) === '.md' ? `# ${name.slice(0, -3)}\n\n` : '';
}

export function editorLanguage(
  path: string,
): 'markdown' | 'yaml' | 'javascript' | 'python' | 'shell' | 'plaintext' {
  const extension = extensionOf(path);
  if (extension === '.md') return 'markdown';
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  if (extension === '.js') return 'javascript';
  if (extension === '.py') return 'python';
  if (extension === '.sh') return 'shell';
  return 'plaintext';
}

/** 预览：Markdown 直接渲染，其他格式按代码块展示（HTML 也只看源码，不在页面里执行）。 */
export function previewMarkdown(path: string, content: string) {
  const extension = extensionOf(path);
  if (extension === '.md') return content;
  const fence = '`'.repeat(Math.max(3, ...(content.match(/`+/g) ?? []).map((item) => item.length + 1)));
  const lang = extension === '.txt' ? 'text' : extension.slice(1);
  return `${fence}${lang}\n${content}\n${fence}`;
}

/** 新建或上传前的容量检查：覆盖同名文件不算新增。返回错误说明，可以写入时返回空字符串。 */
export function capacityError(files: readonly SkillFile[], path: string, bytes: number) {
  if (bytes > MAX_SKILL_FILE_BYTES) return `单个文件不能超过 ${MAX_SKILL_FILE_BYTES / 1000} KB`;
  const others = files.filter((file) => file.path !== path);
  if (others.length >= MAX_SKILL_FILES) return `每个技能最多 ${MAX_SKILL_FILES} 个附加文件`;
  const total = others.reduce((sum, file) => sum + file.bytes, 0) + bytes;
  if (total > MAX_SKILL_FILES_TOTAL_BYTES)
    return `附加文件合计不能超过 ${MAX_SKILL_FILES_TOTAL_BYTES / 1000} KB`;
  return '';
}

export type AssistantFileChange = { action: 'update_draft' | 'write_file' | 'delete_file'; path: string };

/** 一轮对话里助手改了哪些文件：同一文件以最后一次操作为准，SKILL.md 排最前。 */
export function summarizeAssistantChanges(changes: readonly AssistantFileChange[]) {
  const last = new Map<string, AssistantFileChange['action']>();
  for (const change of changes) {
    last.delete(change.path);
    last.set(change.path, change.action);
  }
  const entries = [...last].sort(([a], [b]) => Number(b === SKILL_MAIN_FILE) - Number(a === SKILL_MAIN_FILE));
  const updated = entries.filter(([, action]) => action !== 'delete_file').map(([path]) => path);
  const deleted = entries.filter(([, action]) => action === 'delete_file').map(([path]) => path);
  const parts = [
    updated.length ? `已更新 ${updated.join('、')}` : '',
    deleted.length ? `已删除 ${deleted.join('、')}` : '',
  ].filter(Boolean);
  return {
    written: updated,
    deleted,
    text: parts.length ? `${parts.join('；')}，尚未发布。` : '',
  };
}
