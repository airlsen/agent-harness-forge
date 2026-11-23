/**
 * Forge's only DSH-side managed-plugin bridge. It never loads tenant code: each
 * declared tool is schema-only here and every execution crosses to the isolated
 * Forge Plugin Worker using a short-lived Runner-issued lease.
 */
import { notify } from '../plugin-kit/events.js';

export const name = 'forge-plugin-bridge';
export const inject = ['tools'];

// This is defense in depth against a forged Bundle: risk/approval behavior comes
// from the reviewed Runner image, not from a scenario-controlled Manifest copy.
const workerTools = {
  'forge-text-tools': {
    version: '0.1.0',
    tools: { text_extract_outline: { permission: 'read' } },
  },
  'forge-demo-crm': {
    version: '0.1.0',
    tools: {
      crm_find_customer: { permission: 'read' },
      crm_add_customer_note: { permission: 'approval' },
    },
  },
};

function bindingSpec(binding) {
  const builtin = workerTools[binding?.package];
  if (builtin) {
    if (binding.version !== builtin.version)
      throw new Error(`Forge 未批准插件“${binding?.package ?? ''}”的当前受管版本`);
    return builtin;
  }
  // Uploaded packages never provide executable Node code to DSH. They target the generic
  // remote Worker protocol and can only use the exact tools frozen in their signed lease.
  if (binding?.runtime === 'forge-remote-worker-v1' && Array.isArray(binding.tools)) {
    return { tools: Object.fromEntries(binding.tools.map((tool) => [tool.name, { permission: tool.permission }])) };
  }
  throw new Error(`Forge 未批准插件“${binding?.package ?? ''}”的运行时`);
}

function workerEndpoint(value) {
  if (typeof value !== 'string') throw new Error('受管插件 Worker 未配置');
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port)
    throw new Error('受管插件 Worker 地址无效');
  return url.href.replace(/\/$/, '');
}

export function apply(ctx, config) {
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  const allowed = new Set(config.allowedTools ?? []);
  const gatewayUrl = workerEndpoint(config.gatewayUrl);
  if (typeof config.lease !== 'string' || config.lease.length < 32) throw new Error('受管插件调用租约无效');
  const approvalTools = new Set();
  const disposers = [];
  for (const binding of bindings) {
    const packageSpec = bindingSpec(binding);
    for (const tool of binding.tools ?? []) {
      if (!allowed.has(tool.name)) throw new Error(`插件工具“${tool.name}”未被当前会话授权`);
      const spec = packageSpec.tools[tool.name];
      if (!spec) throw new Error(`插件“${binding.package}”未声明工具“${tool.name}”的执行器`);
      if (tool.permission !== spec.permission)
        throw new Error(`插件工具“${tool.name}”的风险声明与受管执行器不一致`);
      if (spec.permission === 'approval') approvalTools.add(tool.name);
      disposers.push(
        ctx.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          output: {
            schema: tool.outputSchema,
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          async execute(args) {
            const started = Date.now();
            try {
              const response = await fetch(`${gatewayUrl}/v1/invoke`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  lease: config.lease,
                  binding: {
                    package: binding.package,
                    version: binding.version,
                    artifactHash: binding.artifactHash,
                    runtime: binding.runtime,
                  },
                  tool: tool.name,
                  arguments: args,
                }),
              });
              const body = await response.json().catch(() => ({}));
              if (!response.ok || !body || typeof body !== 'object' || !('result' in body))
                throw new Error(typeof body?.message === 'string' ? body.message : '受管插件 Worker 调用失败');
              notify('forge.plugin_call', {
                package: binding.package,
                version: binding.version,
                tool: tool.name,
                outcome: 'succeeded',
                elapsedMs: Date.now() - started,
              });
              return body.result;
            } catch (error) {
              notify('forge.plugin_call', {
                package: binding.package,
                version: binding.version,
                tool: tool.name,
                outcome: 'failed',
                elapsedMs: Date.now() - started,
                error: error instanceof Error ? error.message : 'plugin execution failed',
              });
              throw error;
            }
          },
        }),
      );
    }
  }
  if (approvalTools.size) {
    disposers.push(
      ctx.on('tools/pre-execute', (exec, next) => {
        if (!approvalTools.has(exec.name)) return next();
        notify('forge.policy', { tool: exec.name, callId: exec.callId, arguments: exec.arguments, decision: 'ask' });
        return {
          kind: 'ask',
          reason: '该插件操作会写入 CRM 客户档案，需要用户批准',
          displayReason: { en: 'Approve this CRM write?', 'zh-CN': '是否允许写入 CRM 客户档案？' },
        };
      }),
    );
  }
  notify('forge.plugin_loaded', {
    plugins: bindings.map((binding) => ({ package: binding.package, version: binding.version })),
  });
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
