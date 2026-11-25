/* 由 contracts/session-manifest.schema.json 生成（runner/scripts/gen-manifest-types.mjs），请勿手改；修改后执行 make contracts */

/**
 * 一个执行会话的完整装配输入（随创建 / 恢复请求下发；模型与扩展能力按轮下发，不在此处）。
 */
export interface SessionManifest {
  version: 1;
  systemPrompt: SystemPrompt;
  /**
   * 挂载的 Forge 插件包，Runner 只接受白名单内的名称
   */
  plugins: string[];
  tools: ManifestTools;
  pluginBindings: PluginBinding[];
  policy: RuntimePolicy;
  /**
   * 执行策略指纹：Runner 会话的指纹与控制面不一致时按新清单重新装配
   */
  policyRef: string;
  skillAuthoring: SkillAuthoringDraft | null;
}
/**
 * 系统提示的四个部分；平台运行说明由 Runner 按会话实际能力追加。
 */
export interface SystemPrompt {
  identity: string;
  domain: string;
  safety: string[];
  workspace: string[];
}
export interface ManifestTools {
  /**
   * 场景声明的 Forge 内置工具，Runner 以 policy.allowedTools 为上限
   */
  builtin: string[];
  /**
   * 已按企业插件策略筛选的受管插件工具
   */
  plugin: string[];
}
/**
 * 受管插件绑定：审核冻结的版本、制品摘要与授权工具（工具定义原样透传）。
 */
export interface PluginBinding {
  package: string;
  displayName: string;
  version: string;
  artifactHash: string;
  runtime: string;
  execution: {
    [k: string]: unknown;
  };
  tools: {
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
}
/**
 * 执行策略：Runner 读取下列字段，其余企业策略字段原样保留供审计。
 */
export interface RuntimePolicy {
  allowedTools: string[] | null;
  maxOutputTokens: number | null;
  requestTimeoutSeconds: number | null;
  approvalTimeoutSeconds: number | null;
  askTimeoutSeconds: number | null;
  [k: string]: unknown;
}
/**
 * Skill 编写会话的草稿上下文（仅 skill-authoring 插件使用）。
 */
export interface SkillAuthoringDraft {
  skillId: number;
  name: string;
  description: string;
  revisionId: number;
  content: string;
  files: DraftFile[];
  guides: DesignGuide[];
}
export interface DraftFile {
  path: string;
  content: string;
}
export interface DesignGuide {
  name: string;
  content: string;
}
