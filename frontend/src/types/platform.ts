export interface ScenarioPayload {
  name: string;
  description: string;
  icon: string;
  prompt_template: string;
  capabilities: {
    plugin_names: string[];
    plugin_tools: Record<string, string[]>;
    builtin_tool_names: string[];
    skill_ids: number[];
    mcp_server_ids: number[];
    /** 已废弃：关联代码改为聊天中按会话选择；仅为兼容旧数据保留 */
    project_ids: string[];
    /** 联网搜索（需平台在治理中心开启） */
    web_search?: boolean;
  };
  model: string;
  execution_mode: 'standard';
  input_schema?: Record<string, unknown> | null;
}
/** 空间色块颜色键；公共空间为 gray */
export type SpaceColor = 'orange' | 'blue' | 'green' | 'purple' | 'red' | 'cyan' | 'yellow' | 'pink' | 'gray';
/** 列表与详情里附带的所属空间 */
export interface SpaceBrief {
  id: number;
  name: string;
  color: SpaceColor;
  isPublic: boolean;
}
export interface SpaceCounts {
  scenarios: number;
  skills: number;
  mcp: number;
  plugins: number;
  sessions: number;
}
export interface Space extends SpaceBrief {
  description: string;
  counts: SpaceCounts;
  disabledTools: string[];
  createdAt: string | null;
}
/** 可移动到别的空间的内容 */
export type SpaceResourceKind = 'scenario' | 'skill' | 'mcp' | 'plugin';
export interface MoveCheck {
  kind: SpaceResourceKind;
  id: string;
  name: string;
  from: SpaceBrief;
  to: SpaceBrief;
  /** 移走后会受影响的其他空间场景，或场景依赖的、目标空间里用不到的内容 */
  blockers: { kind: string; id: number | string; name: string; spaceName?: string }[];
  /** Skill 重名 */
  conflicts: { id: number; name: string; conflictId: number; conflictSpace: string }[];
}
export interface Scenario {
  id: number;
  /** official 为预置只读模板，personal 为我的场景；所属空间见 spaceId */
  space: 'official' | 'personal';
  /** 所属空间（公共空间 = 1）；旧后端不返回 */
  spaceId?: number;
  spaceInfo?: SpaceBrief;
  owner_id: string;
  status: 'template' | 'draft' | 'published';
  current_version: number;
  published_version: number;
  published_payload: ScenarioPayload | null;
  published_bundle_hash: string | null;
  payload: ScenarioPayload;
  bundleHash: string;
  tested: boolean;
  createdAt: string | null;
  updatedAt: string;
  publishedAt: string | null;
}
export interface Conversation {
  id: number;
  sessionId: number;
  title: string;
  scenarioId: number;
  scenarioVersion: number;
  scenarioName: string;
  bundleHash: string;
  status: string;
  tokensIn: number;
  tokensOut: number;
  cost: number | null;
  createdAt: string;
  /** 最近活动时间（最后一条消息的时间，没有消息时为创建时间）；旧版本后端不返回 */
  lastActiveAt?: string;
  /** 模型 ID（如 deepseek-chat） */
  model: string;
  /** 会话使用的模型配置 ID；第一期之前创建的旧会话为 null */
  modelId: number | null;
  /** 模型显示名；旧会话回退为模型 ID */
  modelName: string;
  /** 当前模型的上下文窗口；第一期之前创建、尚未继续过的旧会话为 null */
  modelContextWindow: number | null;
  isTest: boolean;
  /** 关联的代码项目（只读）；修改后从下一轮起生效。旧版本后端不返回时视为未关联 */
  codeProjects?: string[];
  /** 聊天中临时选择的扩展能力（与场景绑定取并集）；修改后从下一轮起生效 */
  capabilities?: CapabilityChoice;
  /** 场景绑定的扩展能力（会话创建时冻结） */
  scenarioCapabilities?: ScenarioCapabilities;
  /** 会话所在空间（公共空间 = 1）；旧后端不返回 */
  spaceId?: number;
  spaceInfo?: SpaceBrief;
}
/** 聊天临时选择的扩展能力 */
export interface CapabilityChoice {
  skillIds: number[];
  mcpServerIds: number[];
  webSearch: boolean;
}
export interface ScenarioCapabilities {
  skills: { id: number; title: string; name: string; version?: number | null }[];
  mcpServers: { id: number; name: string }[];
  webSearch: boolean;
}
/** 可选的已发布 Skill */
export interface SkillOption {
  id: number;
  revisionId: number;
  version: number | null;
  /** 平台显示名 */
  title: string;
  /** 运行时名称（用户可用 /名称 直接调用） */
  name: string;
  description: string;
  tags?: string[];
  spaceId?: number;
  /** 公共空间的内容（在本空间显示「公共」标记） */
  isPublic?: boolean;
}
/** 可在会话中运行的 MCP 服务（已启用、连接测试通过） */
export interface McpOption {
  id: number;
  name: string;
  transport: 'stdio' | 'streamable-http';
  description: string;
  tools: { name: string; description: string; permission: 'read' | 'approval' }[];
  spaceId?: number;
  isPublic?: boolean;
}
export interface WebAvailability {
  available: boolean;
  searchReady: boolean;
  fetchEnabled: boolean;
  reason: string;
  provider: string;
}
export interface CapabilityOptions {
  skills: SkillOption[];
  /** 已下线的 Skill（只有名称）：场景或会话里仍勾着时显示「已下线」，不能再新选；旧后端不返回 */
  offlineSkills?: { id: number; title: string }[];
  mcpServers: McpOption[];
  web: WebAvailability;
}
/** 本轮生效的扩展能力摘要（用户消息 meta.capabilities） */
export interface ActiveCapabilities {
  skills: {
    id: number;
    name: string;
    title: string;
    version?: number | null;
    /** 本轮实际装配的 Skill 修订与 Runner 快照目录名（<修订号>-<内容哈希>） */
    revisionId?: number;
    snapshot?: string;
    source: 'scenario' | 'chat';
  }[];
  mcp: {
    id: number;
    name: string;
    serverName: string;
    transport: string;
    source: 'scenario' | 'chat';
    tools: number;
    approvalTools: number;
  }[];
  web: { search: boolean; fetch: boolean; source: 'scenario' | 'chat' } | null;
  /** 本轮跳过的能力；reason 为具体原因（如 Skill 缺少附加文件），旧消息没有 */
  unavailable: { kind: 'skill' | 'mcp' | 'web'; id: number | null; title: string; reason?: string }[];
}
/** 平台联网搜索设置（密钥不回传） */
export interface WebSearchSettings {
  enabled: boolean;
  provider: string;
  providers: { id: string; label: string }[];
  baseUrl: string;
  apiKeyConfigured: boolean;
  keySource: 'custom' | 'model' | 'none';
  fetchEnabled: boolean;
  searchReady: boolean;
  available: boolean;
  reason: string;
}
/** 代码根目录下可供会话关联的项目（只读） */
export interface CodeProject {
  name: string;
  path: string;
  branch?: string;
  commit?: string;
}
export interface CodeProjectList {
  root: string;
  /** 代码根目录是否存在且可读 */
  available: boolean;
  projects: CodeProject[];
}
export interface ChatMessage {
  id: number | string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  meta: Record<string, any>;
  createdAt?: string;
}
export interface KernelEvent {
  seq: number;
  source: string;
  kind: string;
  payload: any;
  ts: string;
}
export interface Approval {
  ticketId: number;
  tool: string;
  arguments: unknown;
  reason?: string;
  timeoutSeconds?: number;
}
/** 会话模型分段（append-only）：会话创建时一段，每次会话内切换追加一段 */
export interface SessionModelSegment {
  /** 模型配置 ID；旧会话迁移的分段可能为 null */
  id: number | null;
  name: string;
  model: string;
  contextWindow: number;
  inputPrice?: number | null;
  outputPrice?: number | null;
  /** 本段生效的第一条用户消息；null 表示自会话创建起 */
  fromMessageId?: number | null;
  tokensIn?: number;
  tokensOut?: number;
  /** 本段费用；未配置单价时为 null */
  cost?: number | null;
}
export interface SessionDetail extends Conversation {
  messages: ChatMessage[];
  lastEventSeq: number;
  bundle: any;
  pendingApprovals: Approval[];
  models?: SessionModelSegment[];
  /** 最近一次模型请求的输入 tokens，约等于当前上下文规模 */
  contextTokens?: number;
}
export interface Tool {
  name: string;
  title: string;
  description: string;
  permission: string;
  icon: string;
  /** 执行策略是否允许（旧后端不返回，视为允许） */
  policyAllowed?: boolean;
  /** 当前空间是否开启（默认开启） */
  spaceEnabled?: boolean;
  /** 真正可用：执行策略允许 且 当前空间开启 */
  available?: boolean;
}
export interface ModelConnection {
  id?: number;
  configured: boolean;
  name: string;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  contextWindow: number;
  inputPrice: number | null;
  outputPrice: number | null;
  enabled: boolean;
  isDefault?: boolean;
  lastTest: { ok?: boolean; message?: string; latencyMs?: number; httpStatus?: number; at?: string };
}
/** 聊天模型选择项：仅启用的模型，不含服务地址与凭据 */
export interface ModelOption {
  id: number;
  name: string;
  model: string;
  contextWindow: number;
  inputPrice: number | null;
  outputPrice: number | null;
  isDefault: boolean;
  /** 最近一次连接测试：测试不是启用的前置条件，只作提示 */
  status: 'ok' | 'failed' | 'untested';
}
export interface RuntimeStatus {
  controlPlane: string;
  runner: {
    status: string;
    node?: string;
    dshVersion?: string;
    sessions?: number;
    capacity?: number;
    /** 正在执行的会话数（并发占用量） */
    active?: number;
    /** 排队等待执行的回合数 */
    queued?: number;
  };
  model: { configured: boolean; name?: string; connectionName?: string };
  storage: string;
  authMode: string;
  deployment: string;
  limitations: string[];
}
