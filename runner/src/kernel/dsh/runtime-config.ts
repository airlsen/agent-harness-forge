/**
 * dsh 装配知识（唯一位置）：把内核给出的「本次要什么能力」（RuntimePlan，与 dsh 无关）
 * 翻译成 dsh 的 runtime patch —— 用哪些插件 id、各自的配置项。
 *
 * 底座是 dsh 官方的 `sdk` profile：文件读写、交付、终端沙箱、时间、大结果转存、重试等通用能力都用它自带的插件，
 * Forge 只在上面加平台层（forge-runtime 等自有插件）。sdk 的每个内置插件都在下面三张表之一：
 * - SDK_KEPT：原样保留（部分带 Forge 配置）；
 * - SDK_SWITCHED：按会话能力（场景 / 企业策略 / 关联代码）整块开关——没选中的能力关掉整个插件，
 *   而不是只隐藏工具，否则插件仍会往提示词里加说明；
 * - SDK_OFF：服务端用不上，始终关闭（桌面端界面、账号凭据、插件市场、遥测等）。
 * dsh 升级时插件改名、配置项变化、新增插件，都只改这个文件；contract-check 会核对 sdk 的每个内置插件
 * 都已归入三张表之一（升级带来没归类的新插件时直接报错），写给插件的每个配置项插件仍然认识。
 */
import { pathToFileURL } from 'node:url';
import type { ToolGroup } from '../platform-contract.js';
import type { RuntimeMcpServer, RuntimeWeb, WebSearchProvider } from '../capabilities.js';
import { ENGINE_TOOLS } from './engine-tools.js';

/** dsh 原生工具名与路径参数形状在 engine-tools.js（内核与 forge-runtime 插件共用的唯一一份） */
export { ENGINE_TOOLS, PATH_TOOLS } from './engine-tools.js';

/** 原样保留的 sdk 内置插件：会话、模型、工具执行、上下文治理、沙箱、时间等通用底座 */
export const SDK_KEPT = [
  'timer',
  'llm',
  'deepseek-llm-api-extensions',
  'llm-retry',
  // 模型出口：DSH 官方通用适配器（OpenAI 兼容接口），按会话模型配置一条路由，见 modelRow
  'llm-pi-ai',
  'session',
  'session-log-deepseek',
  // 无模型的兜底标题（控制面另有自己的会话标题）
  'session-title',
  'session-persistence-jsonl',
  'session-projection',
  'session-checkpoint-policy',
  'agent',
  'agent-loop',
  'plugin-package-inventory-deepseek',
  'attachment-local',
  'working-directory',
  'jobs',
  'subprocess',
  // 沙箱：终端命令与文件写入共用同一份策略（模式与工作区根目录）
  'sandbox',
  'sandbox-policy',
  'bash-sandbox',
  'fs-sandbox',
  'shell-env',
  // 审批请求经宿主回调（approval/request）交给 Forge 的确认卡片
  'approval',
  'tools',
  'tool-executor-native',
  'system-prompt',
  'token-meter',
  'compaction-basic',
  'image-offload',
  'tool-result-pruner',
  'repeat-tool-reminder',
  // 大结果转存为文件（模型用 read 按需读取）与工具限时
  'spill-local',
  'spill-policy',
  'timeout-policy',
  // 把当前时间作为上下文告诉模型（替代原来需要模型主动调用的 current_time）
  'time-context',
  'mcp-resources',
  'sdk-app-startup',
  'sdk-jsonrpc-server',
] as const;

/** 按会话能力开关的 sdk 内置插件 → 开关所依据的能力 */
export const SDK_SWITCHED = {
  'tool-fs': '读取 / 写入（read、write、edit）',
  'tool-fs-search': '读取（glob、grep 随读取开放）',
  present: '写入（交付文件随写入开放）',
  'tool-bash': '终端（bash）',
  'tool-todo': '任务清单',
  'tool-jobs': '后台任务',
  goal: '目标',
  'tool-goal': '目标',
  skill: 'Skill',
  'tool-skill': 'Skill',
  'user-questions': '向用户提问（ask_user_question）',
  'tool-ask-user': '向用户提问（ask_user_question）',
  web: '联网',
  'web-search-deepseek': '联网搜索（DeepSeek 官方）',
  'web-deepseek-api': '联网搜索（DeepSeek Search API）',
  'web-fetch-http': '网页抓取',
  'tool-web': '联网',
} as const;

/** 始终关闭的 sdk 内置插件（按原因分组；以后要启用某项能力时从这里移到上面两张表） */
export const SDK_OFF = [
  // 平台管理：Forge 有自己的管理后台；插件管理器允许模型自行安装插件
  'plugin-manager',
  'tool-plugin-manager',
  'settings',
  'config-editor',
  'hmr',
  // 账号与凭据：模型密钥由 Forge 后端加密保存后下发；模型目录与默认模型由会话指定
  'credentials',
  'authorization',
  'deepseek-account',
  'llm-deepseek-account',
  'agent-default-model',
  // DeepSeek 官方专用适配器：模型统一经 llm-pi-ai 的 OpenAI 兼容路由接入（DeepSeek 按兼容配置识别）
  'llm-deepseek',
  // 桌面端 / 网页界面专用：斜杠命令、反馈、计划模式、上传、浏览器连接、@文件、链接说明、权限选择器
  'commands',
  'command-feedback',
  'command-compact',
  'command-goal',
  'plan-mode',
  'file-upload',
  'connection',
  'file-reference-local',
  'deliverable-file-references',
  'permission',
  // 工作目录切换：会话工作目录固定为会话工作区
  'tool-working-directory',
  // 定时任务：DSH 的定时任务随会话进程存活，进程空闲回收后就失效；定时能力放在 Forge 后端
  'schedule',
  'tool-schedule',
  // 存储与基础设施：数据在 Forge 后端数据库
  'storage',
  'storage-json',
  'storage-domain',
  'typert',
  'typert-loader',
  'typert-gateway',
  'remote-access',
  'workspace',
  'session-projection-cache',
  'session-query-sqlite',
  'session-title-llm',
  // 遥测：使用 Forge 自己的审计
  'otel',
  'session-telemetry-otel',
  // Windows 终端
  'pwsh-sandbox',
  'tool-pwsh',
  // 只读观察策略（sdk 默认也关闭）
  'fs-observation-policy',
  // 工作区说明文件（AGENTS.md）：只读工作区里的说明，读不到关联代码项目里的
  'agent-instructions',
  // 从文件系统加载 Skill：Forge 的 Skill 由控制面按场景下发
  'skill-filesystem',
  // 目标自动续行：会改变 agent 循环
  'goal-round-driver',
  // 高级编排：子智能体、智能体团队、工作流——后续按场景再开（向用户提问已按能力开放，见 SDK_SWITCHED）
  'subagent',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-control',
  'agent-team',
  'tool-agent-team',
  'ptc-runtime',
  'workflow-ptc',
  'tool-workflow',
  'tool-executor-ptc',
  // Office 套件：需要部署 LibreOffice，后续按场景再开
  'office-kit',
  'tool-office',
  'skill-office',
  'workspace-dependencies',
] as const;

/** 平台契约中由 dsh 提供的工具组 → 需要开启的 sdk 内置插件（工具是否开放仍由 forge-runtime 白名单决定） */
const GROUP_PLUGINS: Partial<Record<ToolGroup, string[]>> = {
  // 任务清单：同会话事件源状态，纯内存无宿主访问
  todo: ['tool-todo'],
  // 后台任务控制（ctx.jobs 由内置的 jobs 提供）
  jobs: ['tool-jobs'],
  // 同会话目标（不含会改变 agent 循环的 goal-round-driver）
  goal: ['goal', 'tool-goal'],
};
/** 联网搜索密钥的环境变量名（含 KEY，dsh 不会把它传给 stdio MCP 子进程） */
export const WEB_SEARCH_KEY_ENV = 'FORGE_WEB_SEARCH_API_KEY';
/**
 * 搜索服务 → 提供它的 sdk 内置插件 id，以及该插件里「密钥环境变量名 / 接口地址」两个配置项的名字。
 * 各包字段名不同：dsh-web-deepseek-api 自 0.2.2-rc.5 起按搜索 / 抓取分开配置（search 前缀）；
 * 写错字段名 dsh 不会报错而是静默忽略，由 contract-check 的「配置项」检查兜底。
 */
const WEB_SEARCH_PLUGINS: Record<WebSearchProvider, { id: string; keyField: string; baseUrlField: string }> =
  {
    'deepseek-official': { id: 'web-search-deepseek', keyField: 'apiKeyEnv', baseUrlField: 'baseURL' },
    'deepseek-search-api': {
      id: 'web-deepseek-api',
      keyField: 'searchApiKeyEnv',
      baseUrlField: 'searchBaseURL',
    },
  };
const MCP_TOOL_TIMEOUT_MS = 60000;
/** 单条终端命令的默认限时（与原持久终端一致）；开启后台任务时超时的命令转为后台任务继续运行 */
const BASH_TIMEOUT_MS = 300000;
/** 单次交付最多声明的文件数（与界面的交付卡片一致） */
const MAX_PRESENTED = 4;
/** 时间上下文的回退时区：浏览器时区不可用时使用（Forge 用户默认在中国） */
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** 会话模型在 llm-pi-ai 中的路由名（initialize 的 provider） */
export const MODEL_ROUTE = 'forge';
/** 模型密钥的环境变量名（含 KEY：dsh 不会把它传给 stdio MCP 子进程；密钥不写入落盘的 patch 文件） */
export const MODEL_KEY_ENV = 'FORGE_MODEL_API_KEY';
/**
 * 模型中心没填密钥时（如内网免鉴权的模型服务）使用的占位值：dsh 的适配器要求必须有密钥，
 * 免鉴权的服务会忽略这个请求头；需要鉴权的服务会返回 401，界面提示检查凭据。
 */
export const MODEL_KEY_PLACEHOLDER = 'forge-no-api-key';
/** 请求头里的应用名（部分网关按它统计来源） */
const APP_TITLE = 'AgentHarness Forge';

/** DeepSeek 按模型名或接口地址识别（企业网关地址不一定含 deepseek.com） */
export function isDeepSeekModel(model: Pick<PlanModel, 'id' | 'baseUrl'>) {
  return /deepseek/i.test(model.id) || /deepseek/i.test(model.baseUrl);
}

/** 文件沙箱模式：只读 / 只能写会话工作区 / 不限制（类型保留供审批升级，绝不作为无沙箱降级） */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Forge 自有插件（本仓库内的 dsh 插件包），按给定顺序挂载 */
export interface LocalPlugin {
  id: string;
  /** 插件入口文件的绝对路径 */
  entry: string;
  config: Record<string, unknown>;
}
export interface PlanSkill {
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  dir: string;
}
/** 会话模型（不含密钥：密钥只经环境变量 MODEL_KEY_ENV 传入） */
export interface PlanModel {
  /** 模型名（接口里的 model） */
  id: string;
  /** OpenAI 兼容接口地址（到 /v1 为止） */
  baseUrl: string;
  /** 单次模型请求上限（毫秒） */
  requestTimeoutMs: number;
}
/** 内核给出的一次装配需求：只描述「要什么」，不含任何 dsh 包名或配置格式 */
export interface RuntimePlan {
  /** dsh 会话日志目录（session/resume 从这里接续） */
  sessionLogDir: string;
  /** 大结果转存目录（模型可用 read 读取，forge-runtime 把它列为只读目录） */
  spillDir: string;
  /** 会话工作区（沙箱的可写根目录） */
  workspace: string;
  contextWindow: number;
  outputTokens: number;
  model: PlanModel;
  /** 模型可见的全部工具（forge-runtime 白名单） */
  allowed: string[];
  /** 文件沙箱模式 */
  sandbox: SandboxMode;
  /** forge-runtime：系统提示、白名单与路径守卫、实时输出转发，必须最先挂载 */
  runtime: LocalPlugin;
  /** 其余 Forge 插件（受管插件桥、Skill 编辑、Skill 脚本），按顺序挂载 */
  plugins: LocalPlugin[];
  /** Skill：注册到 dsh-skill，由 Forge 插件 skillsPlugin 写入注册表 */
  skills: { plugin: LocalPlugin } | null;
  mcp: { servers: RuntimeMcpServer[]; cwd: string };
  web: RuntimeWeb | null;
}

function pluginRow(plugin: LocalPlugin) {
  return { id: plugin.id, name: pathToFileURL(plugin.entry).href, config: plugin.config };
}
function inGroups(plan: RuntimePlan, groups: Record<string, readonly string[]>) {
  return Object.entries(groups)
    .filter(([, tools]) => tools.some((tool) => plan.allowed.includes(tool)))
    .map(([group]) => group as ToolGroup);
}

/**
 * compaction-basic 默认额外预留 65,536 tokens 余量：窗口 W − 输出上限 O ≤ 65,536 时（例如常见的 64K 模型），
 * 自动压缩会被静默跳过，且会话内切换到该模型会被 dsh 直接拒绝。按模型窗口缩放余量，
 * 大窗口模型仍不超过官方默认值；摘要输出上限与普通回复一致，避免向网关请求超出模型能力的 max_tokens。
 */
export function compactionConfig(contextWindow: number, outputTokens: number) {
  const budget = contextWindow - outputTokens;
  const headroomTokens = Math.max(1024, Math.min(65536, Math.floor(budget * 0.25)));
  return { headroomTokens, maxTokens: Math.max(1, Math.min(headroomTokens, outputTokens)) };
}

/**
 * 模型路由（llm-pi-ai 的 providers 配置）：一条 OpenAI 兼容路由，只含会话模型这一个模型。
 * 兼容项按 Forge 原网关的行为固定：用 max_tokens、不发 store / developer 角色 / 思考强度等 OpenAI 专有参数，
 * 企业网关普遍兼容。DeepSeek 另开 DeepSeek 思考格式：历史中的思考内容按 DeepSeek 要求带回
 * （没有思考内容的 assistant 消息补空字符串），且不主动开关思考模式（off 不发送参数，沿用模型默认）。
 */
export function modelRow(plan: RuntimePlan) {
  const { model } = plan;
  const deepseek = isDeepSeekModel(model);
  const compat = {
    maxTokensField: 'max_tokens',
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    ...(deepseek ? { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true } : {}),
  };
  return {
    id: 'llm-pi-ai',
    config: {
      providers: {
        [MODEL_ROUTE]: {
          displayName: APP_TITLE,
          api: 'openai-completions',
          baseURL: model.baseUrl.replace(/\/+$/, ''),
          apiKeyEnv: MODEL_KEY_ENV,
          headers: { 'X-Title': APP_TITLE },
          timeoutMs: model.requestTimeoutMs,
          models: [
            {
              id: model.id,
              name: model.id,
              contextWindow: plan.contextWindow,
              maxTokens: plan.outputTokens,
              input: ['text'],
              ...(deepseek ? { reasoningEfforts: { off: null, high: 'high' } } : { reasoningEfforts: false }),
              compat,
            },
          ],
        },
      },
    },
  };
}

/** 按会话能力算出每个可开关插件开或关，以及开启时的配置 */
function switchedRows(plan: RuntimePlan, groupTools: Record<string, readonly string[]>) {
  const has = (tool: string) => plan.allowed.includes(tool);
  const read = has(ENGINE_TOOLS.read);
  const write = has(ENGINE_TOOLS.write);
  const search = ENGINE_TOOLS.search.some(has);
  const groups = inGroups(plan, groupTools);
  const jobs = groups.includes('jobs');
  const web = plan.web;
  const searchPlugin = web?.search ? WEB_SEARCH_PLUGINS[web.provider!] : undefined;
  const on: Partial<Record<keyof typeof SDK_SWITCHED, Record<string, unknown> | true>> = {};
  if (read || write)
    on['tool-fs'] = {
      read,
      // 模型路由只声明文本输入，不读图片
      readImage: false,
      write,
      edit: write,
      applyPatch: false,
    };
  if (search)
    on['tool-fs-search'] = {
      // ripgrep 由依赖包内置，不需要宿主安装；结果上限保持较小，避免撑大上下文
      sampleOverCapGlobResults: false,
      globMaxResults: 100,
      grepMaxMatches: 100,
      timeoutMs: 15000,
    };
  if (write) on.present = { maxFiles: MAX_PRESENTED };
  // 后台运行与超时转后台都需要后台任务工具读取输出；没开放时超时直接结束命令
  if (has(ENGINE_TOOLS.shell)) on['tool-bash'] = { enableRunInBackground: jobs, promoteOnTimeout: jobs };
  for (const group of groups)
    for (const id of GROUP_PLUGINS[group] ?? []) on[id as keyof typeof SDK_SWITCHED] = true;
  if (plan.skills) on.skill = on['tool-skill'] = true;
  // 向用户提问：user-questions 提供接缝、tool-ask-user 提供模型工具，随基础能力一起按策略开放
  if (has(ENGINE_TOOLS.ask)) {
    on['user-questions'] = true;
    on['tool-ask-user'] = { mode: 'legacy' };
  }
  if (web) {
    on.web = { ...(searchPlugin ? { searchProvider: web.provider } : {}), fetchProvider: 'http' };
    on['web-fetch-http'] = true;
    on['tool-web'] = {
      search: web.search,
      fetch: web.fetch,
      searchMaxResults: 8,
      searchTimeoutMs: 60000,
      fetchTimeoutMs: 30000,
      fetchMaxOutputChars: 60000,
    };
    if (searchPlugin)
      on[searchPlugin.id as keyof typeof SDK_SWITCHED] = {
        // 密钥只经环境变量传入，不写入落盘的 patch 文件
        [searchPlugin.keyField]: WEB_SEARCH_KEY_ENV,
        ...(web.baseUrl ? { [searchPlugin.baseUrlField]: web.baseUrl } : {}),
      };
  }
  return (Object.keys(SDK_SWITCHED) as Array<keyof typeof SDK_SWITCHED>).map((id) => {
    const config = on[id];
    if (!config) return { id, disabled: true };
    return config === true ? { id, disabled: false } : { id, disabled: false, config };
  });
}

/**
 * 生成 dsh runtime patch（写成文件后经 --patch 传给 dsh 的 sdk profile）。
 * groupTools：平台契约中各工具组的工具名，某组有工具进入白名单时才开启该组的插件。
 */
export function buildRuntimePatch(plan: RuntimePlan, groupTools: Record<string, readonly string[]>) {
  return [
    { id: 'session-persistence-jsonl', config: { root: plan.sessionLogDir, compression: 'none' } },
    modelRow(plan),
    { id: 'compaction-basic', config: compactionConfig(plan.contextWindow, plan.outputTokens) },
    // 系统提示由 forge-runtime 以不插值的段落注入（场景提示词里可能有 {{…}}）：去掉 sdk 的编码助手人设与 Harness 身份；
    // 运行时上下文保留（含沙箱策略说明）
    {
      id: 'system-prompt',
      config: { includeHarnessIdentity: false, includeRuntimeContext: true, personaPrefix: '' },
    },
    // 沙箱模式与可写根目录：终端与文件写入共用；Forge 的路径守卫另把写入收窄到会话工作区
    { id: 'sandbox-policy', config: { mode: plan.sandbox, workspaceRoot: plan.workspace } },
    { id: 'bash-sandbox', config: { timeoutMs: BASH_TIMEOUT_MS } },
    // 审批始终经宿主确认（外部 MCP 工具逐次确认、终端越界写入的升权）
    { id: 'approval', config: { policy: 'ask' } },
    // 大结果转存到会话数据目录：随会话清理，forge-runtime 允许模型读取
    { id: 'spill-local', config: { root: plan.spillDir, cleanupPeriodDays: 30 } },
    { id: 'time-context', config: { timeZone: process.env.TZ || DEFAULT_TIME_ZONE } },
    ...switchedRows(plan, groupTools),
    ...SDK_OFF.map((id) => ({ id, disabled: true })),
    {
      insert: [
        pluginRow(plan.runtime),
        ...plan.plugins.map(pluginRow),
        ...(plan.skills ? [pluginRow(plan.skills.plugin)] : []),
        ...mcpRows(plan),
      ],
    },
  ];
}

function mcpRows(plan: RuntimePlan) {
  return plan.mcp.servers.map((server) => ({
    id: `forge-mcp-${server.serverName}`,
    name: '@deepseek-ai/dsh-mcp-client',
    config:
      server.transport === 'stdio'
        ? {
            transport: 'stdio',
            serverName: server.serverName,
            command: server.command,
            args: server.args ?? [],
            env: server.env ?? {},
            cwd: plan.mcp.cwd,
            toolCallTimeoutMs: MCP_TOOL_TIMEOUT_MS,
          }
        : {
            transport: 'streamable-http',
            serverName: server.serverName,
            url: server.url,
            headers: server.headers ?? {},
            toolCallTimeoutMs: MCP_TOOL_TIMEOUT_MS,
          },
  }));
}

/** contract-check 用：适配层直接引用的 dsh 包（sdk 内置插件的包名由 profile 决定，contract-check 从 profile 读取） */
export const DSH_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-sdk-client',
  '@deepseek-ai/dsh-mcp-client',
];
/** contract-check 用：dsh 原生工具名 → 提供它的包 */
export const ENGINE_TOOL_PROVIDERS: Record<string, string> = {
  glob: '@deepseek-ai/dsh-tool-fs-search',
  grep: '@deepseek-ai/dsh-tool-fs-search',
  job_output: '@deepseek-ai/dsh-tool-jobs',
  skill: '@deepseek-ai/dsh-tool-skill',
  web_search: '@deepseek-ai/dsh-tool-web',
  web_fetch: '@deepseek-ai/dsh-tool-web',
};
