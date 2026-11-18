/**
 * 会话内切换到上下文窗口较小的模型时，执行内核会先压缩较早的对话（保留摘要）以适配新窗口。
 * 当前上下文规模取最近一次模型请求的输入 tokens；超过目标窗口约 70% 时（压缩触发点附近）提示用户。
 */
export const CONTEXT_PRESSURE_RATIO = 0.7;

export function contextPressure(
  contextTokens: number | null | undefined,
  contextWindow: number | null | undefined,
) {
  return Boolean(contextTokens && contextWindow && contextTokens >= contextWindow * CONTEXT_PRESSURE_RATIO);
}

export function tokenLabel(tokens: number) {
  if (tokens >= 1000000) return `${+(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}
