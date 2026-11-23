/**
 * Forge 自有插件（随 Runner 发布的 dsh 插件，位于 runner/internal-plugins/）的唯一登记处：
 * 插件名，以及会话清单能否声明它。内核装配插件、校验会话清单都只查这张表，不再各处手写路径和白名单。
 * 约定：目录名 = 插件名（internal-plugins/<插件名>/index.js），不维护另一张对照表；
 * internal-plugins/shared/ 是插件共用的库，不是插件。
 * dsh 官方包不在这里：它们的包名与插件 id 属于 dsh 装配知识，在 dsh/runtime-config.ts。
 * check-wiring 会核对登记表与目录一一对应、导出的 name 与登记名一致，
 * 平台契约中 provider 为 Forge 插件的工具确实由该插件注册。
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalPlugin } from './dsh/index.js';

/** Forge 自有插件所在目录 */
export const INTERNAL_PLUGINS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../internal-plugins',
);
/** internal-plugins 下插件共用的库目录（不是插件） */
export const SHARED_DIR_NAME = 'shared';

interface ForgePluginSpec {
  /** 会话清单的 plugins 能否声明它；false 表示由 Runner 按会话能力自动装配 */
  manifest: boolean;
}

export const FORGE_PLUGINS = {
  /** 模型网关 + 工作区工具 + 执行门控：每个会话都装配 */
  'forge-runtime': { manifest: true },
  /** Skill 编写工具：Skill 编辑会话由清单声明 */
  'skill-authoring': { manifest: true },
  /** 受管插件桥：场景绑定了受管插件时由清单声明 */
  'forge-plugin-bridge': { manifest: true },
  /** Skill 脚本运行：授权的 Skill 带 scripts/ 且策略允许时自动装配 */
  'skill-scripts': { manifest: false },
  /** Skill 装配：会话带 Skill 时自动装配 */
  'forge-skills': { manifest: false },
} as const satisfies Record<string, ForgePluginSpec>;

export type ForgePluginName = keyof typeof FORGE_PLUGINS;

/** 会话清单 plugins 中允许出现的插件名 */
export const MANIFEST_PLUGINS: ReadonlySet<string> = new Set(
  Object.entries(FORGE_PLUGINS)
    .filter(([, spec]) => spec.manifest)
    .map(([name]) => name),
);

/** 插件入口文件的绝对路径 */
export function forgePluginEntry(name: ForgePluginName): string {
  return join(INTERNAL_PLUGINS_DIR, name, 'index.js');
}

/** 交给 DSH 适配层挂载的一条插件（插件 id 即登记名） */
export function forgePlugin(name: ForgePluginName, config: Record<string, unknown>): LocalPlugin {
  return { id: name, entry: forgePluginEntry(name), config };
}
