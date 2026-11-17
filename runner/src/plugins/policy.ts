/**
 * forge-policy：工具/文件系统治理插件（M0 刺探插件 #1）。
 *
 * 挂载点：dsh 官方扩展点 `tools/*`、`fs/*` 事件瀑布（docs/capability-seams）。
 * 职责：允许 / 需审批 / 拒绝 三级判定；读写路径白名单；危险命令正则（第一道，非沙箱）。
 * 判定在 Runner 本地用策略快照执行（不逐次问控制面），判定结果写事件流（审计）。
 */

export const name = 'forge-policy'

export interface PolicyRule {
  tool: string          // 工具名或 glob（如 'Bash'、'Write'、'mcp__*'）
  action: 'allow' | 'need-approval' | 'deny'
  sensitivity?: string  // 数据敏感度条件
}

export interface PolicySnapshot {
  id: string
  rules: PolicyRule[]
  fsReadAllow: string[]
  fsWriteAllow: string[]
}

export function apply(ctx: any, snapshot: PolicySnapshot) {
  // M0 验证目标：确认 tools/before-execute 事件可同步改判（allow/ask/deny）
  const dispose = ctx.on?.('tools/before-execute', async (call: any, next: any) => {
    const rule = matchRule(snapshot.rules, call)
    if (rule?.action === 'deny') throw new Error(`denied by forge-policy:${rule.tool}`)
    if (rule?.action === 'need-approval') ctx.emit('forge/approval-needed', { call })
    return next?.()
  })
  // Cordis 铁律：返回清理函数（或依赖框架自动回滚）；禁止改其他插件内部状态
  return dispose
}

function matchRule(rules: PolicyRule[], call: any): PolicyRule | undefined {
  return rules.find((r) => r.tool === call?.name || r.tool === '*')
}
