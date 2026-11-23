/**
 * dsh 装配知识（唯一位置）：把内核给出的「本次要什么能力」（RuntimePlan，与 dsh 无关）
 * 翻译成 dsh 的 runtime patch —— 用哪些 @deepseek-ai 包、插件 id、各自的配置项。
 *
 * dsh 升级时插件改名、配置项变化、拆包合包，都只改这个文件；
 * contract-check 会核对这里引用的每个包都已安装，契约中各工具组的工具仍由对应包提供。
 */
import { pathToFileURL } from 'node:url';
import type { ToolGroup } from '../platform-contract.js';
import type { RuntimeMcpServer, RuntimeWeb, WebSearchProvider } from '../capabilities.js';

/** dsh 原生工具名：随对应插件提供，内核据此计算白名单与系统提示 */
export const ENGINE_TOOLS = {
  /** dsh-tool-fs-search */
  search: ['glob', 'grep'],
  /** tool-fs 的只读 read（带行号、分页、字节上限） */
  read: 'read',
  /** dsh-tool-skill */
  skill: 'skill',
  /** dsh-tool-web */
  webSearch: 'web_search',
  webFetch: 'web_fetch',
} as const;

/** 平台契约中由 dsh 提供的工具组 → 需要挂载的插件（工具是否开放仍由 forge-runtime 白名单决定） */
const GROUP_PLUGINS: Partial<Record<ToolGroup, Array<Record<string, unknown>>>> = {
  // 任务清单：同会话事件源状态，纯内存无宿主访问
  todo: [{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }],
  // 后台任务控制：ctx.jobs 由 sdk-minimal 内置的 dsh-jobs-local 提供
  jobs: [{ id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' }],
  // 同会话目标（不含会改变 agent 循环的 goal-round-driver）
  goal: [
    { id: 'goal', name: '@deepseek-ai/dsh-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  ],
};
const WEB_SEARCH_PACKAGES: Record<WebSearchProvider, string> = {
  'deepseek-official': '@deepseek-ai/dsh-web-search-deepseek',
  'deepseek-search-api': '@deepseek-ai/dsh-web-deepseek-api',
};
/** 联网搜索密钥的环境变量名（含 KEY，dsh 不会把它传给 stdio MCP 子进程） */
export const WEB_SEARCH_KEY_ENV = 'FORGE_WEB_SEARCH_API_KEY';
const MCP_TOOL_TIMEOUT_MS = 60000;

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
/** 内核给出的一次装配需求：只描述「要什么」，不含任何 dsh 包名或配置格式 */
export interface RuntimePlan {
  /** dsh 会话日志目录（session/resume 从这里接续） */
  sessionLogDir: string;
  contextWindow: number;
  outputTokens: number;
  /** 模型可见的全部工具（forge-runtime 白名单） */
  allowed: string[];
  /** 是否装配工作区搜索（glob / grep） */
  search: boolean;
  /** 是否开放只读 read */
  read: boolean;
  /** forge-runtime：模型出口、白名单与路径守卫，必须最先挂载 */
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
 * 生成 dsh runtime patch（写成文件后经 --patch 传给 dsh）。
 * groupTools：平台契约中各工具组的工具名，某组有工具进入白名单时才挂载该组的插件。
 */
export function buildRuntimePatch(plan: RuntimePlan, groupTools: Record<string, readonly string[]>) {
  return [
    { id: 'sessions', config: { root: plan.sessionLogDir, compression: 'none' } },
    { id: 'compaction-basic', config: compactionConfig(plan.contextWindow, plan.outputTokens) },
    // 终端由 forge-runtime 的 bash 提供；dsh 自带的终端与工作目录工具全部关闭
    ...['persistent-pwsh', 'terminal-pwsh', 'tool-working-directory', ...(plan.read ? [] : ['tool-fs'])].map(
      (id) => ({ id, disabled: true }),
    ),
    // 只开放 dsh 原生 read：写入、编辑、补丁全部关闭
    ...(plan.read
      ? [
          {
            id: 'tool-fs',
            config: {
              read: true,
              readImage: false,
              write: false,
              edit: false,
              applyPatch: false,
              readLimit: 2000,
              readMaxBytes: 51200,
            },
          },
        ]
      : []),
    {
      insert: [
        // 审批请求经宿主回调（approval/request）交给 Forge
        { id: 'forge-user-approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: 'ask' } },
        pluginRow(plan.runtime),
        // ripgrep 由依赖包内置，不需要宿主安装；结果上限保持较小，避免撑大上下文
        ...(plan.search
          ? [
              {
                id: 'forge-fs-search',
                name: '@deepseek-ai/dsh-tool-fs-search',
                config: {
                  sampleOverCapGlobResults: false,
                  globMaxResults: 100,
                  grepMaxMatches: 100,
                  timeoutMs: 15000,
                },
              },
            ]
          : []),
        ...plan.plugins.map(pluginRow),
        // 纯增益：无模型工具面，只做上下文治理与重复调用提醒。
        // 裁剪阈值 256 KiB 高于 forge-runtime 单次读取上限，只兜底 bash / 大清单等无上限输出
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 262144, headChars: 65536, tailChars: 16384 },
        },
        {
          id: 'repeat-tool-reminder',
          name: '@deepseek-ai/dsh-repeat-tool-reminder',
          config: { thresholds: [3, 5, 8], argumentsPreviewChars: 500 },
        },
        ...inGroups(plan, groupTools).flatMap((group) => GROUP_PLUGINS[group] ?? []),
        ...skillRows(plan),
        ...mcpRows(plan),
        ...webRows(plan.web),
      ],
    },
  ];
}

function skillRows(plan: RuntimePlan) {
  if (!plan.skills) return [];
  return [
    { id: 'forge-skill-registry', name: '@deepseek-ai/dsh-skill' },
    pluginRow(plan.skills.plugin),
    { id: 'forge-tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
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
function webRows(web: RuntimeWeb | null) {
  if (!web) return [];
  return [
    {
      id: 'forge-web',
      name: '@deepseek-ai/dsh-web',
      config: { ...(web.search ? { searchProvider: web.provider } : {}), fetchProvider: 'http' },
    },
    ...(web.search
      ? [
          {
            id: 'forge-web-search',
            name: WEB_SEARCH_PACKAGES[web.provider!],
            // 密钥只经环境变量传入，不写入落盘的 patch 文件
            config: { apiKeyEnv: WEB_SEARCH_KEY_ENV, ...(web.baseUrl ? { baseURL: web.baseUrl } : {}) },
          },
        ]
      : []),
    { id: 'forge-web-fetch', name: '@deepseek-ai/dsh-web-fetch-http' },
    {
      id: 'forge-tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: {
        search: web.search,
        fetch: web.fetch,
        searchMaxResults: 8,
        searchTimeoutMs: 60000,
        fetchTimeoutMs: 30000,
        fetchMaxOutputChars: 60000,
      },
    },
  ];
}

/** contract-check 用：适配层会挂载的全部 dsh 包（任何一个缺失或改名都应在升级时立即发现） */
export const DSH_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-repeat-tool-reminder',
  ...Object.values(GROUP_PLUGINS).flatMap((rows) => rows!.map((row) => row.name as string)),
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-web',
  ...Object.values(WEB_SEARCH_PACKAGES),
  '@deepseek-ai/dsh-web-fetch-http',
  '@deepseek-ai/dsh-tool-web',
];
/** contract-check 用：dsh 原生工具名 → 提供它的包 */
export const ENGINE_TOOL_PROVIDERS: Record<string, string> = {
  glob: '@deepseek-ai/dsh-tool-fs-search',
  grep: '@deepseek-ai/dsh-tool-fs-search',
  skill: '@deepseek-ai/dsh-tool-skill',
  web_search: '@deepseek-ai/dsh-tool-web',
  web_fetch: '@deepseek-ai/dsh-tool-web',
};
