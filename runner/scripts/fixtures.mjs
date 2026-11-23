/** 检查脚本共用的会话清单夹具：只写与用例相关的字段，其余按 Schema 补齐默认值。 */
import { MANIFEST_VERSION } from '../src/kernel/manifest.ts';

export function fixtureManifest({ systemPrompt = {}, tools = {}, policy = {}, ...rest } = {}) {
  return {
    version: MANIFEST_VERSION,
    systemPrompt: { identity: 'Contract test only.', domain: '', safety: [], workspace: [], ...systemPrompt },
    plugins: ['forge-runtime'],
    tools: { builtin: [], plugin: [], ...tools },
    pluginBindings: [],
    policy: {
      allowedTools: null,
      maxOutputTokens: null,
      requestTimeoutSeconds: null,
      approvalTimeoutSeconds: null,
      ...policy,
    },
    policyRef: 'test',
    skillAuthoring: null,
    ...rest,
  };
}
