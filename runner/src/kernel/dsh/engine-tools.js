/**
 * dsh 原生工具知识（唯一位置）：工具名，以及带路径参数的工具「路径在哪个参数、结果里的路径在哪个字段」。
 * 用纯 JS 编写：内核（TypeScript，经 engine-tools.d.ts）与 forge-runtime 插件（在 dsh 进程内运行的纯 JS）
 * 直接共用这一份，dsh 改工具名或参数名时只改这里；contract-check 会核对工具名仍由对应包提供。
 */

/** dsh 原生工具名：随对应插件提供，内核据此计算白名单与系统提示 */
export const ENGINE_TOOLS = Object.freeze({
  /** dsh-tool-fs-search：随读取权限开放 */
  search: Object.freeze(['glob', 'grep']),
  /** dsh-tool-fs：读取（带行号、分页、字节上限） */
  read: 'read',
  /** dsh-tool-fs：创建或整篇覆盖文本文件 */
  write: 'write',
  /** dsh-tool-fs：按原文精确替换片段（随 write 开放） */
  edit: 'edit',
  /** dsh-tool-present：声明交付文件（随 write 开放） */
  present: 'present',
  /** dsh-tool-bash：一次性终端命令，在 dsh 沙箱中执行；forge-runtime 只负责门控与输出脱敏 */
  shell: 'bash',
  /** dsh-tool-jobs：读取后台任务输出（与 bash 一样需要输出脱敏） */
  jobOutput: 'job_output',
  /** dsh-tool-skill */
  skill: 'skill',
  /** dsh-tool-ask-user：向用户提问（随基础能力开放，仍受平台策略上限约束） */
  ask: 'ask_user_question',
  /** dsh-tool-web */
  webSearch: 'web_search',
  webFetch: 'web_fetch',
});

/**
 * 带路径参数的 dsh 工具：forge-runtime 在执行前把路径收窄到会话工作区与已关联的只读目录。
 * - arg：路径所在的参数名；items 存在时该参数是对象数组，路径在每个元素的 items 字段；
 * - search：是否为搜索（不传路径时在工作区内搜索）；
 * - results / resultPath：搜索结果中列出路径的字段（数组元素为对象时取 resultPath），用于剔除密钥类文件；
 * - workspace：只能指向会话工作区内的非隐藏路径（写入、修改、交付）。
 */
export const PATH_TOOLS = Object.freeze({
  glob: Object.freeze({ arg: 'path', search: true, results: 'paths' }),
  grep: Object.freeze({ arg: 'path', search: true, results: 'matches', resultPath: 'path' }),
  read: Object.freeze({ arg: 'file_path', search: false }),
  write: Object.freeze({ arg: 'file_path', search: false, workspace: true }),
  edit: Object.freeze({ arg: 'file_path', search: false, workspace: true }),
  present: Object.freeze({ arg: 'files', items: 'path', search: false, workspace: true }),
});
