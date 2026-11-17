/**
 * forge-approval-bridge：人工审批桥（M0 刺探插件 #2）。
 *
 * 语义平移旧 ApprovalManager：approve / deny / submit(带参) / 选择题；超时自动 deny。
 * 机制：tools 门控管道挂起 -> POST 控制面回调建工单 -> 等 resolveApproval -> 放行/拒绝。
 */

export const name = 'forge-approval-bridge'

interface ApprovalBridgeConfig {
  callbackBaseUrl: string
  timeoutMs: number // 默认 600s（FORGE_APPROVAL_TIMEOUT_SECONDS）
}

export function apply(ctx: any, config: ApprovalBridgeConfig) {
  const pending = new Map<string, (decision: any) => void>()

  // 控制面 -> Runner：决策落地（server.ts /v1/sessions/:id/approvals/:ticket/resolve 调这里）
  ctx.provide?.('approvalBridge.resolve', (toolCallId: string, decision: any) => {
    pending.get(toolCallId)?.(decision)
    pending.delete(toolCallId)
  })

  return ctx.on?.('forge/approval-needed', async ({ call }: any) => {
    const ticket = await createTicket(config, call) // POST {callbackBaseUrl}/api/agent/approvals
    const decision = await withTimeout(
      new Promise((resolve) => pending.set(call.id, resolve)),
      config.timeoutMs,
      { action: 'deny', reason: 'timeout' },
    )
    if (decision.action !== 'approve') throw new Error(`denied: ${decision.reason ?? ''}`)
    call.args = decision.payload?.args ?? call.args // submit：允许人改参数
  })
}

async function createTicket(config: ApprovalBridgeConfig, call: any): Promise<string> {
  // TODO(M0): fetch POST 控制面，返回 ticketId；审批事件双写事件流
  return 'ticket-placeholder'
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))])
}
