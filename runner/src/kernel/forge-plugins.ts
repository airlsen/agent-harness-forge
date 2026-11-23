/**
 * Forge 自有插件（本仓库内的 dsh 插件包）的唯一登记处：插件名 → 入口目录，以及会话清单能否声明它。
 * 内核装配插件、校验会话清单都只查这张表，不再各处手写路径和白名单。
 * dsh 官方包不在这里：它们的包名与插件 id 属于 dsh 装配知识，在 dsh/runtime-config.ts。
 * check-wiring 会核对每个入口都存在、导出的 name 与登记名一致，
 * 平台契约中 provider 为 Forge 插件的工具确实由该插件注册。
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalPlugin } from './dsh/index.js';

const RUNNER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface ForgePluginSpec {
  /** 插件包目录（相对 runner/），入口为其中的 index.js */
  dir: string;
  /** 会话清单的 plugins 能否声明它；false 表示由 Runner 按会话能力自动装配 */
  manifest: boolean;
}

export const FORGE_PLUGINS = {
  /** 模型网关 + 工作区工具 + 执行门控：每个会话都装配 */
  'forge-runtime': { dir: 'forge-runtime-plugin', manifest: true },
  /** Skill 编写工具：Skill 编辑会话由清单声明 */
  'skill-authoring': { dir: 'skill-authoring-plugin', manifest: true },
  /** 受管插件桥：场景绑定了受管插件时由清单声明 */
  'forge-plugin-bridge': { dir: 'forge-plugin-bridge', manifest: true },
  /** Skill 脚本运行：授权的 Skill 带 scripts/ 且策略允许时自动装配 */
  'skill-scripts': { dir: 'skill-scripts-plugin', manifest: false },
  /** Skill 装配：会话带 Skill 时自动装配 */
  'forge-skills': { dir: 'forge-skills-plugin', manifest: false },
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
  return join(RUNNER_ROOT, FORGE_PLUGINS[name].dir, 'index.js');
}

/** 交给 DSH 适配层挂载的一条插件（插件 id 即登记名） */
export function forgePlugin(name: ForgePluginName, config: Record<string, unknown>): LocalPlugin {
  return { id: name, entry: forgePluginEntry(name), config };
}
