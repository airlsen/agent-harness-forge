/**
 * bash 门控规则：命令分类（deny-list-only，只拦截少数明显高危的命令）与输出中 Git 凭据的脱敏。
 * bash 工具本身来自 dsh（dsh-tool-bash，命令在 dsh 沙箱中执行，只能写入会话工作区）；
 * 沙箱只管文件写入，读取凭据、提权等仍由这里拦截。纯函数、可单独测试。
 */
import { basename, dirname } from 'node:path';

/**
 * 脱敏输出中的 Git 敏感信息（如含凭据的 Remote URL、Token 等）
 */
export function sanitizeGitOutput(text) {
  if (!text || typeof text !== 'string') return text;
  // 脱敏形如 https://user:token@github.com 或 https://token@github.com 的 URL 凭据
  let cleaned = text.replace(/(https?:\/\/)([^:\/\s@]+):([^@\s\/]+)@/g, '$1$2:***@');
  cleaned = cleaned.replace(/(https?:\/\/)gh[pousr]_[A-Za-z0-9_]+@/g, '$1***@');
  // 脱敏出现的独立 GitHub/通用 Personal Access Token
  cleaned = cleaned.replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,255}\b/g, '***REDACTED***');
  return cleaned;
}

/** 内核 Landlock 版本较旧时沙箱启动器每条命令都会打印的提示：对模型是噪音，状态已在 /v1/runtime 上报 */
const SANDBOX_NOTICE = /^landlock-run: partial enforcement[^\n]*(?:\n|$)/gm;

/** 终端结果（字符串或 stdout / stderr / output 等嵌套字段）中的每个字符串都脱敏，结构保持不变 */
export function sanitizeShellValue(value, depth = 0) {
  if (typeof value === 'string') return sanitizeGitOutput(value.replace(SANDBOX_NOTICE, ''));
  if (depth > 4 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeShellValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeShellValue(item, depth + 1)]));
}

/** 命令起始位置：行首，或 ; & | ( 换行、$( 、反引号之后 */
const COMMAND_START = String.raw`(?:^|[;&|(\n]|\$\(|\x60)\s*`;
const atCommandStart = (names) => new RegExp(`${COMMAND_START}(?:${names})(?=\\s|$|[;&|)\\x60])`, 'i');
const SYSTEM_COMMAND = atCommandStart(
  String.raw`mkfs(?:\.\w+)?|fdisk|parted|shutdown|reboot|poweroff|halt|init\s+[06]`,
);
const PRIVILEGE_COMMAND = atCommandStart('sudo|su|pkexec|doas');
const ENV_DUMP = new RegExp(
  `${COMMAND_START}(?:printenv\\b|env\\s*(?=$|[;&|>)\\n]))|\\/proc\\/[^\\s]*\\/environ`,
  'i',
);
/** rm 递归删除的高危目标：根目录、家目录与系统目录本身 */
const DANGEROUS_RM_TARGET =
  /^(?:\/|\/\*|~|~\/|~\/\*|\$HOME\/?\*?|\$\{HOME\}\/?\*?|\/(?:bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var)\/?\*?)$/;
function dangerousRm(command) {
  for (const match of command.matchAll(/(?:^|[\s;&|(])rm\s+([^;&|\n]*)/g)) {
    const words = match[1]
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.replace(/^['"]|['"]$/g, ''));
    const recursive = words.some((word) => /^-[^-]*[rR]/.test(word) || word === '--recursive');
    if (recursive && words.some((word) => DANGEROUS_RM_TARGET.test(word))) return true;
  }
  return false;
}
/**
 * 访问其他会话的数据目录：会话目录为 <数据目录>/<会话 id>/workspace，
 * 命令里出现数据目录下除本会话以外的路径（或列出整个数据目录）时拒绝；本会话自己的目录放行。
 */
function otherSessionAccess(command, workspace) {
  const own = workspace ? basename(dirname(workspace)) : '';
  const roots = ['data/sessions'];
  if (workspace) roots.unshift(dirname(dirname(workspace)));
  for (const root of roots) {
    let index = command.indexOf(root);
    while (index >= 0) {
      const rest = command.slice(index + root.length);
      const segment = rest.startsWith('/') ? (rest.slice(1).match(/^[^/\s'"]*/)?.[0] ?? '') : '';
      if (!own || segment !== own) return true;
      index = command.indexOf(root, index + root.length);
    }
  }
  return false;
}

/**
 * 对 bash 命令行进行安全门控分类（deny-list-only）：只拦截少数明显高危的命令，其余一律放行。
 * - 递归删除根目录、家目录或系统目录本身；格式化磁盘、关机重启（仅当它们作为命令出现）；fork 炸弹；向 /dev 写入的 dd
 * - 提权与切换用户（sudo/su/pkexec/doas，仅当作为命令出现）
 * - 平台自身的密钥（data/encryption.key、data/auth.json）与其他会话的数据目录
 * - 输出全部环境变量（printenv、不带参数的 env、/proc/<pid>/environ）：模型密钥在 Runner 进程环境中
 * - 重定向写入 /etc、/boot；通过网络管道下载后直接执行脚本（curl … | sh）
 * curl/wget 等网络请求（含外部地址）不拦截。
 * workspace 为当前会话工作区（用于放行本会话自己的数据目录）。调用方仍兼容 'ask'，分类器不再返回该级别。
 */
export function classifyBashCommand(cmd, { workspace } = {}) {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    return { level: 'deny', reason: '命令内容不能为空' };
  }
  const clean = cmd.trim();
  if (
    dangerousRm(clean) ||
    SYSTEM_COMMAND.test(clean) ||
    /\bdd\b[^;&|\n]*\bof=\/dev\//i.test(clean) ||
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(clean)
  ) {
    return { level: 'deny', reason: '安全策略拒绝执行破坏性系统命令' };
  }
  if (PRIVILEGE_COMMAND.test(clean)) {
    return { level: 'deny', reason: '安全策略禁止使用提权命令 (sudo/su)' };
  }
  if (/data\/(?:encryption\.key|auth\.json)/i.test(clean)) {
    return { level: 'deny', reason: '安全策略禁止访问平台密钥文件' };
  }
  if (otherSessionAccess(clean, workspace)) {
    return { level: 'deny', reason: '安全策略禁止访问其他会话的数据' };
  }
  if (ENV_DUMP.test(clean)) {
    return { level: 'deny', reason: '安全策略禁止输出全部环境变量' };
  }
  // 通过网络管道直接下载并执行脚本；curl/wget 本身（含外部地址）不拦截
  if (/(curl|wget)[\s\S]*\|\s*(ba|z|k|c)?sh\b/i.test(clean)) {
    return { level: 'deny', reason: '安全策略禁止通过网络管道直接下载并执行脚本' };
  }
  if (/>\s*\/(?:etc|boot)\//i.test(clean)) {
    return { level: 'deny', reason: '安全策略禁止向系统核心路径重定向写入' };
  }
  // deny-list-only：其余默认放行。文件写入边界由 dsh 沙箱负责，这里的黑名单只挡明显危险的操作
  return { level: 'allow', reason: '非禁止命令自动放行（deny-list-only）' };
}
