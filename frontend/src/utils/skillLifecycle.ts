/** Skill 上线与下线：状态、下线与删除前的确认（技能列表与编辑页共用）。 */
import { api, post, remove } from '../api/client';
import type { SkillDetail, SkillSummary, SkillUsageScenario } from '../types/skill';
import { confirm } from './feedback';

/**
 * - draft：从未发布；
 * - published：线上版本就是当前内容；
 * - changed：已上线，之后又有新修改（尚未发布）；
 * - offline：发布过，但已下线。
 */
export type SkillState = 'draft' | 'published' | 'changed' | 'offline';

type SkillStateSource = Pick<SkillSummary, 'status' | 'publishedRevisionId' | 'offline'>;

export function skillState(skill: SkillStateSource): SkillState {
  if (skill.publishedRevisionId != null) return skill.status === 'published' ? 'published' : 'changed';
  return skill.offline ? 'offline' : 'draft';
}

export const SKILL_STATE_LABELS: Record<SkillState, string> = {
  draft: '草稿',
  published: '已发布',
  changed: '有新草稿',
  offline: '已下线',
};

/** 上线中的不能删除；草稿和已下线的可以 */
export function canDeleteSkill(skill: SkillStateSource): boolean {
  return skill.publishedRevisionId == null;
}

export function scenarioNames(scenarios: Pick<SkillUsageScenario, 'name'>[]): string {
  return scenarios.map((item) => `「${item.name}」`).join('、');
}

/** 下线确认弹窗的说明：有场景在用时列出场景名称 */
export function unpublishNotice(scenarios: SkillUsageScenario[]): string {
  const keep = '历史版本全部保留，之后可以重新发布。';
  if (!scenarios.length) return `下线后聊天里不能再选用它，已经选用的会话从下一条消息起不再使用。${keep}`;
  return `以下场景正在使用它：${scenarioNames(scenarios)}。下线后这些场景和聊天里都不再使用此技能（从下一条消息起），对话照常进行。${keep}`;
}

/** 删除被拦住时的说明：哪些场景还在使用 */
export function deleteBlockedNotice(scenarios: SkillUsageScenario[]): string {
  return `以下场景仍在使用这个技能，请先在场景中移除后再删除：${scenarioNames(scenarios)}`;
}

async function usage(skillId: number): Promise<SkillUsageScenario[]> {
  return (await api<{ scenarios: SkillUsageScenario[] }>(`/skills/${skillId}/usage`)).scenarios;
}

/** 列出受影响的场景并确认后下线；取消返回 null。 */
export async function unpublishSkill(skill: Pick<SkillSummary, 'id' | 'name'>): Promise<SkillDetail | null> {
  const scenarios = await usage(skill.id);
  const ok = await confirm({
    title: `下线技能“${skill.name}”？`,
    content: unpublishNotice(scenarios),
    okText: '下线',
    danger: true,
  });
  if (!ok) return null;
  return post<SkillDetail>(`/skills/${skill.id}/unpublish`);
}

/** 检查场景引用并确认后删除；被场景使用时抛出说明，取消返回 false。 */
export async function deleteSkill(skill: Pick<SkillSummary, 'id' | 'name'>): Promise<boolean> {
  const scenarios = await usage(skill.id);
  if (scenarios.length) throw new Error(deleteBlockedNotice(scenarios));
  const ok = await confirm({
    title: `删除技能“${skill.name}”？`,
    content: '将永久删除它的草稿、全部历史版本、附加文件、编写对话和试用文件，无法恢复。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return false;
  await remove(`/skills/${skill.id}`);
  return true;
}

/** 不在可选列表里的 Skill：已下线时返回名称与原因，否则视为已删除 */
export function missingSkillInfo(
  options: { offlineSkills?: { id: number; title: string }[] } | null | undefined,
  id: number,
): { title: string; reason: '已下线' | '已删除' } {
  const offline = options?.offlineSkills?.find((item) => item.id === id);
  return offline ? { title: offline.title, reason: '已下线' } : { title: `Skill #${id}`, reason: '已删除' };
}
