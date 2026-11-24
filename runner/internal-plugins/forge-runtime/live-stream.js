/**
 * 实时输出转发：dsh 的会话日志只记录完整消息，生成过程中的正文 / 思考片段只在进程内广播
 * （agent/assistant-stream）。这里把它们转成 Forge 事件推给 Runner，页面据此显示「正在回复」。
 * 只转发 agent 循环里的请求：上下文压缩生成摘要等后台请求不经过这里，不会显示在回复中。
 *
 * 模型请求失败（如连接中断、服务繁忙）时 dsh 会自动重试，每次重试都从头生成：上一次尝试已推送、
 * 但没有结算成消息的片段作废，先发 forge.live_reset 让页面清掉，再转发重试的输出。
 */
import { notify } from '../shared/events.js';

/** dsh 流式片段类型 → Forge 事件 */
const LIVE_EVENTS = {
  'text-delta': 'forge.delta',
  'reasoning-delta': 'forge.reasoning_delta',
};

export function installLiveStream(ctx) {
  // 上一次结算之后是否推送过片段（结算成消息后由 message 事件清空页面上的实时内容）
  let unsettled = false;
  return ctx.on('agent/assistant-stream', ({ frame }) => {
    if (frame?.type === 'start') {
      if (unsettled) notify('forge.live_reset', {});
      unsettled = false;
    } else if (frame?.type === 'end') {
      // 失败的尝试也会落一条 assistant/attempt 记录，只有结算成回复消息才算数
      if (frame.outcome?.kind === 'committed' && frame.outcome.eventType === 'assistant/message')
        unsettled = false;
    } else if (frame?.type === 'chunk') {
      const event = LIVE_EVENTS[frame.chunk?.type];
      const text = frame.chunk?.text;
      if (!event || typeof text !== 'string' || !text) return;
      unsettled = true;
      notify(event, { text });
    }
  });
}
