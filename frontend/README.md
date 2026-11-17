# Forge Frontend · 企业版第一批

在现有 Vue 3 / Router / Pinia 业务应用内改造，不是另建演示站。公共场景与能力在前台可发现，个人内容仅用“我的会话”组织；本批不实现员工身份和多用户隔离。

## 路由

| 路径 | 页面 |
|---|---|
| `/`、`/agent` | 重定向到企业工作台 |
| `/agent/workbench` | 任务输入、预置/已发布场景、公共能力入口、最近会话 |
| `/agent/scenarios` | 场景使用目录；`?view=maintain` 为同一资源的维护视图 |
| `/agent/capabilities` | 公共工具发现、用途、边界、适用场景；`?tab=skills` / `?tab=mcp` 读取真实接入状态 |
| `/agent/conversations` | 当前账号会话搜索、状态筛选与确认归档 |
| `/agent/chat/:sessionId?` | 对话、审批；结果 / 过程 / 能力按需展开，默认不占据右栏 |
| `/agent/manage` | 管理概览、公共资源维护入口、当前部署边界 |
| `/agent/models` | 模型连接与真实连接测试 |
| `/agent/governance` | 平台工具范围、审批和限额 |
| `/agent/audit` | 实际会话审计列表 |
| `/agent/trajectory/:sessionId` | 原始事件只读查看、筛选与导出 |

旧的 `/agent/chat/:sessionId` 等深链接保留，不改变认证或 API 路径。

## 代码分工

- `App.vue`：常驻企业导航、管理区导航、指南；存在运行中会话时每 3 秒同步会话列表状态，防止离开 SSE 页后状态滞留。
- `components/TaskComposer.vue`：首页/会话共用输入、场景选择、文本附件和发送，拒绝空提交、二进制文本和超限附件。
- `components/DialogShell.vue`、`utils/focus.ts`：遮罩、Esc、Tab 焦点约束与焦点返回；这些焦点约束仅用于弹窗和按需详情，不把常驻主导航当作模态抽屉。
- `utils/presentation.ts`：统一状态/日期/文件尺寸，`idle` 只显示“可继续”，不等于成功。
- `stores/conversation.ts`：真实 SSE 与执行状态；提交/读取代际校验，迟到响应不能污染新会话；附件读取跟随草稿版本。
- `style.css`：既有管理表单、Markdown 与基础业务样式。
- `enterprise.css`：新版外壳、公共目录、工作台、会话体验与响应式布局；桌面/平板为常驻完整侧栏，700px 及以下为常驻有文字导航栏，不再点击展开。所有导航行共用固定图标列、文字列与尾部列；短窗口的菜单区域独立滚动。保留原有暖橙主题，无外部字体、图片或 CDN 依赖。

## 开发

```bash
npm ci
npm run dev      # 0.0.0.0:5173，相对 /api 代理到后端 :8000
npm run build    # vue-tsc + Vite；构建后由 FastAPI 同源服务
npm run format:check
```

API 统一在 `src/api/client.ts`，包含错误处理与 CSRF。认证优先用 HttpOnly Cookie；仅开启预览兼容模式且 Cookie 不可用时，使用当前标签页的 1 小时 Header 会话（内存 / sessionStorage，不使用 localStorage）。该令牌可被页面 JS 读取，不宣称具备 HttpOnly 防护。

`src/api/events.ts` 使用带统一认证的 fetch SSE 和持久化游标重连；JSON 导出也使用认证 fetch，不在 URL 携带令牌。离开再返回运行中的会话会重新订阅。

文本附件以内容随任务发送，不是知识库上传。不支持的 Skill、MCP、通用插件安装和成员管理如实说明，不制造成功记录。

## 验证

从仓库根目录执行：

```bash
python3 scripts/check-business-ui.py  # 实际无模型部署；临时复制/编辑/删除一个回归场景
python3 scripts/check-business-api.py --browser
python3 scripts/check-business-api.py --browser --cookie-blocked
python3 scripts/check-iframe-auth.py --block-cookies --block-storage --opaque-frame
```

执行浏览器回归在隔离数据库、认证和 Runner 中使用明确的本机协议夹具，不配置用户的模型，不等于真实提供商验收。

## 上线边界

当前后台仍为单管理员版本，沿用旧场景 `space` 字段。公共目录是企业目标的前端组织，不代表已经完成公共资产权限模型迁移。不得让全员共用 admin 后声称实现了员工间会话隔离。

后续企业多人上线必须补齐：真实员工身份、服务端会话归属检查（含 SSE、文件、导出、审批）、公共资产职责权限，以及 Skills/MCP 的实际注册与执行。详见 `docs/08` 方案与 `docs/09` 第一批实现说明。
