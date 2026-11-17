# backend/ · 控制面（Control Plane）

Python 3.12 + FastAPI。职责：租户/RBAC、场景装配（Bundle 编译）、Runner 调度、审批回调、审计检索、配额对账。
**不认识任何 dsh/Cordis 类型**，与 Runner 仅通过 AgentKernel HTTP 契约通信（见 `services/runner_client.py`）。

## 开发

```bash
cd ../backend
uv sync                 # 或 pip install -e ".[dev]"
cp .env.example .env
uvicorn src.api.main:app --reload --port 8000
```

分层规范：route 不写业务 · service 不碰 HTTP · model 不做序列化 · 统一 ResponseUtil。
详细设计见 `docs/03-后端架构分析.md`。
