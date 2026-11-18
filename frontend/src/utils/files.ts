/**
 * 会话工作区文件：类型识别、交付物解析与预览辅助（纯函数，便于脚本测试）。
 *
 * - 交付物：模型调用 workspace_present 声明的最终文件，随工具结果消息持久化，
 *   因此切换会话、刷新页面后仍能在原轮次下方展示；
 * - 文件本体保存在服务端会话工作区，预览与下载都按原始字节读取。
 */

export const PRESENT_TOOL = 'workspace_present';
/** 平台内置、但不在工具目录（不可单独授权）中的工具显示名 */
export const BUILTIN_TOOL_TITLES: Record<string, string> = { [PRESENT_TOOL]: '交付文件' };

export interface WorkspaceFile {
  path: string;
  bytes: number;
  mime?: string;
  modifiedAt?: string;
}
export interface Deliverable {
  path: string;
  bytes: number;
  description?: string;
}
/** 卡片与预览统一使用的文件描述 */
export type FileRef = WorkspaceFile & { description?: string };

export type FileKind =
  | 'image'
  | 'pdf'
  | 'html'
  | 'markdown'
  | 'table'
  | 'code'
  | 'text'
  | 'audio'
  | 'video'
  | 'office'
  | 'archive'
  | 'binary';

const KIND_BY_EXT: Record<string, FileKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  svg: 'image',
  pdf: 'pdf',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  csv: 'table',
  tsv: 'table',
  txt: 'text',
  log: 'text',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  doc: 'office',
  docx: 'office',
  xls: 'office',
  xlsx: 'office',
  ppt: 'office',
  pptx: 'office',
  zip: 'archive',
  gz: 'archive',
  tar: 'archive',
  rar: 'archive',
  '7z': 'archive',
};
/** 扩展名 → 代码高亮语言（与 highlight.ts 已加载的语言对应） */
const CODE_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  py: 'python',
  java: 'java',
  kt: 'kotlin',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  json: 'json',
  jsonl: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  graphql: 'graphql',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
};

export const KIND_META: Record<FileKind, { label: string; icon: string }> = {
  image: { label: '图片', icon: 'eye' },
  pdf: { label: 'PDF 文档', icon: 'book' },
  html: { label: '网页', icon: 'globe' },
  markdown: { label: 'Markdown', icon: 'file' },
  table: { label: '表格', icon: 'grid' },
  code: { label: '代码', icon: 'code' },
  text: { label: '文本', icon: 'file' },
  audio: { label: '音频', icon: 'play' },
  video: { label: '视频', icon: 'play' },
  office: { label: 'Office 文档', icon: 'file' },
  archive: { label: '压缩包', icon: 'archive' },
  binary: { label: '文件', icon: 'box' },
};

/** 文本类预览上限：更大的文件直接下载，避免卡住页面 */
export const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
/** 超过该大小的代码不做语法高亮，以纯文本展示 */
export const HIGHLIGHT_LIMIT = 200 * 1024;
/** 表格预览最多渲染的行数 */
export const TABLE_PREVIEW_ROWS = 500;

export function fileName(path: string) {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}
export function fileDir(path: string) {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : '';
}
export function fileExt(path: string) {
  const name = fileName(path).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}
export function fileKind(path: string, mime = ''): FileKind {
  const ext = fileExt(path);
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext];
  if (CODE_LANG[ext]) return 'code';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/')) return 'text';
  return 'binary';
}
export function codeLanguage(path: string) {
  return CODE_LANG[fileExt(path)] ?? 'text';
}
export function isTextKind(kind: FileKind) {
  return ['html', 'markdown', 'table', 'code', 'text'].includes(kind);
}
/** 是否可在浏览器内预览；Office、压缩包与未知二进制只提供下载 */
export function previewable(file: Pick<FileRef, 'path' | 'bytes' | 'mime'>) {
  const kind = fileKind(file.path, file.mime);
  if (['office', 'archive', 'binary'].includes(kind)) return false;
  return !isTextKind(kind) || file.bytes <= TEXT_PREVIEW_LIMIT;
}

/** 用比内容中最长反引号串更长的围栏包裹代码，避免内容提前闭合代码块 */
export function fenced(text: string, lang: string) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text.replace(/\n$/, '')}\n${fence}`;
}

/** 解析 CSV/TSV（支持引号、转义引号与引号内换行），最多返回 maxRows 行 */
export function parseDelimited(text: string, delimiter = ',', maxRows = TABLE_PREVIEW_ROWS) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let truncated = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= maxRows) {
        truncated = i < source.length - 1;
        break;
      }
    } else cell += char;
  }
  if (rows.length < maxRows && (cell !== '' || row.length)) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, truncated };
}

/** 从 workspace_present 的工具结果中解析交付物；结果不合法时返回空列表 */
export function parseDeliverables(result: unknown): Deliverable[] {
  if (typeof result !== 'string' || !result.trim()) return [];
  let value: any;
  try {
    value = JSON.parse(result);
  } catch {
    return [];
  }
  if (!Array.isArray(value?.files)) return [];
  return value.files
    .filter((file: any) => file && typeof file.path === 'string' && file.path)
    .map((file: any) => ({
      path: file.path,
      bytes: Number.isFinite(file.bytes) ? file.bytes : 0,
      ...(typeof file.description === 'string' && file.description ? { description: file.description } : {}),
    }));
}

/** 合并交付物：同一路径以后声明的为准，保持首次出现的顺序 */
export function mergeDeliverables(target: Deliverable[], incoming: Deliverable[]) {
  for (const file of incoming) {
    const index = target.findIndex((item) => item.path === file.path);
    if (index >= 0) target[index] = file;
    else target.push(file);
  }
  return target;
}

/** 以服务端最新列表补全交付物的大小与类型（声明后文件可能被覆盖更新） */
export function withListing(file: Deliverable, listing: WorkspaceFile[]): FileRef {
  const current = listing.find((item) => item.path === file.path);
  return current ? { ...current, description: file.description } : file;
}

export function rawFileUrl(sessionId: number, path: string) {
  return `/agent/sessions/${sessionId}/files/raw?path=${encodeURIComponent(path)}`;
}
