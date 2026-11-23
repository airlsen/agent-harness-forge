# Forge Harness Runner

正式入口 `src/server.ts`，由控制面以内部 Bearer Token 调用；浏览器不直接访问 Runner。Node >=24.9.0，固定 `dsh@0.2.2-rc.1`。

## 业务路径

- `src/kernel/session-kernel.ts`：会话、回合、执行日志、审批、容量与清理；与执行引擎无关，只产出 `RuntimePlan`。
- `src/kernel/dsh/`：**DSH 适配层，dsh 相关代码只在这里**。升级 dsh 时通常只需改这个目录，再跑 `npm run contract`。
  - `process.ts`：换行 JSON-RPC、请求关联、host 请求与安全中止；
  - `protocol.ts`：dsh 通知 → Forge 事件；
  - `runtime-config.ts`：`RuntimePlan` → dsh runtime patch；
  - `engine.ts`：`DshEngine`。
- `src/kernel/journal.ts`：每会话执行日志。持久事件带序号落盘，控制面回执后清理；流式增量（`transient`）只推给在线订阅者。
- `src/kernel/manifest.ts`：会话清单入口校验。类型 `manifest.generated.ts` 由 `contracts/session-manifest.schema.json` 生成（根目录 `make contracts`），请勿手改。
- `src/kernel/platform-contract.ts`：读取 `contracts/platform.json`（内置工具目录与能力上限）。
- `internal-plugins/`：Forge 自带、随 Runner 发布的 DSH 插件，**目录名 = 插件名**（`forge-runtime`、`forge-skills`、`skill-authoring`、`skill-scripts`、`forge-plugin-bridge`）；`shared/` 是插件共用的库（`events.js` 插件事件表、`skill-script-runtime/` 脚本执行逻辑），不是插件。
- `internal-plugins/forge-runtime/`：每个会话都装配的业务插件，`index.js` 只做组装——`gateway.js`（OpenAI-compatible 模型适配器）、`workspace-tools.js`（工作区工具，配额见 `limits.js`）、`policy-hooks.js`（agent 级 restrict、单调拒绝 guard、dsh 搜索/读取的路径收窄、bash 门控与输出脱敏、外部工具逐次确认；规则在 `path-guard.js`、`bash-rules.js`）。
- `src/kernel/forge-plugins.ts`：Forge 自有插件的唯一登记处（插件名、会话清单能否声明；新增插件 = 建 `internal-plugins/<插件名>/` + 在这里登记一行）；`internal-plugins/shared/events.js`：插件事件的唯一登记表，插件与 DSH 适配层共用；`src/kernel/dsh/engine-tools.js`：dsh 原生工具名与路径参数形状，内核与插件共用。`scripts/check-wiring.mjs` 核对这几张表与平台契约彼此一致。

## 控制面接口（内部 Bearer Token）

| 接口 | 说明 |
| --- | --- |
| `POST /v1/sessions`、`POST /v1/sessions/:id/restore` | 用会话清单（`manifest`）创建 / 重新装配会话 |
| `GET /v1/sessions/:id` | 会话状态：`policyRef`、`lastSeq`、`turnActive`、`turnId`（控制面对账用） |
| `POST /v1/sessions/:id/turns` | 提交一轮，立即返回 `{turnId, after}`；回合在 Runner 内执行到底，不依赖控制面连接 |
| `GET /v1/sessions/:id/events?after=seq` | SSE：先补发 `seq > after` 的持久事件，再推送实时事件；断线后按最后的 seq 续读 |
| `POST /v1/sessions/:id/events/ack` | 回执已落库的位置，Runner 清理该位置之前的执行日志 |

模型配置只能由控制面传入。没有配置模型时拒绝创建执行会话，不会回落到历史假模型。模型凭据只经环境传入 dsh 子进程，不写入 runtime patch。

```bash
npm ci
npm run build
npm run contract      # dsh 扩展点契约（期望值来自 src/kernel/dsh/ 的声明）
npm test              # 清单 / 执行日志 / 文件边界 / 正式插件与真 dsh 协议夹具（非真实模型）
npm run test:workspace # 仅文件执行器/配额边界，不代替审批集成

# 仓库根目录，先初始化 data/business.env
bash scripts/start-runner.sh
```

默认端口9000 / 容量4。每个活跃会话占一个 dsh 进程，归档释放。没有完成 20 会话负载验收或闲置自动回收。

## 运行限额

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 整轮执行上限 | 30 分钟 | 环境变量 `RUNNER_TURN_TIMEOUT_SECONDS`（最少 60 秒）；一轮可包含多次模型请求与工具调用，超时后自动停止，可继续对话 |
| 单次模型请求 / 输出上限 | 300 秒 / 16384 tokens | 平台策略（治理中心）下发；输出上限不超过模型上下文窗口的一半 |
| bash 单条命令 / Skill 脚本单次 | 5 分钟 | 直接执行，仅拦截少数高危命令（见 `classifyBashCommand`） |
| 工作区文件 | 单文件 10 MB、1000 个、总量 200 MB | 只约束 `workspace_write`；`workspace_read` 超过 256000 字符时分段返回 |

## 实际限制

仅 `current_time / workspace_list / workspace_read / workspace_write`；可写工作区的会话另开放 `workspace_present`（把工作区文件声明为交付物，界面在该轮回复下展示文件卡片）。`workspace_write` 支持 `encoding: "base64"` 保存二进制文件；`GET /v1/sessions/:id/raw` 按原始字节读取任意类型文件供预览与下载。原生 shell、原生文件和工作目录工具在业务 patch 禁用，业务白名单进一步限制可见与可执行工具。不允许外部插件安装；这不是容器级隔离。

审批为一次性允许 / 拒绝 / 超时拒绝 / 中止取消；没有人工改参提交或 IM 审批。中止关闭进程，同 Runner 内下一轮可打开本地日志；整个 Runner 重启后不会恢复旧执行，但保留磁盘时文件读取仍可用。

`fork()` 明确拒绝；只读存储事件回看不等于执行分叉或重跑。

## 历史 M0

早期验证代码（固定假模型 + 安全探针，验证 `tools/pre-execute` 的 allow / deny）已完成使命并移除，提交 `1ca7e8e` 及之前的 git 历史中仍可查看；结论见 `docs/05-M0-技术验证报告.md`。
