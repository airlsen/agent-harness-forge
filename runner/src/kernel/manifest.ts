/**
 * 会话清单（SessionManifest）：控制面创建 / 恢复会话时下发的装配输入。
 *
 * 类型由 contracts/session-manifest.schema.json 生成（manifest.generated.ts），这里只做两件事：
 * - 声明本 Runner 支持的清单版本。Schema 升版后生成的类型随之改变，下面的常量会编译失败，
 *   提醒在这里补上新版本的处理，而不是静默按旧结构读取；
 * - 在入口处校验结构：清单来自另一个进程，内核其余部分只处理校验过的清单。
 */
import { failure } from './errors.js';
import type { SessionManifest } from './manifest.generated.js';

export type {
  PluginBinding,
  RuntimePolicy,
  SessionManifest,
  SkillAuthoringDraft,
  SystemPrompt,
} from './manifest.generated.js';

export const MANIFEST_VERSION: SessionManifest['version'] = 1;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** 校验并返回清单；结构不符时抛出 422，版本不符时提示两端同步升级 */
export function parseManifest(input: unknown): SessionManifest {
  if (!isObject(input)) throw failure('缺少会话清单（manifest）', 422);
  if (input.version !== MANIFEST_VERSION)
    throw failure(
      `会话清单版本 ${String(input.version)} 不受支持（执行内核支持 ${MANIFEST_VERSION}），请同步升级控制面与执行内核`,
      422,
    );
  const problems: string[] = [];
  const prompt = input.systemPrompt;
  if (!isObject(prompt) || typeof prompt.identity !== 'string') problems.push('systemPrompt');
  if (!isStrings(input.plugins)) problems.push('plugins');
  const tools = input.tools;
  if (!isObject(tools) || !isStrings(tools.builtin) || !isStrings(tools.plugin)) problems.push('tools');
  if (!Array.isArray(input.pluginBindings) || !input.pluginBindings.every(isObject))
    problems.push('pluginBindings');
  if (!isObject(input.policy)) problems.push('policy');
  if (typeof input.policyRef !== 'string') problems.push('policyRef');
  if (input.skillAuthoring !== null && !isObject(input.skillAuthoring)) problems.push('skillAuthoring');
  if (problems.length) throw failure(`会话清单字段无效：${problems.join('、')}`, 422);
  return input as unknown as SessionManifest;
}
