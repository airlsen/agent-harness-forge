/**
 * 路径守卫：把带路径参数的 dsh 原生工具收窄到允许的范围，并剔除搜索结果中的密钥类文件。
 * - 读取与搜索（read / glob / grep）：会话工作区与已关联的只读目录（代码项目、Skill 快照、大结果转存目录）；
 * - 写入、修改与交付（write / edit / present）：只能是会话工作区内的非隐藏路径——.skill/ 是 Skill 草稿的只读镜像
 *   （草稿须经 skill_write_file 修改），隐藏文件也不会同步到会话文件区。dsh 的文件沙箱只限制写入、按工作区根目录放行，
 *   这里再补上隐藏路径、目录层级与符号链接的约束。
 * 哪些工具带路径、路径在哪个参数，来自 DSH 适配层的 engine-tools.js（与内核共用的唯一一份）。
 */
import { lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
import { PATH_TOOLS } from '../../src/kernel/dsh/engine-tools.js';
import { MAX_DEPTH, MAX_PATH_CHARS } from './limits.js';

const SECRET_DIRS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.docker', '.kube']);
const SECRET_FILE =
  /^(\.env(\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|p12|pfx|jks|keystore))$/i;
const SAFE_SUFFIX = /\.(example|sample|template|dist)$/i;
/** 版本库内部数据与密钥类文件：即使在关联项目内也不允许读取或搜索 */
function secretPath(parts) {
  if (parts.some((part) => SECRET_DIRS.has(part))) return true;
  const last = parts.at(-1) ?? '';
  return SECRET_FILE.test(last) && !SAFE_SUFFIX.test(last);
}
const within = (root, path) => path === root || path.startsWith(root + sep);
const pathTool = (name) => (Object.hasOwn(PATH_TOOLS, name) ? PATH_TOOLS[name] : undefined);

/**
 * 搜索的 path 参数会原样交给 ripgrep，而 ripgrep 可以读取宿主机任意路径：
 * 只允许会话工作区内的相对路径，不允许符号链接与密钥类文件；隐藏目录（如 Skill 草稿镜像 .skill/）可以搜索。
 * 返回拒绝原因，允许时返回 undefined。
 */
export function searchPathDenial(root, args) {
  const path = args && typeof args === 'object' ? args.path : undefined;
  if (path === undefined) return undefined;
  if (typeof path !== 'string' || !path.trim() || path.length > 400 || path.includes('\0'))
    return '搜索路径无效';
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep))
    return '搜索路径超出当前会话工作区，请使用工作区内的相对路径';
  const parts = relative(root, full).split(sep).filter(Boolean);
  if (secretPath(parts)) return '不允许访问版本库内部数据或密钥类文件';
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return '不允许通过符号链接搜索';
    } catch (error) {
      // 路径不存在时交给 ripgrep 报告「找不到」；其他错误一律拒绝
      return error.code === 'ENOENT' ? undefined : '搜索路径无法访问';
    }
  }
  return undefined;
}

/**
 * 搜索与只读 read 的路径只能落在会话工作区或已关联的只读目录（代码项目、Skill 快照）内。
 * - 工作区：沿用 searchPathDenial（相对路径，不允许符号链接与密钥类文件）；
 * - 只读目录（绝对路径）：拒绝 .git 内部与密钥类文件；解析符号链接后仍须在该目录内。
 * projects 为 Runner 解析过符号链接的 [{name, path}]。返回拒绝原因，允许时返回 undefined。
 */
export function toolPathDenial(workspace, projects, exec) {
  const tool = pathTool(exec.name);
  if (!tool) return undefined;
  const search = tool.search;
  const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
  if (tool.workspace) {
    const items = tool.items ? args[tool.arg] : [args[tool.arg]];
    // 数组参数的形状（数量、必填）由工具自己校验，这里只看每个路径
    if (!Array.isArray(items)) return undefined;
    for (const item of items) {
      const denial = workspacePathDenial(workspace, tool.items ? item?.[tool.items] : item);
      if (denial) return denial;
    }
    return undefined;
  }
  const raw = args[tool.arg];
  // 不传 path 的搜索在会话工作目录（即工作区）内进行
  if (raw === undefined && search) return undefined;
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000 || raw.includes('\0'))
    return search ? '搜索路径无效' : '文件路径无效';
  const full = resolve(workspace, raw);
  if (within(workspace, full)) return searchPathDenial(workspace, { path: full });
  const project = projects.find((item) => within(item.path, full));
  if (!project) {
    // 只列出用户关联的代码项目；Skill 快照与长输出转存目录由系统提示或工具结果给出，不在这里罗列
    const code = projects.filter((item) => item.name !== 'spill' && !item.name.startsWith('skill:'));
    return code.length
      ? `只能访问会话工作区与已关联的代码项目：${code.map((item) => item.path).join('、')}`
      : '搜索路径超出当前会话工作区，请使用工作区内的相对路径';
  }
  if (secretPath(relative(project.path, full).split(sep).filter(Boolean)))
    return '不允许读取版本库内部数据或密钥类文件';
  // 目标或其最近的已存在上级解析符号链接后必须仍在该项目内；不存在的路径交给工具报告「找不到」
  let probe = full;
  for (;;) {
    try {
      const real = realpathSync(probe);
      if (!within(project.path, real)) return '不允许通过符号链接访问代码项目之外的路径';
      if (secretPath(relative(project.path, real).split(sep).filter(Boolean)))
        return '不允许读取版本库内部数据或密钥类文件';
      return undefined;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return '路径无法访问';
      const parent = dirname(probe);
      if (parent === probe || !within(project.path, parent)) return undefined;
      probe = parent;
    }
  }
}

/**
 * 搜索结果中的密钥类文件：DSH 搜索为发现配置会包含隐藏与被忽略的文件（只排除 .git 等版本库目录），
 * 对关联项目搜索时会扫到 .env、*.pem 等。这里从搜索工具的结构化结果中剔除这些条目，
 * 返回新的 value 交由工具自己的 render 重新生成文本与卡片；没有剔除时原样返回。
 */
export function filterSecretResults(workspace, projects, exec, result) {
  const tool = pathTool(exec.name);
  if (!projects.length || !tool?.search || !tool.results) return result;
  if (!result || result.isError || !result.value || typeof result.value !== 'object') return result;
  const secret = (path) => {
    if (typeof path !== 'string') return false;
    const full = resolve(workspace, path);
    const project = projects.find((item) => within(item.path, full));
    return Boolean(project) && secretPath(relative(project.path, full).split(sep).filter(Boolean));
  };
  const items = result.value[tool.results];
  if (!Array.isArray(items)) return result;
  const kept = items.filter((item) => !secret(tool.resultPath ? item?.[tool.resultPath] : item));
  if (kept.length === items.length) return result;
  return { isError: false, value: { ...result.value, [tool.results]: kept } };
}

/**
 * 写入、修改与交付的路径：只能在会话工作区内（相对路径或工作区内的绝对路径），不允许隐藏路径、符号链接，
 * 目录不超过 MAX_DEPTH 层。不存在的路径（新建文件）允许。返回拒绝原因，允许时返回 undefined。
 */
export function workspacePathDenial(root, name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 1000 || name.includes('\0'))
    return '文件路径无效';
  const full = resolve(root, name);
  if (full === root || !full.startsWith(root + sep))
    return '只能写入或交付当前会话工作区内的文件，请使用工作区内的相对路径';
  const parts = relative(root, full).split(sep);
  if (parts.join('/').length > MAX_PATH_CHARS) return `文件路径不能超过 ${MAX_PATH_CHARS} 个字符`;
  if (parts.length > MAX_DEPTH) return `目录层级不能超过 ${MAX_DEPTH} 层`;
  if (parts.some((part) => part.startsWith('.'))) return '不允许写入或交付隐藏文件与隐藏目录（如 .skill/）';
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return '不允许通过符号链接写入或交付';
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      return '文件路径无法访问';
    }
  }
  return undefined;
}
