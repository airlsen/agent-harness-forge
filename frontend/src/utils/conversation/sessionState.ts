/** 会话与场景的状态展示：状态标签、可用性、来源与搜索匹配。 */
import type { Conversation, Scenario } from '../../types/platform';

/** `idle` is a settled round, never a claim that the business goal succeeded. */
export function sessionState(status: string) {
  const states: Record<string, { label: string; tone: string; icon: string }> = {
    running: { label: '执行中', tone: 'running', icon: 'activity' },
    idle: { label: '可继续', tone: 'neutral', icon: 'message' },
    error: { label: '执行异常', tone: 'error', icon: 'info' },
    interrupted: { label: '已中止', tone: 'warning', icon: 'pause' },
    archived: { label: '已归档', tone: 'neutral', icon: 'archive' },
  };
  return states[status] ?? { label: '状态未知', tone: 'neutral', icon: 'circle' };
}

export function isAvailableScenario(scenario: Scenario) {
  return scenario.status === 'template' || scenario.status === 'published';
}

export function scenarioSource(scenario: Scenario) {
  return scenario.space === 'official' ? '平台预置' : '平台自建';
}

export function scenarioState(scenario: Scenario) {
  return scenario.status === 'template' ? '预置' : scenario.status === 'published' ? '已发布' : '草稿';
}

export function sessionMatches(session: Conversation, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return `${session.title} ${session.scenarioName} ${session.id}`.toLocaleLowerCase().includes(normalized);
}
