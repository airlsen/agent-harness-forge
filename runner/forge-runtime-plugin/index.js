/** Forge 业务插件：真实 OpenAI-compatible 模型出口 + 受限会话工具 + 门控。无假模型。 */
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';

export const name = 'forge-runtime';
export const inject = ['llm', 'tools', 'approval'];
const notify = (method, params) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_FILE_BYTES = 256000;
const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 10000000;
const MAX_PRESENTED = 4;
const MAX_READ_LINES = 2000;
/** DSH 搜索插件（dsh-tool-fs-search）提供的工具：由 Runner 基础 patch 加载，执行前由本插件限制搜索路径。 */
export const SEARCH_TOOLS = ['glob', 'grep'];
/**
 * glob/grep 的 path 参数会原样交给 ripgrep，而 ripgrep 可以读取宿主机任意路径：
 * 只允许会话工作区内的相对路径，不允许隐藏目录与符号链接。返回拒绝原因，允许时返回 undefined。
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
  if (parts.some((part) => part.startsWith('.'))) return '不允许搜索隐藏文件或目录';
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
/** DSH 原生只读 read（dsh-tool-fs，写入/编辑均关闭）：关联代码项目时由 Runner 开放 */
export const CODE_READ_TOOL = 'read';
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
/**
 * glob/grep 的 path 与 read 的 file_path 只能落在会话工作区或已关联的代码项目内。
 * - 工作区：沿用 searchPathDenial（相对路径，不允许隐藏目录与符号链接）；
 * - 代码项目（只读，绝对路径）：拒绝 .git 内部与密钥类文件；解析符号链接后仍须在该项目内。
 * projects 为 Runner 解析过符号链接的 [{name, path}]。返回拒绝原因，允许时返回 undefined。
 */
export function toolPathDenial(workspace, projects, exec) {
  const search = SEARCH_TOOLS.includes(exec.name);
  if (!search && exec.name !== CODE_READ_TOOL) return undefined;
  const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
  const raw = search ? args.path : args.file_path;
  // 不传 path 的搜索在会话工作目录（即工作区）内进行
  if (raw === undefined && search) return undefined;
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000 || raw.includes('\0'))
    return search ? '搜索路径无效' : '文件路径无效';
  const full = resolve(workspace, raw);
  if (within(workspace, full)) return searchPathDenial(workspace, { path: full });
  const project = projects.find((item) => within(item.path, full));
  if (!project)
    return projects.length
      ? `只能访问会话工作区与已关联的代码项目：${projects.map((item) => item.path).join('、')}`
      : '搜索路径超出当前会话工作区，请使用工作区内的相对路径';
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

function truncateCmd(cmd) {
  return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
}

/**
 * 对 bash 命令行进行三级安全门控分类：
 * - 'deny': 红色通道，硬性拦截高危破坏、提权、探测凭据、恶意网络外联
 * - 'allow': 绿色通道，只读查看与安全 Git 操作，自动放行无需审批
 * - 'ask': 黄色通道，修改、写操作、编译运行等，必须经由用户审批
 */
export function classifyBashCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    return { level: 'deny', reason: '命令内容不能为空' };
  }
  const clean = cmd.trim();

  // 1. 🔴 红色通道：硬性拦截（Deny）
  // (1) 破坏性系统命令
  if (
    /\brm\s+-[^\s]*[rf][^\s]*\s+(\/|~\/?|\.\.|\*|\$|\/etc|\/bin|\/usr|\/root)(?:\s|$|\/)/i.test(clean) ||
    /\b(mkfs|fdisk|parted|dd\s+if=|shutdown|reboot|poweroff|init\s+0|halt)\b/i.test(clean) ||
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i.test(clean)
  ) {
    return { level: 'deny', reason: '安全策略拒绝执行破坏性系统命令' };
  }

  // (2) 提权与切换用户
  if (/\b(sudo|su|pkexec|doas)\b/i.test(clean)) {
    return { level: 'deny', reason: '安全策略禁止使用提权命令 (sudo/su)' };
  }

  // (3) 探测凭据、密钥与平台环境变量
  if (
    /\b(cat|more|less|tail|head|grep|awk|sed)\s+.*(\/etc\/(shadow|gshadow|sudoers)|\.git-credentials|\.netrc|id_(rsa|dsa|ecdsa|ed25519))/i.test(
      clean,
    ) ||
    /(^|\s)(printenv|env)(\s|$)/i.test(clean) ||
    /\b(cat|head|tail|more|less)\s+.*\.env(\.local|\.production|\.development)?\b/i.test(clean)
  ) {
    return { level: 'deny', reason: '安全策略禁止探测系统凭据与敏感环境变量' };
  }

  // (4) 网络管道直接执行 (curl/wget | sh)
  if (/(curl|wget)[^|;&]+\|\s*(ba|z|k|c)?sh\b/i.test(clean)) {
    return { level: 'deny', reason: '安全策略禁止通过网络管道直接下载并执行脚本' };
  }

  // (5) 禁止危险的直接重定向覆写关键系统文件
  if (/>\s*\/etc\//i.test(clean) || />\s*\/boot\//i.test(clean)) {
    return { level: 'deny', reason: '安全策略禁止向系统核心路径重定向写入' };
  }

  // 2. 🟢 绿色通道：只读命令自动放行（Allow）
  // 检查是否含有写入重定向 (>, >>)；含有重定向的一律不能免审
  if (/[>]/.test(clean)) {
    return { level: 'ask', reason: `命令包含文件重定向写入: ${truncateCmd(clean)}` };
  }

  // 拆分管道并逐段核验
  const segments = clean
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  const isReadOnlySegment = (seg) => {
    // Git 只读子命令
    if (
      /^git\s+(status|branch|log|diff|show|tag|rev-parse|describe|remote|ls-files|shortlog|help|version|config\s+--get)\b/i.test(
        seg,
      )
    ) {
      // 排除带有输出重定向或写入参数的 git 命令
      return !/--output\b/i.test(seg);
    }

    // 常用只读查看工具
    if (
      /^(ls|dir|pwd|cat|head|tail|grep|egrep|fgrep|rg|wc|find|echo|which|whereis|file|tree|stat|uname|date|whoami|id)\b/i.test(
        seg,
      )
    ) {
      // 排除类似 find -delete, find -exec rm 等破坏性动作
      return !/\b(-delete|-exec\s+rm)\b/i.test(seg);
    }

    return false;
  };

  // 如果不含命令串联符号 (;, &&) 且所有管道段均为只读，则自动放行
  if (segments.length > 0 && segments.every(isReadOnlySegment) && !/[;&]/.test(clean)) {
    return { level: 'allow', reason: '只读命令自动放行' };
  }

  // 3. 🟡 黄色通道：其他操作发起审批（Ask）
  return { level: 'ask', reason: `模型请求执行终端命令: ${truncateCmd(clean)}` };
}
/**
 * 搜索结果中的密钥类文件：DSH 搜索为发现配置会包含隐藏与被忽略的文件（只排除 .git 等版本库目录），
 * 对关联项目搜索时会扫到 .env、*.pem 等。这里从 grep/glob 的结构化结果中剔除这些条目，
 * 返回新的 value 交由工具自己的 render 重新生成文本与卡片；没有剔除时原样返回。
 */
export function filterSecretResults(workspace, projects, exec, result) {
  if (!projects.length || !SEARCH_TOOLS.includes(exec.name)) return result;
  if (!result || result.isError || !result.value || typeof result.value !== 'object') return result;
  const secret = (path) => {
    if (typeof path !== 'string') return false;
    const full = resolve(workspace, path);
    const project = projects.find((item) => within(item.path, full));
    return Boolean(project) && secretPath(relative(project.path, full).split(sep).filter(Boolean));
  };
  const key = exec.name === 'grep' ? 'matches' : 'paths';
  const items = result.value[key];
  if (!Array.isArray(items)) return result;
  const kept = items.filter((item) => !secret(key === 'matches' ? item?.path : item));
  if (kept.length === items.length) return result;
  return { isError: false, value: { ...result.value, [key]: kept } };
}
/** 写入内容转字节：utf8 为默认文本；base64 用于图片等二进制产物（按解码后字节计入配额）。 */
function contentBytes(content, encoding = 'utf8') {
  if (encoding === 'utf8') return Buffer.from(String(content), 'utf8');
  if (encoding !== 'base64') throw new Error('encoding 仅支持 utf8 或 base64');
  const compact = String(content).replace(/\s+/g, '');
  if (compact.length % 4 === 1 || !BASE64.test(compact)) throw new Error('content 不是合法的 base64');
  return Buffer.from(compact, 'base64');
}
const visibleText = (content) =>
  Array.isArray(content)
    ? content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
    : String(content ?? '');

function messages(options) {
  const out = options.system ? [{ role: 'system', content: options.system }] : [];
  const history = options.messages ?? [];
  // 思考内容只回放本轮（最后一条用户消息之后，即工具调用循环内）的部分：
  // 推理模型要求工具循环内带回 reasoning_content，但跨轮回放既浪费上下文，
  // 也会把上一个模型的思考交给会话内切换后的新模型。
  let currentTurn = 0;
  history.forEach((m, index) => {
    if (m.role === 'user') currentTurn = index;
  });
  for (const [index, m] of history.entries()) {
    const text = visibleText(m.content);
    if (m.role === 'tool')
      out.push({ role: 'tool', content: text, tool_call_id: m.toolCallId ?? m.source?.callId });
    else if (m.role === 'assistant') {
      const calls = (m.content ?? [])
        .filter((b) => b.type === 'tool-call')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }));
      const reasoning = index > currentTurn ? m.source?.replayState?.response?.reasoningContent : undefined;
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      });
    } else if (['system', 'user', 'developer'].includes(m.role) && text)
      out.push({ role: m.role === 'developer' ? 'system' : m.role, content: text });
  }
  return out;
}
class GatewayAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
  }
  providerInfo(provider) {
    return { id: provider, name: 'Forge Enterprise Gateway' };
  }
  async listModels(provider) {
    return [{ provider, id: this.config.model, name: this.config.model, inputModalities: ['text'] }];
  }
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.config.contextWindow || 64000 },
      inputModalities: ['text'],
    };
  }
  async *stream(options) {
    const headers = {
      'Content-Type': 'application/json',
      ...attributionHeaders(),
      'X-Title': 'AgentHarness Forge',
    };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const permitted = new Set(this.config.allowedTools);
    const schemas = (options.tools ?? []).filter((t) => permitted.has(t.name));
    const payload = {
      model: options.model,
      messages: messages(options),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens ?? this.config.maxOutputTokens ?? 4096,
    };
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    if (schemas.length)
      payload.tools = schemas.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout((this.config.requestTimeoutSeconds ?? 120) * 1000),
    ]);
    let response;
    try {
      response = await fetch(this.config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
        redirect: 'error',
      });
      if (!response.ok)
        throw new Error(`模型网关 HTTP ${response.status}，请检查模型中心的地址、模型名和凭据`);
      if (!response.body) throw new Error('模型网关未返回响应流');
      let usage,
        finish = 'stop',
        completed = false;
      // 块索引按内容首次出现动态分配。reasoning 在正文或工具调用开始时封闭；
      // 之后再出现（交错思考）则开启新块，保证每个块只收自己的增量。
      let nextIndex = 0,
        reasoningIndex = -1,
        reasoning = '',
        reasoningAll = '',
        textIndex = -1,
        text = '';
      const calls = new Map();
      const closeReasoning = function* () {
        if (reasoningIndex < 0) return;
        yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } };
        reasoningIndex = -1;
        reasoning = '';
      };
      const handle = function* (value) {
        if (value.error) throw new Error('模型网关返回错误响应，请检查模型配置');
        if (value.usage) usage = value.usage;
        const choice = value.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) {
          finish = choice.finish_reason;
          completed = true;
        }
        const delta = choice.delta ?? choice.message ?? {};
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          if (reasoningIndex < 0) {
            reasoningIndex = nextIndex++;
            reasoning = '';
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' };
          }
          reasoning += delta.reasoning_content;
          reasoningAll += delta.reasoning_content;
          notify('forge.reasoning_delta', { text: delta.reasoning_content });
          yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content };
        }
        if (delta.content && typeof delta.content === 'string') {
          yield* closeReasoning();
          if (textIndex < 0) {
            textIndex = nextIndex++;
            yield { type: 'block-start', index: textIndex, blockType: 'text' };
          }
          text += delta.content;
          notify('forge.delta', { text: delta.content });
          yield { type: 'text-delta', index: textIndex, text: delta.content };
        }
        if (delta.tool_calls?.length) yield* closeReasoning();
        for (const raw of delta.tool_calls ?? []) {
          const key = raw.index ?? calls.size;
          let call = calls.get(key);
          if (!call) {
            call = { id: '', name: '', arguments: '', blockIndex: nextIndex++ };
            calls.set(key, call);
            yield { type: 'block-start', index: call.blockIndex, blockType: 'tool-call' };
          }
          if (raw.id) call.id = raw.id;
          call.name += raw.function?.name ?? '';
          call.arguments += raw.function?.arguments ?? '';
          yield {
            type: 'tool-call-delta',
            index: call.blockIndex,
            id: call.id,
            ...(raw.function?.name ? { name: raw.function.name } : {}),
            argumentsDelta: raw.function?.arguments ?? '',
          };
        }
      };
      if (response.headers.get('content-type')?.includes('application/json')) {
        yield* handle(await response.json());
      } else {
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of response.body) {
          buf += decoder.decode(chunk, { stream: true });
          let boundary;
          while ((boundary = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, boundary).trim();
            buf = buf.slice(boundary + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            // [DONE] 只表示传输结束，不能替代模型的 finish_reason。
            if (data === '[DONE]') continue;
            if (!data) continue;
            yield* handle(JSON.parse(data));
          }
        }
        if (buf.trim().startsWith('data:') && !buf.includes('[DONE]'))
          yield* handle(JSON.parse(buf.trim().slice(5)));
      }
      if (!completed) throw new Error('模型响应流提前结束，请重试');
      if (!['stop', 'tool_calls', 'length'].includes(finish))
        throw new Error('模型响应被拦截或未能正常完成，请检查模型服务');
      if (calls.size && finish === 'length')
        throw new Error('模型工具调用达到输出上限，未执行不完整的调用，请调整输出上限后重试');
      yield* closeReasoning();
      if (textIndex >= 0) yield { type: 'block-end', index: textIndex, block: { type: 'text', text } };
      for (const call of calls.values()) {
        if (!call.id || !call.name) throw new Error('模型返回了不完整的工具调用');
        yield {
          type: 'block-end',
          index: call.blockIndex,
          block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
        };
      }
      if (textIndex < 0 && !calls.size) throw new Error('模型返回了空响应');
      if (usage) {
        const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
        yield {
          type: 'usage',
          usage: {
            inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
            outputTokens: usage.completion_tokens ?? 0,
            cacheReadTokens: cached,
            ...(usage.completion_tokens_details?.reasoning_tokens
              ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
              : {}),
          },
        };
      }
      yield {
        type: 'finish',
        reason: { kind: calls.size ? 'tool-calls' : finish === 'length' ? 'max-tokens' : 'stop' },
        ...(reasoningAll ? { replayState: { response: { reasoningContent: reasoningAll } } } : {}),
      };
    } catch (error) {
      const message = options.signal?.aborted
        ? '任务已中止'
        : error instanceof Error && /^模型/.test(error.message)
          ? error.message
          : '模型请求失败或超时，请检查模型中心配置';
      notify('forge.error', { message });
      throw new Error(message);
    }
  }
}
async function checkedPath(root, name, writing = false) {
  if (!name || name.length > 200 || name.includes('\0')) throw new Error('文件路径无效');
  const full = resolve(root, name);
  if (full === root || !full.startsWith(root + sep)) throw new Error('文件路径超出当前会话工作区');
  let current = root;
  const parts = relative(root, full).split(sep);
  if (parts.length > 8 || parts.some((part) => part.startsWith('.')))
    throw new Error('不允许隐藏文件或超过 8 层的目录');
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('不允许符号链接');
    } catch (error) {
      if (error.code !== 'ENOENT' || !writing) throw error;
    }
  }
  return full;
}
async function workspaceFiles(root, dir = root, depth = 0) {
  const files = [];
  if (depth > 8) return files;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await workspaceFiles(root, path, depth + 1)));
    else if (entry.isFile()) files.push({ path: relative(root, path), bytes: (await lstat(path)).size });
    if (files.length > 100) break;
  }
  return files;
}
export async function apply(ctx, config) {
  // 变量名含 SECRET：DSH 为 stdio MCP 子进程清洗环境变量时会剔除它，模型密钥不会泄露给外部程序
  const connection = JSON.parse(process.env.FORGE_MODEL_SECRET_CONFIG ?? '{}');
  if (!connection.baseUrl || !connection.model) throw new Error('Forge model gateway is not configured');
  const allowed = new Set(config.allowedTools ?? []);
  const root = resolve(config.workspace);
  await mkdir(root, { recursive: true });
  // 同一轮模型可并发调用工具；把配额检查与写盘串行化，避免越过文件数/总量上限。
  let writeChain = Promise.resolve();
  const exclusiveWrite = (operation) => {
    const task = writeChain.then(operation);
    writeChain = task.catch(() => {});
    return task;
  };
  const disposers = [
    ctx.llm.registerAdapter(['forge-gateway'], new GatewayAdapter({ ...connection, ...config })),
  ];
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
    'Read a text file from this session workspace (read-only, workspace-relative path). Optionally pass offset (1-based start line) and limit (number of lines) to read a range, e.g. around a grep match.',
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
      const full = await checkedPath(root, path);
      const stat = await lstat(full);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('仅允许读取 256 KB 内的文本文件');
      let content;
      try {
        content = utf8.decode(await readFile(full));
      } catch {
        throw new Error('这是二进制文件，无法按文本读取；用户可在结果面板预览或下载');
      }
      if (offset === undefined && limit === undefined) return { path, content };
      const start = Number.isInteger(offset) && offset > 0 ? offset : 1;
      const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_READ_LINES) : MAX_READ_LINES;
      const lines = content.split(/\r?\n/);
      if (lines.length > 1 && lines.at(-1) === '') lines.pop();
      const slice = lines.slice(start - 1, start - 1 + count);
      return {
        path,
        content: slice.join('\n'),
        startLine: start,
        endLine: slice.length ? start + slice.length - 1 : start - 1,
        totalLines: lines.length,
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
        if (data.length > MAX_FILE_BYTES) throw new Error('单文件不能超过 256 KB');
        const full = await checkedPath(root, path, true);
        const existing = await workspaceFiles(root);
        const previous = existing.find((file) => file.path === relative(root, full));
        if (!previous && existing.length >= MAX_FILES) throw new Error('每个会话最多保存 100 个文件');
        if (
          existing.reduce((sum, file) => sum + file.bytes, 0) - (previous?.bytes ?? 0) + data.length >
          MAX_TOTAL_BYTES
        )
          throw new Error('会话产物总量不能超过 10 MB');
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
  // restrict() 必须通过 agent.ctx 安装；全局上下文会被 dsh 拒绝。
  // agent/created 为串行、可等待事件，首轮提示词装配前即生效。
  disposers.push(
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.restrict({ allow: [...allowed] });
    }),
  );
  // guard 只有 deny，没有 allow，后续插件无法重新放开被禁用的工具。
  disposers.push(
    ctx.tools.guard((exec) => (allowed.has(exec.name) ? undefined : 'Forge 当前部署禁止执行此工具')),
  );
  // 搜索与只读 read 来自 DSH 官方插件，其路径参数不受工作区约束；
  // 在执行前统一收窄到会话工作区与已关联的代码项目（只读）。
  // 只读根目录 = 已关联的代码项目 ∪ Skill 参考资料目录（Runner 物化，模型用 read 按需读取）
  const readRoots = [
    ...(Array.isArray(config.codeProjects) ? config.codeProjects : []),
    ...(Array.isArray(config.readRoots) ? config.readRoots : []),
  ].filter((item) => item && typeof item.path === 'string');
  const codeProjects = readRoots;
  disposers.push(ctx.tools.guard((exec) => toolPathDenial(root, codeProjects, exec)));
  if (codeProjects.length)
    disposers.push(
      ctx.on('tools/execute', async (exec, next) =>
        filterSecretResults(root, codeProjects, exec, await next()),
      ),
    );
  // bash 工具输出脱敏：避免通过 git remote -v、输出回显等泄漏包含 token 的远程地址与密钥
  disposers.push(
    ctx.on('tools/execute', async (exec, next) => {
      const result = await next();
      if (exec.name === 'bash' && result && typeof result === 'object' && typeof result.value === 'string') {
        return { ...result, value: sanitizeGitOutput(result.value) };
      }
      return result;
    }),
  );
  // 管理员标记为「需确认」的外部工具（MCP）：每次调用都要用户批准
  const approvalTools = new Set((config.approvalTools ?? []).filter((name) => allowed.has(name)));
  disposers.push(
    ctx.on('tools/pre-execute', (exec, next) => {
      // 1. 白名单拦截
      if (!allowed.has(exec.name)) {
        notify('forge.policy', {
          tool: exec.name,
          callId: exec.callId,
          arguments: exec.arguments,
          decision: 'deny',
        });
        return { kind: 'deny', reason: 'Forge 工具白名单拒绝' };
      }

      // 2. bash 工具三级门控分流：红通道拦截(deny)、绿通道放行(allow)、黄通道审批(ask)
      if (exec.name === 'bash') {
        const classification = classifyBashCommand(exec.arguments?.command);
        notify('forge.policy', {
          tool: exec.name,
          callId: exec.callId,
          arguments: exec.arguments,
          decision: classification.level,
        });
        if (classification.level === 'deny') {
          return { kind: 'deny', reason: classification.reason };
        }
        if (classification.level === 'ask') {
          return { kind: 'ask', reason: classification.reason };
        }
        return next();
      }

      // 3. 管理员标记为「需确认」的外部工具（MCP）：每次调用都要用户批准
      if (approvalTools.has(exec.name)) {
        notify('forge.policy', {
          tool: exec.name,
          callId: exec.callId,
          arguments: exec.arguments,
          decision: 'ask',
        });
        return {
          kind: 'ask',
          reason: '该工具由外部 MCP 服务提供，管理员要求每次调用前经用户确认',
          displayReason: { en: 'Allow this external tool call?', 'zh-CN': '是否允许调用这个外部工具？' },
        };
      }

      // 4. 会话工作区受限工具（如写入/读取/时间等）直接放行
      notify('forge.policy', {
        tool: exec.name,
        callId: exec.callId,
        arguments: exec.arguments,
        decision: 'allow',
      });
      return next();
    }),
  );
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
