# Forge Harness Runner

正式入口 `src/server.ts`，由控制面以内部 Bearer Token 调用；浏览器不直接访问 Runner。Node >=24.9.0，固定 `dsh@0.2.2-rc.1`。

## 业务路径

- `src/kernel/types.ts`：AgentKernel 端口。
- `dsh-kernel.ts`：会话独立进程、runtime patch、事件桥、审批、受限文件、容量与清理。
- `dsh-process.ts`：换行 JSON-RPC、请求关联、host 请求与安全中止。
- `forge-runtime-plugin/index.js`：OpenAI-compatible 模型适配器、4 个文本工作区工具、agent 级 restrict 与单调拒绝 guard、写入审批门控。

模型配置只能由控制面传入。没有配置模型时拒绝创建执行会话，不会回落到历史假模型。模型凭据只经环境传入 dsh 子进程，不写入 runtime patch。

```bash
npm ci
npm run build
npm run contract      # 19 项扩展点契约
npm test              # 21 项真实文件边界 + 20 项正式插件/真 dsh 协议夹具（非真实模型）
npm run test:workspace # 仅文件执行器/配额边界，不代替审批集成

# 仓库根目录，先初始化 data/business.env
bash scripts/start-runner.sh
```

默认端口9000 / 容量4。每个活跃会话占一个 dsh 进程，归档释放。没有完成 20 会话负载验收或闲置自动回收。

## 实际限制

仅 `current_time / workspace_list / workspace_read / workspace_write`。原生 shell、原生文件和工作目录工具在业务 patch 禁用，业务白名单进一步限制可见与可执行工具。不允许外部插件安装；这不是容器级隔离。

审批为一次性允许 / 拒绝 / 超时拒绝 / 中止取消；没有人工改参提交或 IM 审批。中止关闭进程，同 Runner 内下一轮可打开本地日志；整个 Runner 重启后不会恢复旧执行，但保留磁盘时文件读取仍可用。

`fork()` 明确拒绝；只读存储事件回看不等于执行分叉或重跑。

## 历史 M0

`forge-poc-plugin/`、`scripts/poc.mjs`、`patches/forge-poc.patch.yml` 保留研究证据：固定假模型 + 安全探针验证 `tools/pre-execute` 的 allow / deny。探针不执行真实 Shell，不计入业务模型验收。

```bash
npm run poc
```
