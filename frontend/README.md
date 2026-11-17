# frontend/ · 工作台与治理界面

Vue 3 + Vite + TS + Pinia + Element Plus（沿用旧 AgentX 技术栈与组件资产）。
平移策略、页面地图、组件设计见 `docs/04-前端架构分析.md`。

## 开发

```bash
pnpm install
pnpm dev      # :5173，/api 代理到控制面 :8000
pnpm mock     # vite-plugin-mock 按冻结的 SSE 协议造流，前后端并行开发
```

三个新增差异化组件（旧前端没有）：TrajectoryPanel（轨迹/回放）、SubagentCard、CostTicker。
