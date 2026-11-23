/**
 * Forge 自有插件 → Runner 的事件（唯一登记处）。
 * 插件在 dsh 进程内运行，经 dsh 的 stdout 通道发出 `forge.*` 通知；Runner 的 DSH 适配层
 * （src/kernel/dsh/protocol.ts）按这张表把它们翻译成内核事件。新增事件只在这里登记一行，两端同时生效；
 * check-wiring 会核对插件源码里出现的每个 `forge.*` 都已登记、登记的每个事件都能被翻译。
 *
 * kind 为内核事件名；两个特殊值由翻译层处理：
 * - failure：本轮失败（插件主动上报，如模型网关报错）；
 * - files：文件产物（payload 为单个文件，翻译时包成 { files: [payload] }）。
 */
export const FORGE_EVENTS = Object.freeze({
  'forge.delta': { kind: 'message_delta', source: 'llm' },
  'forge.reasoning_delta': { kind: 'reasoning_delta', source: 'llm' },
  'forge.error': { kind: 'failure', source: 'llm' },
  'forge.artifact': { kind: 'files', source: 'tools' },
  'forge.present': { kind: 'deliverables', source: 'tools' },
  'forge.policy': { kind: 'policy_decision', source: 'tools' },
  'forge.skill_revision': { kind: 'skill_revision', source: 'tools' },
  'forge.skills_loaded': { kind: 'skills_loaded', source: 'tools' },
  'forge.plugin_loaded': { kind: 'plugin_loaded', source: 'tools' },
  'forge.plugin_call': { kind: 'plugin_call', source: 'tools' },
});

/** Forge 事件的方法名前缀：带此前缀但未登记的通知，Runner 会告警而不是静默丢弃 */
export const FORGE_EVENT_PREFIX = 'forge.';

/**
 * 插件发出一条 Forge 事件（换行 JSON-RPC 通知，写到 dsh 进程的 stdout）。
 * 未登记的事件仍照常发出，但在 stderr（即 Runner 日志）告警，提醒到上面的表里登记。
 */
export function notify(method, params) {
  if (!Object.hasOwn(FORGE_EVENTS, method))
    process.stderr.write(`[forge-plugin] 未登记的插件事件 ${method}，请在 plugin-kit/events.js 中登记\n`);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
