# 14 · 执行底座切换到 DSH sdk 组合

> 状态：第 1–4 步已实现；Runner 通过官方 `@deepseek-ai/dsh-sdk-client` 的高级 `DeepSeekHarness.run()` 执行回合；第 5 步以后再议。
> DSH 版本固定 `0.2.2-rc.5`，不 fork、不改 DSH 的英文工具说明与压缩提示词。

## 为什么换

原来以 `sdk-minimal` 为底座，文件读写、交付声明、当前时间都是 Forge 自己写的工具（`workspace-tools.js`），
终端是常驻 Shell、没有系统沙箱。DSH 官方 `sdk` 组合已经提供同类能力，并且带有沙箱、超长结果转存、
超时转后台等配套。继续自己维护一套，DSH 每次升级都要跟着改，而且效果更差。

切换后的原则：

- **能用 DSH 的就用 DSH**，Forge 只保留平台层：工具白名单、路径守卫、配额、文件同步、命令规则、外部工具逐次确认、Skill 编辑。
- **场景仍然可配**：场景勾选的能力决定加载哪些 DSH 插件；**没选中的能力整块关闭插件**（只隐藏工具会留下多余的提示词）。
- **每个 sdk 内置插件都必须归类**，DSH 升级新增插件时 `npm run contract` 直接报错，避免悄悄多出能力或提示词。
- **运行配置和客户端各司其职**：`sdk` profile 提供 Agent 能力；`DeepSeekHarness` 负责回合完成判定与进程生命周期，底层 `HarnessClient` 接收无会话 ID 的 Forge 插件通知和宿主审批。场景 patch 保持按会话装配。

边界：SDK 不管理 Forge 的企业会话、租户权限、事件回放、配额、只读代码根目录、审批票据与场景装配；这些仍由平台负责。移除它们会改变已有产品能力和安全边界。`forge-runtime` 仅保留这些平台钩子和实时 UI 事件，不重写官方 Agent 循环、模型适配、文件工具或终端沙箱。

## 插件归类（`runner/src/kernel/dsh/runtime-config.ts`）

| 类别 | 含义 | 内容 |
| --- | --- | --- |
| `SDK_KEPT` | 每个会话都加载 | 内核、模型（`llm-pi-ai` 与重试）、会话与持久化、agent、后台进程、沙箱 ×4、Shell 环境、审批、系统提示、用量、压缩、图片转存、旧结果裁剪、提醒、超长结果转存 ×2、超时策略、时间上下文、MCP 资源、启动与 JSON-RPC |
| `SDK_SWITCHED` | 按会话能力开关 | `tool-fs`（`read`/`write`/`edit`，关闭读图与 apply_patch）、`fs-search`、`present`（每次最多 4 个文件）、`tool-bash`（后台运行随“后台任务”开放）、待办、后台任务、目标 ×2、Skill ×2、向用户提问 ×2（`user-questions` + `tool-ask-user`，随基础工具「向用户提问」开放）、联网 ×5 |
| `SDK_OFF` | 永远关闭 | 第二套模型适配、`permission`、定时任务、遥测（会上报到外部地址）、插件管理、子代理、Office、agent 指令文件、文件系统 Skill、目标自动推进等 |

运行时补丁要点（`buildRuntimePatch`）：

- 系统提示：不带 DSH 的身份与编程助手人设，场景提示词作为一个**不做变量插值**的段落放在人设位置（场景里写 `{{占位符}}` 不会出错）。
- 沙箱：`sandbox-policy.mode` 可写会话为 `workspace-write`，否则 `read-only`；工作区根目录 = 会话工作区。
- 终端单条命令 5 分钟；审批方式为“询问”；超长结果转存到会话专用目录（保留 30 天，模型可只读访问）；时区默认 `Asia/Shanghai`（`TZ` 可改）。

## 第 1 步 · sdk 底座

- `DSH_PROFILE = 'sdk'`，Runner 只通过上面的归类决定加载什么。
- 验收：Runner 集成检查全部通过；系统提示里没有无关的人设 / 身份文字；契约检查发现未归类插件即失败。
- 实测（本机，模拟模型，加载读写 + 终端）：启动约 **1.0 秒**、每个会话的 dsh 进程约 **185 MB**。
  对比：原 `sdk-minimal` 0.91 秒 / 165 MB，未裁剪的完整 `sdk` 2.75 秒 / 350 MB。

## 第 2 步 · 文件、交付、时间

| 旧（Forge 自写） | 新（DSH） |
| --- | --- |
| `workspace_list` / `workspace_read` | `read`（+ `glob` / `grep`） |
| `workspace_write` | `write`（文本）/ `edit`（局部替换） |
| `workspace_present` | `present` |
| `current_time` | 时间作为上下文自动提供，不再是工具 |

Forge 仍然负责：

- **路径守卫**（`path-guard.js`）：读取 / 搜索限制在会话工作区与只读目录；`write` / `edit` / `present` 只能写会话工作区内的非隐藏路径，拒绝符号链接与越界。
- **配额**（`limits.js` + `workspace-bridge.js`）：单文件 10 MB、1000 个文件、总量 200 MB；写入串行检查。
- **文件同步**：每次 `write` / `edit` 后发 `forge.artifact`，`present` 后发 `forge.present`（工作区相对路径）。持久化的交付结果为 `{files:[{path, bytes, description}]}`。

旧名兼容（`contracts/platform.json` 的 `renamed`）：

- Runner（`canonicalTools`）、控制面（`canonical_tools`）、前端（`LEGACY_TOOL_NAMES`）都认旧名。
- 控制面启动时一次性迁移（标记 `tool-rename-v2`）：执行策略、空间工具开关、场景版本快照里的旧名换成新名并重算快照哈希。
- 历史会话的消息不改，界面按旧名正常显示（标题、交付卡片）。

二进制文件：`write` 只写文本，二进制文件由 `bash`（如 Python 脚本）生成。

## 第 3 步 · 沙箱中的终端

- 终端改用 DSH 一次性 `bash`：每次调用是新的 Shell，`cd` 不保留，用 `workdir` 参数指定目录。
- 在 DSH 沙箱中执行（bubblewrap → Landlock），只能写会话工作区与临时目录；只读会话完全只读。
- 越界时模型可带 `sandbox_permissions` + 一句理由请求放宽，**确认卡片显示中文原因**
  （“这条命令需要突破终端沙箱（…）。原因：…”），拒绝后命令保持被拦截。原因随审批票据保存，刷新页面仍可见。
- 服务器既没有 bubblewrap 也不支持 Landlock 时：首个会话启动探测一次，之后需要终端的会话拒绝启动，
  不切换为 `danger-full-access`；`GET /v1/runtime` 与治理页如实显示 `unavailable`。生产环境应安装 bubblewrap。
- 部分 Landlock 支持时 DSH 每条命令都会输出一段英文提示，Forge 已从结果中去掉。

## 第 4 步 · 模型适配器（已完成）

用 DSH 自带的 `dsh-llm-pi-ai` 替换 Forge 自写的 `gateway.js`，`llm-deepseek` 改为关闭，`forge.error` 事件删除。

- **路由**：`modelRow()` 只写一条路由 `providers.forge`、一个模型（地址、上下文长度、单次输出上限、请求超时、`X-Title`）。
  兼容项固定用 `max_tokens`、不发 `store` 与 developer 角色；DeepSeek 模型另开 DeepSeek 思考格式，思考内容按 `reasoning_content` 回放。
- **凭据**：只经子进程环境变量 `FORGE_MODEL_API_KEY` 传入，不写入补丁；DSH 启动 stdio MCP 时会去掉名字带 KEY 的变量，
  `check-capabilities` 断言终端与 MCP 看不到；没填密钥的模型（内网免鉴权）发固定占位值。
- **失败提示**：回合以 `error` 结束时，`protocol.ts` 的 `turnFailure()` 按错误类型转成中文（凭据、额度、繁忙、超长、超时、
  连接中断、内容被拦截、HTTP 状态等），未知错误原样显示；失败信息里的密钥打码（`redact()`）。
- **输出上限**：`max-tokens` 结束时保留已生成的部分，提示可回复“继续”。
- **用量**：思考 token 计入输出 token（pi-ai 不单独报告，界面也不单独显示）。
- **自动重试**：连接中断等临时错误由 DSH 自动重试，每次重试从头生成；forge-runtime 先发 `forge.live_reset`
  （不落盘的实时事件），后端实时通道、部分输出累积、工作台与 Skill 编辑器据此清掉上一次尝试的半截内容。
- **契约检查**：逐层核对写入的配置字段（含 `providers.forge.models[0].compat` 这类嵌套字段），写错字段直接报错；
  不再依赖 `@deepseek-ai/dsh-llm`（已从 `package.json` 移除）。
- **代价**：pi-ai 自带多家模型服务的 SDK，每会话常驻内存约 185 MB → 205 MB，启动约 1.0 s → 1.2 s。

## 终端改为单次执行后的提示词调整

终端每次调用都是独立的 Shell（`cd` 不保留），提示词相应调整：

- 平台系统提示（`runner/src/kernel/system-prompt.ts`）：换目录用 `workdir`；文本文件用 `write` / `edit`，不用 echo、cat 重定向或 heredoc；
  Word、Excel、PDF、图片等二进制文件先用 `write` 写脚本、再用 `bash` 运行生成；会话没有终端时如实说明、改用文本格式。
- Skill 设计参考（`builtin_skills/skill-design/references/forge-platform.md`）：同样的写法要求，避免写出依赖上一条命令状态的步骤。
- AI 生成场景（`llm_prompts.py` 的 `scenario.generate`）：场景提示词只写做什么、交付什么格式，不写具体终端写法。
- 内置场景只有「代码与研发」改为“需要验证时用终端运行命令或测试”；只影响新安装，已有数据库里的场景不变（原文不涉及终端，无冲突）。

## 第 5 步 · 以后

子代理、Office 等按场景开放；目前全部关闭。向用户提问已在 2026-11 接入（见 `docs/16`）：`user-questions` / `tool-ask-user` 移入 `SDK_SWITCHED`，随基础工具「向用户提问」开放。

## 待决定

- 生产环境安装 bubblewrap / 确认 Landlock。
- 每会话内存（约 205 MB）与 Runner 容量设置。
