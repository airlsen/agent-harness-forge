# Forge Frontend · Vue 3

正式业务界面，入口为 `src/main.ts` / `App.vue`。使用 Vue Router、Pinia、marked / DOMPurify 与自包含 CSS / SVG 图标，不依赖 CDN。

路由：

- `/agent/chat/:sessionId?`：工作台、会话、审批、上下文 / 轨迹 / 产物
- `/agent/scenarios`：场景 CRUD、复制、版本、试运行 / 发布
- `/agent/capabilities`：组件 / 工具目录，Skill / MCP 未接入提示
- `/agent/models`：模型连接与真实连接测试
- `/agent/governance`：平台工具白名单与限额
- `/agent/audit`：本地审计列表
- `/agent/trajectory/:sessionId`：只读原始事件与导出

```bash
npm ci
npm run dev      # 0.0.0.0:5173，相对 /api 代理到后端 :8000
npm run build    # vue-tsc + Vite；由正式 FastAPI 静态服务 dist
```

API 统一在 `src/api/client.ts`，包含错误处理与 CSRF。EventSource 使用同源 Cookie、持久化事件序号，跨页面返回运行中的会话会重连。

没有模型配置时展示「模型未配置」，不会渲染固定模型回答或伪造执行历史。文本附件为任务输入的一部分，不是后端项目文件或知识库上传。

本地浏览器回归：仓库根目录执行 `python3 scripts/check-business-ui.py`。正式执行流程用 `python3 scripts/check-business-api.py --browser` 在隔离环境下测试，不会配置用户的模型中心。
