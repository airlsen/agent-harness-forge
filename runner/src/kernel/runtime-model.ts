/** 控制面每轮下发的模型运行配置（模型中心的网关地址、模型名、密钥与上下文窗口）。 */
import { createHash } from 'node:crypto';

export interface RuntimeModel {
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow?: number;
}
export function validModel(model?: RuntimeModel): model is RuntimeModel {
  return Boolean(
    model &&
    typeof model.baseUrl === 'string' &&
    model.baseUrl &&
    typeof model.model === 'string' &&
    model.model &&
    (model.apiKey === undefined || typeof model.apiKey === 'string') &&
    (model.contextWindow === undefined ||
      (Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0)),
  );
}
/**
 * 实际下发的单次输出上限：平台策略值（默认 16384），但不超过模型上下文窗口的一半，
 * 否则压缩预算为负、请求也会被网关以超出上下文拒绝。
 */
export function effectiveOutputTokens(contextWindow: number, policyValue?: number) {
  const wanted = Number.isFinite(policyValue) && policyValue! > 0 ? Math.floor(policyValue!) : 16384;
  return Math.max(256, Math.min(wanted, Math.floor(contextWindow / 2)));
}
/** 运行配置指纹：任一项变化都必须以新配置重启执行进程（模型与密钥只在启动时注入）。 */
export function modelFingerprint(model: RuntimeModel) {
  return createHash('sha256')
    .update(JSON.stringify([model.baseUrl, model.model, model.apiKey ?? '', model.contextWindow ?? 0]))
    .digest('hex');
}
