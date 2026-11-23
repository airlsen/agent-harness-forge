/** 会话工作区文件：清单、读取、删除与清理。路径一律限制在 DATA/<id>/workspace 内，拒绝隐藏文件与符号链接。 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { mimeType } from './mime.js';
import { failure, isSessionId } from './errors.js';

/** 清单上限：高于插件的 1000 个文件配额（bash 产出不受该配额约束）；达到上限时标记 truncated，控制面不会据此删除记录 */
export const MAX_LISTED_FILES = 2000;
/** 清单遍历的最大目录深度，与 workspace_write 允许的层级一致 */
const MAX_LISTED_DEPTH = 16;
const MAX_RAW_BYTES = 20 * 1024 * 1024;

export class WorkspaceFiles {
  /** isBusy：会话正在执行时拒绝删除与清理 */
  constructor(
    private readonly dataDir: string,
    private readonly isBusy: (id: string) => boolean,
  ) {}
  private async workspace(id: string) {
    if (!isSessionId(id)) throw failure('会话标识无效', 422);
    const root = join(this.dataDir, id, 'workspace');
    try {
      if (!(await lstat(root)).isDirectory()) throw new Error();
    } catch {
      throw failure('未找到会话产物目录', 404);
    }
    return root;
  }
  async listFiles(id: string) {
    const root = await this.workspace(id);
    const out: { path: string; bytes: number; mime: string; modifiedAt: string; sha256: string }[] = [];
    const walk = async (dir: string, depth = 0): Promise<void> => {
      if (depth > MAX_LISTED_DEPTH || out.length >= MAX_LISTED_FILES) return;
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink() || item.name.startsWith('.')) continue;
        const full = join(dir, item.name);
        if (item.isDirectory()) await walk(full, depth + 1);
        else if (item.isFile()) {
          const stat = await lstat(full);
          const path = full
            .slice(root.length + 1)
            .split(sep)
            .join('/');
          // 内容哈希供控制面增量同步：未变化的文件无需重新拉取
          const sha256 = createHash('sha256')
            .update(await readFile(full))
            .digest('hex');
          out.push({
            path,
            bytes: stat.size,
            mime: mimeType(path),
            modifiedAt: stat.mtime.toISOString(),
            sha256,
          });
        }
        if (out.length >= MAX_LISTED_FILES) break;
      }
    };
    await walk(root);
    return out;
  }
  /** 校验并解析工作区内的文件路径：禁止越界、隐藏文件与符号链接。 */
  private async workspaceFile(id: string, path: string) {
    const root = await this.workspace(id),
      full = resolve(root, path ?? '');
    if (!path || full === root || !full.startsWith(root + sep)) throw failure('文件路径超出会话工作区', 422);
    let current = root;
    try {
      for (const part of full.slice(root.length + 1).split(sep)) {
        if (part.startsWith('.')) throw failure('不允许读取隐藏文件', 422);
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink()) throw failure('不允许符号链接', 422);
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw failure('文件不存在或已被删除', 404);
      throw error;
    }
    const stat = await lstat(full);
    if (!stat.isFile()) throw failure('不是普通文件', 422);
    return { full, stat };
  }
  async readFile(id: string, path: string) {
    const { full, stat } = await this.workspaceFile(id, path);
    if (stat.size > 256000) throw failure('仅支持 256 KB 内的文本文件', 422);
    return readFile(full, 'utf8');
  }
  /** 用户在界面上删除文件：执行中拒绝，删除后清理空目录。 */
  async deleteFile(id: string, path: string) {
    if (this.isBusy(id)) throw failure('会话正在执行，请等待本轮结束后再删除文件', 409);
    const root = await this.workspace(id);
    const { full } = await this.workspaceFile(id, path);
    await unlink(full);
    for (let dir = dirname(full); dir !== root && dir.startsWith(root + sep); dir = dirname(dir)) {
      try {
        await rmdir(dir);
      } catch {
        break; // 目录非空
      }
    }
  }
  /** 保留期限到期：清空会话工作区（目录本身保留，会话仍可继续使用）。 */
  async purgeWorkspace(id: string) {
    if (this.isBusy(id)) throw failure('会话正在执行，暂不能清理文件', 409);
    const root = await this.workspace(id);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  /** 原始字节读取：用于任意类型文件的预览与下载（单文件不超过 20 MB）。 */
  async readRaw(id: string, path: string) {
    const { full, stat } = await this.workspaceFile(id, path);
    if (stat.size > MAX_RAW_BYTES) throw failure('文件过大，无法读取', 413);
    return { data: await readFile(full), mime: mimeType(full), bytes: stat.size };
  }
}
