/**
 * forge-runtime 自有的会话工作区工具：current_time、workspace_list / read / write / present。
 * 只操作本会话工作区（路径经 path-guard 校验），受 limits 中的文件数与容量配额约束；
 * 写入与交付声明经 Forge 事件实时通知 Runner。
 */
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { notify } from '../plugin-kit/events.js';
import { checkedPath } from './path-guard.js';
import {
  MAX_DEPTH,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_PRESENTED,
  MAX_READ_CHARS,
  MAX_READ_LINES,
  MAX_TOTAL_BYTES,
} from './limits.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** 写入内容转字节：utf8 为默认文本；base64 用于图片等二进制产物（按解码后字节计入配额）。 */
function contentBytes(content, encoding = 'utf8') {
  if (encoding === 'utf8') return Buffer.from(String(content), 'utf8');
  if (encoding !== 'base64') throw new Error('encoding 仅支持 utf8 或 base64');
  const compact = String(content).replace(/\s+/g, '');
  if (compact.length % 4 === 1 || !BASE64.test(compact)) throw new Error('content 不是合法的 base64');
  return Buffer.from(compact, 'base64');
}
async function workspaceFiles(root, dir = root, depth = 0) {
  const files = [];
  if (depth > MAX_DEPTH) return files;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await workspaceFiles(root, path, depth + 1)));
    else if (entry.isFile()) files.push({ path: relative(root, path), bytes: (await lstat(path)).size });
    if (files.length > MAX_FILES) break;
  }
  return files;
}

/** 注册工作区工具，返回各自的注销函数。root 为已创建的会话工作区绝对路径 */
export function registerWorkspaceTools(ctx, root) {
  // 同一轮模型可并发调用工具；把配额检查与写盘串行化，避免越过文件数/总量上限。
  let writeChain = Promise.resolve();
  const exclusiveWrite = (operation) => {
    const task = writeChain.then(operation);
    writeChain = task.catch(() => {});
    return task;
  };
  const disposers = [];
  const add = (toolName, description, properties, required, execute) => {
    disposers.push(
      ctx.tools.register({
        name: toolName,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute,
      }),
    );
  };
  add('current_time', 'Get current ISO date and time. No network access.', {}, [], async () => ({
    iso: new Date().toISOString(),
    timezone: 'UTC',
  }));
  add(
    'workspace_list',
    'List files in this session workspace only, with sizes in bytes.',
    {},
    [],
    async () => {
      return { files: await workspaceFiles(root) };
    },
  );
  add(
    'workspace_read',
    `Read a text file from this session workspace (read-only, workspace-relative path; hidden folders such as .skill/ are readable). Files up to 10 MB. Files up to ${MAX_READ_CHARS} characters return whole; larger ones return the first ${MAX_READ_LINES} lines with totalLines and truncated=true, then pass offset (1-based start line) and limit (number of lines) to continue, e.g. around a grep match.`,
    {
      path: { type: 'string', description: 'Path relative to the session workspace.' },
      offset: { type: 'integer', minimum: 1, description: 'First line to return, 1-based. Default 1.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_READ_LINES,
        description: `Maximum number of lines to return (at most ${MAX_READ_LINES}).`,
      },
    },
    ['path'],
    async ({ path, offset, limit }) => {
      const full = await checkedPath(root, path, { hidden: true });
      const stat = await lstat(full);
      if (!stat.isFile()) throw new Error('不是普通文件');
      if (stat.size > MAX_FILE_BYTES)
        throw new Error('仅允许读取 10 MB 内的文本文件，更大的文件请用 bash 处理');
      let content;
      try {
        content = utf8.decode(await readFile(full));
      } catch {
        throw new Error('这是二进制文件，无法按文本读取；用户可在结果面板预览或下载');
      }
      // 小文件且未指定范围：整篇返回（与旧行为一致）
      if (offset === undefined && limit === undefined && content.length <= MAX_READ_CHARS)
        return { path, content };
      const start = Number.isInteger(offset) && offset > 0 ? offset : 1;
      const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_READ_LINES) : MAX_READ_LINES;
      const lines = content.split(/\r?\n/);
      if (lines.length > 1 && lines.at(-1) === '') lines.pop();
      const slice = lines.slice(start - 1, start - 1 + count);
      let text = slice.join('\n');
      const clipped = text.length > MAX_READ_CHARS;
      if (clipped) text = text.slice(0, MAX_READ_CHARS);
      const endLine = slice.length ? start + slice.length - 1 : start - 1;
      return {
        path,
        content: text,
        startLine: start,
        endLine,
        totalLines: lines.length,
        // 模型自己指定了 limit 时只回报行号；默认分页或按字符截断时才提示如何继续
        ...(clipped || (limit === undefined && endLine < lines.length)
          ? {
              truncated: true,
              note: clipped
                ? `内容超过 ${MAX_READ_CHARS} 字符已截断，请用更小的 limit 分段读取`
                : `还有 ${lines.length - endLine} 行未返回，用 offset=${endLine + 1} 继续读取`,
            }
          : {}),
      };
    },
  );
  add(
    'workspace_write',
    'Create or overwrite a file in this session workspace. Text by default; set encoding to "base64" to save binary content such as images. Writes run directly without user approval.',
    {
      path: { type: 'string' },
      content: { type: 'string' },
      encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Content encoding, default utf8.' },
    },
    ['path', 'content'],
    async ({ path, content, encoding }) =>
      exclusiveWrite(async () => {
        const data = contentBytes(content, encoding);
        if (data.length > MAX_FILE_BYTES) throw new Error('单文件不能超过 10 MB');
        const full = await checkedPath(root, path, { writing: true });
        const existing = await workspaceFiles(root);
        const previous = existing.find((file) => file.path === relative(root, full));
        if (!previous && existing.length >= MAX_FILES)
          throw new Error(`每个会话最多保存 ${MAX_FILES} 个文件`);
        if (
          existing.reduce((sum, file) => sum + file.bytes, 0) - (previous?.bytes ?? 0) + data.length >
          MAX_TOTAL_BYTES
        )
          throw new Error('会话产物总量不能超过 200 MB');
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, data, { mode: 0o600 });
        notify('forge.artifact', { path, bytes: data.length });
        return { path, bytes: data.length, saved: true };
      }),
  );
  add(
    'workspace_present',
    'Declare existing files in this session workspace as final deliverables for the user. The interface shows them as file cards under your reply with preview and download, and lists them first in the results panel. Call it once the files are final, choosing the 1-2 most important files (at most 4 per call); do not present drafts or intermediate files. Prefer your final response alone when no separate file is needed.',
    {
      files: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PRESENTED,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to the session workspace.' },
            description: { type: 'string', description: 'Optional one-line description for the user.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    ['files'],
    async ({ files }) => {
      if (!Array.isArray(files) || !files.length || files.length > MAX_PRESENTED)
        throw new Error(`每次需声明 1 到 ${MAX_PRESENTED} 个文件`);
      const presented = [];
      for (const file of files) {
        let full, stat;
        try {
          full = await checkedPath(root, file?.path);
          stat = await lstat(full);
        } catch (error) {
          if (error.code === 'ENOENT') throw new Error(`文件不存在：${file.path}，请先写入工作区再声明交付`);
          throw error;
        }
        if (!stat.isFile()) throw new Error(`不是普通文件：${file.path}`);
        const path = relative(root, full).split(sep).join('/');
        if (presented.some((item) => item.path === path)) continue;
        const description = typeof file.description === 'string' ? file.description.trim().slice(0, 200) : '';
        presented.push({ path, bytes: stat.size, ...(description ? { description } : {}) });
      }
      notify('forge.present', { files: presented });
      return { files: presented };
    },
  );
  return disposers;
}
