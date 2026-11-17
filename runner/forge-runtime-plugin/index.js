/** Forge 业务插件：真实 OpenAI-compatible 模型出口 + 受限会话工具 + 门控。无假模型。 */
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';

export const name = 'forge-runtime';
export const inject = ['llm', 'tools', 'approval'];
const notify = (method, params) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const visibleText = (content) =>
  Array.isArray(content)
    ? content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
    : String(content ?? '');

function messages(options) {
  const out = options.system ? [{ role: 'system', content: options.system }] : [];
  for (const m of options.messages ?? []) {
    const text = visibleText(m.content);
    if (m.role === 'tool')
      out.push({ role: 'tool', content: text, tool_call_id: m.toolCallId ?? m.source?.callId });
    else if (m.role === 'assistant') {
      const calls = (m.content ?? [])
        .filter((b) => b.type === 'tool-call')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }));
      const reasoning = m.source?.replayState?.response?.reasoningContent;
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
        text = '',
        reasoning = '',
        textStarted = false,
        finish = 'stop',
        completed = false;
      const calls = new Map();
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
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        if (delta.content && typeof delta.content === 'string') {
          if (!textStarted) {
            textStarted = true;
            yield { type: 'block-start', index: 0, blockType: 'text' };
          }
          text += delta.content;
          notify('forge.delta', { text: delta.content });
          yield { type: 'text-delta', index: 0, text: delta.content };
        }
        for (const raw of delta.tool_calls ?? []) {
          const index = (raw.index ?? calls.size) + 1;
          let call = calls.get(index);
          if (!call) {
            call = { id: '', name: '', arguments: '' };
            calls.set(index, call);
            yield { type: 'block-start', index, blockType: 'tool-call' };
          }
          if (raw.id) call.id = raw.id;
          call.name += raw.function?.name ?? '';
          call.arguments += raw.function?.arguments ?? '';
          yield {
            type: 'tool-call-delta',
            index,
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
      if (textStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      for (const [index, call] of calls) {
        if (!call.id || !call.name) throw new Error('模型返回了不完整的工具调用');
        yield { type: 'block-end', index, block: { type: 'tool-call', ...call } };
      }
      if (!textStarted && !calls.size) throw new Error('模型返回了空响应');
      if (usage) {
        const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
        yield {
          type: 'usage',
          usage: {
            inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
            outputTokens: usage.completion_tokens ?? 0,
            cacheReadTokens: cached,
          },
        };
      }
      yield {
        type: 'finish',
        reason: { kind: calls.size ? 'tool-calls' : finish === 'length' ? 'max-tokens' : 'stop' },
        ...(reasoning ? { replayState: { response: { reasoningContent: reasoning } } } : {}),
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
  const connection = JSON.parse(process.env.FORGE_MODEL_CONFIG ?? '{}');
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
  add('workspace_list', 'List text artifacts in this session workspace only.', {}, [], async () => {
    return { files: await workspaceFiles(root) };
  });
  add(
    'workspace_read',
    'Read a text artifact from this session workspace.',
    { path: { type: 'string' } },
    ['path'],
    async ({ path }) => {
      const full = await checkedPath(root, path);
      const stat = await lstat(full);
      if (!stat.isFile() || stat.size > 256000) throw new Error('仅允许读取 256 KB 内的文本文件');
      return { path, content: await readFile(full, 'utf8') };
    },
  );
  add(
    'workspace_write',
    'Create a text artifact in this session workspace. User approval may be required.',
    { path: { type: 'string' }, content: { type: 'string' } },
    ['path', 'content'],
    async ({ path, content }) =>
      exclusiveWrite(async () => {
        if (Buffer.byteLength(String(content)) > 256000) throw new Error('单文件不能超过 256 KB');
        const full = await checkedPath(root, path, true);
        const existing = await workspaceFiles(root);
        const previous = existing.find((file) => file.path === relative(root, full));
        if (!previous && existing.length >= 100) throw new Error('每个会话最多保存 100 个文本产物');
        if (
          existing.reduce((sum, file) => sum + file.bytes, 0) -
            (previous?.bytes ?? 0) +
            Buffer.byteLength(String(content)) >
          10000000
        )
          throw new Error('会话产物总量不能超过 10 MB');
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, String(content), { mode: 0o600 });
        notify('forge.artifact', { path, bytes: Buffer.byteLength(String(content)) });
        return { path, bytes: Buffer.byteLength(String(content)), saved: true };
      }),
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
  disposers.push(
    ctx.on('tools/pre-execute', (exec, next) => {
      const decision = !allowed.has(exec.name)
        ? 'deny'
        : exec.name === 'workspace_write' && config.requireWriteApproval !== false
          ? 'ask'
          : 'allow';
      notify('forge.policy', { tool: exec.name, callId: exec.callId, arguments: exec.arguments, decision });
      if (decision === 'deny') return { kind: 'deny', reason: 'Forge 工具白名单拒绝' };
      if (decision === 'ask')
        return {
          kind: 'ask',
          reason: '生成或覆盖会话产物前，需要用户批准',
          displayReason: { en: 'Approve writing a session artifact?', 'zh-CN': '是否允许写入会话产物？' },
        };
      return next();
    }),
  );
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
