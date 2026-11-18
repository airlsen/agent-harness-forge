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
    project_ids: string[];
  };
  model: string;
  execution_mode: 'standard';
  input_schema?: Record<string, unknown> | null;
}
export interface Scenario {
  id: number;
  space: 'official' | 'personal';
  owner_id: string;
  status: 'template' | 'draft' | 'published';
  current_version: number;
  payload: ScenarioPayload;
  bundleHash: string;
  tested: boolean;
  updatedAt: string;
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
  /** 模型 ID（如 deepseek-chat） */
  model: string;
  /** 会话使用的模型配置 ID；第一期之前创建的旧会话为 null */
  modelId: number | null;
  /** 模型显示名；旧会话回退为模型 ID */
  modelName: string;
  isTest: boolean;
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
export interface SessionDetail extends Conversation {
  messages: ChatMessage[];
  lastEventSeq: number;
  bundle: any;
  pendingApprovals: Approval[];
}
export interface Tool {
  name: string;
  title: string;
  description: string;
  permission: string;
  icon: string;
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
  runner: { status: string; node?: string; dshVersion?: string; sessions?: number; capacity?: number };
  model: { configured: boolean; name?: string; connectionName?: string };
  storage: string;
  authMode: string;
  deployment: string;
  limitations: string[];
}
