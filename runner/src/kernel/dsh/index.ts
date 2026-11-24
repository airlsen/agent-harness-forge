/**
 * DSH 适配层的唯一入口。内核与服务端只从这里取 dsh 相关的东西：
 * - engine.ts：一个会话的引擎实例（启动 / 接续 / 执行一轮 / 关闭）；
 * - runtime-config.ts：装配知识（包名、插件 id、配置项、原生工具名）；
 * - protocol.ts：SDK 方法名与事件翻译；
 * - 官方 HarnessClient：子进程、JSON-RPC、通知与安全关闭。
 * dsh 升级时只改本目录，再跑 `npm run contract` 与 `npm test`。
 */
export {
  DshEngine,
  EngineTimeout,
  type ApprovalRequest,
  type EngineHost,
  type SandboxProbe,
} from './engine.js';
export type { ApprovalOutcome } from './protocol.js';
export {
  ENGINE_TOOLS,
  compactionConfig,
  type LocalPlugin,
  type PlanSkill,
  type RuntimePlan,
  type SandboxMode,
} from './runtime-config.js';

/** 当前装配的 dsh 版本（从已安装的包读取，/v1/runtime 上报，不再手写） */
export { DSH_VERSION } from './version.js';
