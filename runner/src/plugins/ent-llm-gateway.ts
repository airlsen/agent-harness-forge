/**
 * ent-llm-gateway：企业模型出口插件（M0 刺探插件 #3）。
 *
 * 挂载点：`ctx.llm` 注册适配器（OpenAI chat-completions 协议）→ 全部模型请求
 * 只走企业模型网关（路由/降级/计量/私有化端点），场景里的"模型"只是路由标签。
 * DeepSeek 要点：thinking+tool-use 模式参数透传收敛在此，不进业务代码。
 */

export const name = 'ent-llm-gateway'

interface GatewayConfig {
  baseUrl: string          // 模型网关地址（MVP: LiteLLM Proxy + 薄策略层）
  tenantKeyRef: string     // 租户密钥引用（KMS），密钥不落 Runner 磁盘
}

export function apply(ctx: any, config: GatewayConfig) {
  ctx.llm?.registerAdapter?.('forge-gateway', {
    baseURL: config.baseUrl,
    // TODO(M0): thinking 模式映射：model_route.primary 后缀 ':thinking' → 网关参数
    // TODO(M0): 透传 usage（含 cache_hit）到 metrics/audit 事件
    createChatCompletion: async (req: any) => {
      throw new Error('M0 POC: 打通 → 模型网关 → DeepSeek API 的最小流式链路')
    },
  })
}
