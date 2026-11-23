/** engine-tools.js 的类型声明（实现见同名 .js，内核与 forge-runtime 插件共用） */
export declare const ENGINE_TOOLS: {
  readonly search: readonly ['glob', 'grep'];
  readonly read: 'read';
  readonly shell: 'bash';
  readonly skill: 'skill';
  readonly webSearch: 'web_search';
  readonly webFetch: 'web_fetch';
};
export interface PathTool {
  readonly arg: string;
  readonly search: boolean;
  readonly results?: string;
  readonly resultPath?: string;
}
export declare const PATH_TOOLS: Readonly<Record<string, PathTool>>;
