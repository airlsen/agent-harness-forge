import type { Conversation } from '../../types/platform';

/** 侧栏「最近会话」最多显示的条数；更多的到「我的会话」查看 */
export const RECENT_LIMIT = 30;

export interface RecentGroup {
  label: '今天' | '昨天' | '7 天内' | '更早';
  items: Conversation[];
}

/** 最近活动时间（毫秒）：最后一条消息的时间；旧后端没有该字段时退回创建时间，无法解析为 0 */
export function lastActiveTime(item: Pick<Conversation, 'lastActiveAt' | 'createdAt'>) {
  const time = new Date(item.lastActiveAt ?? item.createdAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * 侧栏「最近会话」：按最近活动倒序（刚聊过的排最上面），取前 limit 条，
 * 按本地日期分成 今天 / 昨天 / 7 天内 / 更早，空组不返回。
 */
export function groupRecentSessions(
  items: Conversation[],
  now = new Date(),
  limit = RECENT_LIMIT,
): RecentGroup[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  const groups: RecentGroup[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '7 天内', items: [] },
    { label: '更早', items: [] },
  ];
  const sorted = [...items]
    .sort((a, b) => lastActiveTime(b) - lastActiveTime(a) || b.id - a.id)
    .slice(0, limit);
  for (const item of sorted) {
    const time = lastActiveTime(item);
    const index = time >= today ? 0 : time >= yesterday ? 1 : time >= week ? 2 : 3;
    groups[index].items.push(item);
  }
  return groups.filter((group) => group.items.length);
}

/** 名字后面的状态点：执行中为跳动的点，执行异常为红点，其他状态不显示 */
export function recentSessionDot(status: string): 'running' | 'error' | null {
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  return null;
}
