/**
 * 工作区桥接：dsh 官方文件工具（write / edit / present）之上的 Forge 平台层。
 * - 配额：每个会话最多 MAX_FILES 个文件、合计 MAX_TOTAL_BYTES、单文件 MAX_FILE_BYTES（dsh 没有配额）；
 * - 文件实时同步：写入、修改成功后发 forge.artifact；交付后发 forge.present（路径换成工作区相对路径），
 *   Runner 据此更新结果面板与交付卡片。
 * 同一轮模型可能并发调用工具：写入与修改串行执行，配额检查和写盘之间不会被插队。
 * 路径是否允许（工作区内、非隐藏、无符号链接）由 path-guard 在执行前把关，这里不重复判断。
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { ENGINE_TOOLS } from '../../src/kernel/dsh/engine-tools.js';
import { notify } from '../shared/events.js';
import { MAX_DEPTH, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES } from './limits.js';

const { write: WRITE, edit: EDIT, present: PRESENT } = ENGINE_TOOLS;
const toPosix = (path) => path.split(sep).join('/');

/** 工作区内计入配额的文件：不含隐藏文件与符号链接（与会话文件区同步的范围一致） */
export async function workspaceFiles(root, dir = root, depth = 0) {
  const files = [];
  if (depth > MAX_DEPTH) return files;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await workspaceFiles(root, path, depth + 1)));
    else if (entry.isFile()) files.push({ path: relative(root, path), bytes: (await lstat(path)).size });
    if (files.length > MAX_FILES) break;
  }
  return files;
}

/** 写入或修改后文件的预计字节数；参数不完整时返回 undefined，交给工具自己报错 */
async function projectedBytes(full, exec) {
  const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
  if (exec.name === WRITE)
    return typeof args.content === 'string' ? Buffer.byteLength(args.content) : undefined;
  if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string' || !args.old_string)
    return undefined;
  let current;
  try {
    current = await readFile(full, 'utf8');
  } catch {
    return undefined;
  }
  // 原文不存在或不唯一时工具会报错；这里只按替换次数估算增量
  const matches = current.split(args.old_string).length - 1;
  const times = args.replace_all === true ? matches : Math.min(matches, 1);
  return (
    Buffer.byteLength(current) +
    (Buffer.byteLength(args.new_string) - Buffer.byteLength(args.old_string)) * times
  );
}

/** 配额检查：返回拒绝原因，允许时返回 undefined */
export async function quotaDenial(root, full, bytes) {
  if (bytes > MAX_FILE_BYTES) return '单个文件不能超过 10 MB，更大的产物请用 bash 分片生成';
  const files = await workspaceFiles(root);
  const previous = files.find((file) => file.path === relative(root, full));
  if (!previous && files.length >= MAX_FILES) return `每个会话最多保存 ${MAX_FILES} 个文件`;
  const total = files.reduce((sum, file) => sum + file.bytes, 0) - (previous?.bytes ?? 0) + bytes;
  if (total > MAX_TOTAL_BYTES) return '会话产物总量不能超过 200 MB';
  return undefined;
}

/** 安装工作区桥接钩子，返回各自的注销函数。root 为会话工作区绝对路径 */
export function installWorkspaceBridge(ctx, root) {
  let chain = Promise.resolve();
  const exclusive = (operation) => {
    const task = chain.then(operation);
    chain = task.catch(() => {});
    return task;
  };
  return [
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.name !== WRITE && exec.name !== EDIT) return next();
      return exclusive(async () => {
        const full = resolve(root, String(exec.arguments?.file_path ?? ''));
        const bytes = await projectedBytes(full, exec);
        const denial = bytes === undefined ? undefined : await quotaDenial(root, full, bytes);
        if (denial) throw new Error(denial);
        const result = await next();
        if (result && !result.isError) {
          const stat = await lstat(full).catch(() => null);
          if (stat?.isFile())
            notify('forge.artifact', { path: toPosix(relative(root, full)), bytes: stat.size });
        }
        return result;
      });
    }),
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.name !== PRESENT) return next();
      const result = await next();
      if (!result || result.isError || !Array.isArray(result.value?.files)) return result;
      const files = [];
      const presented = [];
      for (const file of result.value.files) {
        const full = resolve(root, String(file?.path ?? ''));
        const path = toPosix(relative(root, full));
        files.push({ ...file, path });
        if (presented.some((item) => item.path === path)) continue;
        const stat = await lstat(full).catch(() => null);
        const description = typeof file.description === 'string' ? file.description.trim().slice(0, 200) : '';
        presented.push({ path, bytes: stat?.size ?? 0, ...(description ? { description } : {}) });
      }
      notify('forge.present', { callId: exec.callId, files: presented });
      // 模型看到的结果也换成工作区相对路径，不暴露服务器上的绝对路径
      return { ...result, value: { ...result.value, files } };
    }),
  ];
}
