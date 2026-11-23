/**
 * 模型网关：真实 OpenAI-compatible 出口（dsh LlmAdapter 实现，无假模型）。
 * 负责历史回放（含 DeepSeek 思考内容）、流式解析与错误归一，流式增量经 Forge 事件实时推给 Runner。
 */
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { notify } from '../shared/events.js';

const visibleText = (content) =>
  Array.isArray(content)
    ? content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
    : String(content ?? '');

/** 同一模型产出的历史思考内容：取自持久化的 reasoning 块（与 DSH 一致），旧会话回退到 replayState。 */
function ownReasoning(m, model) {
  if (m.source?.model !== model) return '';
  const blocks = Array.isArray(m.content) ? m.content.filter((b) => b.type === 'reasoning') : [];
  if (blocks.length) return blocks.map((b) => String(b.text ?? '')).join('');
  return m.source?.replayState?.response?.reasoningContent ?? '';
}
/** DeepSeek 思考模式：按模型名或网关地址识别（企业网关地址不一定含 deepseek.com）。 */
const isDeepSeek = (model, baseUrl) =>
  /deepseek/i.test(String(model ?? '')) || /deepseek/i.test(String(baseUrl ?? ''));

/**
 * 历史回放与 DSH（dsh-llm-pi-ai 的 OpenAI 兼容序列化）一致：
 * - 同一模型产出的每条 assistant 消息都原样带回 reasoning_content，不区分轮次、不区分是否调用过工具；
 *   DeepSeek 规定调用过工具的轮次在之后每次请求都必须带回，否则返回 400。
 * - 会话内切换模型后，上一个模型的思考不交给新模型；
 * - 目标是 DeepSeek 时，没有思考内容的 assistant 消息补空字符串（旧会话、切换模型前的历史都能继续）。
 */
function messages(options, baseUrl) {
  const out = options.system ? [{ role: 'system', content: options.system }] : [];
  const history = options.messages ?? [];
  const deepseek = isDeepSeek(options.model, baseUrl);
  for (const m of history) {
    const text = visibleText(m.content);
    if (m.role === 'tool')
      out.push({ role: 'tool', content: text, tool_call_id: m.toolCallId ?? m.source?.callId });
    else if (m.role === 'assistant') {
      const calls = (m.content ?? [])
        .filter((b) => b.type === 'tool-call')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }));
      const reasoning = ownReasoning(m, options.model);
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(reasoning || deepseek ? { reasoning_content: reasoning } : {}),
      });
    } else if (['system', 'user', 'developer'].includes(m.role) && text)
      out.push({ role: m.role === 'developer' ? 'system' : m.role, content: text });
  }
  return out;
}
/**
 * 网关非 2xx：带上服务端给出的原因（如 DeepSeek 的 invalid_request_error 说明），只有鉴权失败才提示检查凭据。
 * 原因截断到 300 字并去掉换行，配置的密钥若被回显则替换掉；读取失败时只报状态码。
 */
async function gatewayFailure(response, apiKey) {
  const status = response.status;
  let detail = '';
  try {
    const raw = await response.text();
    try {
      const body = JSON.parse(raw);
      detail =
        body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : '') ?? '';
    } catch {
      detail = raw;
    }
  } catch {
    detail = '';
  }
  detail = String(detail);
  if (apiKey) detail = detail.split(apiKey).join('***');
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (status === 401 || status === 403)
    return `模型网关拒绝访问（HTTP ${status}），请检查模型中心的凭据${detail ? `：${detail}` : ''}`;
  if (status === 404) return `模型网关 HTTP 404，请检查模型中心的地址和模型名${detail ? `：${detail}` : ''}`;
  return `模型网关 HTTP ${status}${detail ? `：${detail}` : '，请稍后重试或联系管理员检查模型服务'}`;
}
export class GatewayAdapter extends LlmAdapter {
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
      messages: messages(options, this.config.baseUrl),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens ?? this.config.maxOutputTokens ?? 16384,
    };
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    if (schemas.length)
      payload.tools = schemas.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout((this.config.requestTimeoutSeconds ?? 300) * 1000),
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
      if (!response.ok) throw new Error(await gatewayFailure(response, this.config.apiKey));
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
      // 输出到上限时，正在生成的工具调用参数必然不完整：不交给 dsh 执行，按 max-tokens 软结束本轮，
      // 已输出的正文照常保留（dsh 组装消息时也会丢弃 max-tokens 下的工具调用块），用户回复“继续”即可接着做。
      const truncated = finish === 'length';
      yield* closeReasoning();
      if (textIndex >= 0) yield { type: 'block-end', index: textIndex, block: { type: 'text', text } };
      for (const call of truncated ? [] : calls.values()) {
        if (!call.id || !call.name) throw new Error('模型返回了不完整的工具调用');
        yield {
          type: 'block-end',
          index: call.blockIndex,
          block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
        };
      }
      // 思考就用完了输出额度时同样没有正文，此时应报告达到上限而不是空响应
      if (textIndex < 0 && !calls.size && !truncated) throw new Error('模型返回了空响应');
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
        reason: { kind: truncated ? 'max-tokens' : calls.size ? 'tool-calls' : 'stop' },
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
