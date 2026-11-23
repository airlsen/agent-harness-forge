/**
 * Skill 编写助手的对话过程：与工作台一致，按「思考 → 工具调用 → 正文」展示每一轮。
 * - authoringChatMessages：把落库的编写消息转换成工作台的消息格式，交给 buildTurns 聚合；
 * - applyAuthoringEvent：处理流式事件，结算的回复与工具结果追加为消息，其余进入实时状态。
 */
import type { ChatMessage } from '../../types/platform';
import type { SkillAuthoringMessage } from '../../types/skill';
import type { LiveTurn, ToolCallView } from '../conversation/turns';

/** 旧版本单独记录的草稿修改说明（没有对应的工具调用），显示为一次「更新草稿」 */
export const LEGACY_REVISION_TOOL = 'skill_revision';
/** 与后端落库一致：整篇草稿、文件内容等长参数只显示字数，正文以修订为准 */
export const TOOL_ARGUMENT_CHARS = 2000;

export function compactToolArguments(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      typeof item === 'string' && item.length > TOOL_ARGUMENT_CHARS
        ? `（${item.length} 字，内容见对应修订）`
        : item,
    ]),
  );
}

export function authoringChatMessages(messages: SkillAuthoringMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const meta = message.meta ?? {};
    if (message.role === 'user' || message.role === 'assistant') {
      result.push({ id: message.id, role: message.role, content: message.content, meta });
    } else if (message.role === 'tool') {
      result.push(
        meta.toolCallId
          ? { id: message.id, role: 'tool', content: message.content, meta }
          : {
              id: message.id,
              role: 'tool',
              content: message.content,
              meta: {
                toolCallId: `note-${message.id}`,
                tool: LEGACY_REVISION_TOOL,
                arguments: { summary: message.content.replace(/^草稿已更新：/, '') },
                isError: false,
              },
            },
      );
    }
  }
  return result;
}

export interface AuthoringLive {
  reasoning: string;
  text: string;
  /** 已开始、尚未返回结果的工具调用 */
  tools: ToolCallView[];
}

export function emptyAuthoringLive(): AuthoringLive {
  return { reasoning: '', text: '', tools: [] };
}

/** 交给 buildTurns 的实时覆盖项 */
export function authoringLiveTurn(live: AuthoringLive, running: boolean): LiveTurn {
  return { running, reasoning: live.reasoning, text: live.text, activeTools: running ? live.tools : [] };
}

type StreamEvent = { kind?: string; payload?: Record<string, any> };

/**
 * 处理一条过程事件（与工作台的 follow() 相同）：回复结算（message）后清空实时正文与思考；
 * 工具结果追加为 tool 消息并移出进行中列表。返回是否为过程事件。
 */
export function applyAuthoringEvent(
  live: AuthoringLive,
  messages: SkillAuthoringMessage[],
  event: StreamEvent,
  nextId: () => string,
): boolean {
  const data = event.payload ?? {};
  if (event.kind === 'message_delta') live.text += String(data.text ?? '');
  else if (event.kind === 'reasoning_delta') live.reasoning += String(data.text ?? '');
  else if (event.kind === 'message') {
    const text = String(data.text ?? '');
    const reasoning = typeof data.reasoning === 'string' ? data.reasoning : '';
    if (text || reasoning)
      messages.push({
        id: nextId(),
        role: 'assistant',
        content: text,
        meta: {
          partial: Boolean(data.partial),
          runtimeMessageId: data.runtimeMessageId,
          ...(reasoning ? { reasoning } : {}),
        },
      });
    live.text = '';
    live.reasoning = '';
  } else if (event.kind === 'tool_use_start') {
    const id = String(data.toolCallId ?? nextId());
    if (!live.tools.some((call) => call.id === id))
      live.tools.push({
        id,
        tool: String(data.tool ?? '工具'),
        arguments: compactToolArguments(data.arguments),
        pending: true,
      });
  } else if (event.kind === 'tool_result') {
    const id = String(data.toolCallId ?? '');
    live.tools = live.tools.filter((call) => call.id !== id);
    if (!messages.some((message) => message.role === 'tool' && message.meta?.toolCallId === id))
      messages.push({
        id: nextId(),
        role: 'tool',
        content: String(data.result ?? ''),
        meta: {
          toolCallId: id || nextId(),
          tool: data.tool,
          arguments: compactToolArguments(data.arguments),
          isError: Boolean(data.isError),
        },
      });
  } else return false;
  return true;
}
