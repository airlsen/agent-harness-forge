/** 侧栏「最近会话」：按最近活动排序、最多 30 条、按今天/昨天/7 天内/更早分组、状态点。 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
});
try {
  const { groupRecentSessions, recentSessionDot, lastActiveTime, RECENT_LIMIT } = await vite.ssrLoadModule(
    '/src/utils/recentSessions.ts',
  );
  const now = new Date(2026, 10, 22, 22, 30);
  const at = (day, hour = 10) => new Date(2026, 10, day, hour).toISOString();
  const session = (id, createdAt, lastActiveAt) => ({ id, title: `会话 ${id}`, createdAt, lastActiveAt });
  const labels = (groups) => groups.map((group) => [group.label, group.items.map((item) => item.id)]);

  // 按最近活动排序：三天前创建、今天又聊过的会话排到最上面
  assert.deepEqual(
    labels(
      groupRecentSessions(
        [
          session(5, at(22, 9), at(22, 9)),
          session(4, at(21), at(21)),
          session(3, at(19), at(22, 21)),
          session(2, at(17), at(17)),
          session(1, at(1), at(1)),
        ],
        now,
      ),
    ),
    [
      ['今天', [3, 5]],
      ['昨天', [4]],
      ['7 天内', [2]],
      ['更早', [1]],
    ],
  );
  // 7 天内含 6 天前的整天，7 天前归到更早；空组不返回
  assert.deepEqual(labels(groupRecentSessions([session(1, at(16, 0)), session(2, at(15, 23))], now)), [
    ['7 天内', [1]],
    ['更早', [2]],
  ]);
  // 旧后端没有 lastActiveAt：退回创建时间；时间相同按 ID 倒序；无法解析的时间排最后
  assert.equal(lastActiveTime({ createdAt: at(20) }), new Date(at(20)).getTime());
  assert.equal(lastActiveTime({ createdAt: 'bad' }), 0);
  assert.deepEqual(
    labels(groupRecentSessions([session(1, at(22)), session(2, at(22)), session(3, 'bad')], now)),
    [
      ['今天', [2, 1]],
      ['更早', [3]],
    ],
  );
  // 最多显示 30 条
  const many = Array.from({ length: 45 }, (_, i) =>
    session(i + 1, at(22, 1), new Date(now - i * 60000).toISOString()),
  );
  const shown = groupRecentSessions(many, now).flatMap((group) => group.items);
  assert.equal(RECENT_LIMIT, 30);
  assert.equal(shown.length, 30);
  assert.equal(shown[0].id, 1);
  // 状态点：执行中跳动、执行异常红点，其他不显示
  assert.equal(recentSessionDot('running'), 'running');
  assert.equal(recentSessionDot('error'), 'error');
  for (const status of ['idle', 'interrupted', 'archived', 'unknown'])
    assert.equal(recentSessionDot(status), null);

  console.log('recent sessions checks passed');
} finally {
  await vite.close();
}
