/** events.js 的类型声明（实现见同名 .js，Forge 插件与 Runner 的 DSH 适配层共用） */
export interface ForgeEventSpec {
  /** 内核事件名；failure / files 由翻译层特殊处理 */
  readonly kind: string;
  readonly source: 'llm' | 'tools' | 'agent';
}
export declare const FORGE_EVENTS: Readonly<Record<string, ForgeEventSpec>>;
export declare const FORGE_EVENT_PREFIX: 'forge.';
export declare function notify(method: string, params: unknown): void;
