/** engine-tools.js 的类型声明（实现见同名 .js，内核与 forge-runtime 插件共用） */
export declare const ENGINE_TOOLS: {
  readonly search: readonly ['glob', 'grep'];
  readonly read: 'read';
  readonly write: 'write';
  readonly edit: 'edit';
  readonly present: 'present';
  readonly shell: 'bash';
  readonly jobOutput: 'job_output';
  readonly skill: 'skill';
  readonly ask: 'ask_user_question';
  readonly webSearch: 'web_search';
  readonly webFetch: 'web_fetch';
};
export interface PathTool {
  readonly arg: string;
  readonly items?: string;
  readonly search: boolean;
  readonly results?: string;
  readonly resultPath?: string;
  readonly workspace?: boolean;
}
export declare const PATH_TOOLS: Readonly<Record<string, PathTool>>;
