/**
 * AgentChat store：当前场景装配 / 会话状态 / 流缓冲 / 审批待办 / 成本。
 * 平移自旧 stores/claudeChat.ts，新增 trajectory 与 cost 两个 slice。
 */
import { defineStore } from 'pinia'
import type { Scenario } from '../types/agent'

interface CostState {
  tokensIn: number
  tokensOut: number
  cost: number
}

interface PendingApproval {
  ticketId: number
  tool: string
  argsDigest: string
}

export const useAgentChatStore = defineStore('agentChat', {
  state: () => ({
    currentScenario: null as Scenario | null,
    sessionId: null as number | null,
    streaming: false,
    streamText: '',
    pendingApprovals: [] as PendingApproval[],
    cost: { tokensIn: 0, tokensOut: 0, cost: 0 } as CostState,
    trajectoryOpen: false,
  }),
  getters: {
    /** 审批阻塞中禁止连续提交（旧设计语义） */
    canSubmit: (s) => !s.streaming && s.pendingApprovals.length === 0,
  },
  actions: {
    pickScenario(sc: Scenario) {
      this.currentScenario = sc
      // TODO(W2): 模板填入输入框 + 能力 chips 摘要（沿用旧 handleScenarioChange）
    },
    async submit(message: string) {
      // TODO(W2): createSession(必要) → streamTurn → 事件分发（utils/stream-message-handler）
    },
    resolveApproval(ticketId: number, action: string, payload?: unknown) {
      // TODO(W2): POST /api/agent/approvals/{id}/resolve
    },
  },
})
