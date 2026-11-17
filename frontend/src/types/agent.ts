/**
 * 与 backend/src/api/schemas 一一对齐（单源类型，P1 起 OpenAPI codegen 生成）。
 */

export interface CapabilitySelection {
  plugin_names: string[]
  skill_ids: number[]
  mcp_server_ids: number[]
  builtin_tool_names: string[]
  project_ids: string[]
}

export interface ScenarioPayload {
  name: string
  description: string
  icon: string
  prompt_template: string // {{变量}} 占位
  capabilities: CapabilitySelection
  model: string // 路由标签
  execution_mode: 'standard' | 'ptc'
  input_schema?: Record<string, unknown> | null
}

export interface Scenario {
  id: number
  space: 'official' | 'personal' | 'team'
  owner_id: string
  status: 'draft' | 'review' | 'published'
  current_version: number
  payload: ScenarioPayload
}

/** SSE 事件联合类型（协议见 docs/02-技术方案 §4.3 —— 协议冻结后前后端可并行） */
export type AgentSseEvent =
  | { event: 'session'; data: { sessionId: number; bundleHash: string; workspaceUri: string } }
  | { event: 'message_delta'; data: { text: string } }
  | { event: 'message'; data: { text: string } }
  | { event: 'thinking_delta'; data: { text: string } }
  | { event: 'tool_use_start'; data: { toolCallId: string; tool: string } }
  | { event: 'tool_use_delta'; data: { toolCallId: string; argsDelta: string } }
  | { event: 'tool_use_stop'; data: { toolCallId: string } }
  | { event: 'tool_result'; data: { toolCallId: string; result: string } }
  | { event: 'subagent_dispatch'; data: { subagentId: string; goal: string } }
  | { event: 'approval_required'; data: { ticketId: number; tool: string; argsDigest: string } }
  | { event: 'approval_resolved'; data: { ticketId: number; action: string } }
  | { event: 'cost_tick'; data: { tokensIn: number; tokensOut: number; cost: number } }
  | { event: 'files'; data: { files: string[] } }
  | { event: 'done'; data: { numTurns: number } }
  | { event: 'error'; data: { message: string } }

export interface TrajectoryEvent {
  seq: number
  source: 'system' | 'llm' | 'tools' | 'agent' | 'ui'
  kind: string
  attrs: Record<string, unknown>
  createdAt: string
}
