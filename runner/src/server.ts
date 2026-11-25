/** 业务 Runner 入口。仅控制面凭内部 Token 可访问，浏览器永不直连。 */
import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { SessionKernel, MAX_LISTED_FILES, validModel, type RuntimeModel } from './kernel/session-kernel.js';
import { PluginWorkerClient } from './plugin-worker-client.js';
import type { KernelEvent } from './kernel/types.js';
import { listCodeProjects, resolveCodeProjects, setCodeRoot } from './kernel/code-projects.js';
import { SKILL_CONTENT_REQUIRED, WEB_SEARCH_PROVIDERS } from './kernel/capabilities.js';
import { DSH_VERSION } from './kernel/dsh/index.js';
import { PLATFORM } from './kernel/platform-contract.js';
import { BASE_TOOLS, SHELL_TOOL } from './kernel/toolset.js';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 9))
  throw new Error('Forge Runner requires Node >=24.9.0; current runtime: ' + process.version);
const token = process.env.FORGE_RUNNER_TOKEN;
if (!token || token.length < 24) throw new Error('FORGE_RUNNER_TOKEN (>=24 chars) is required');
const expected = Buffer.from(`Bearer ${token}`);
const pluginWorker = await PluginWorkerClient.start();
const kernel = new SessionKernel(pluginWorker);
/** 事件流心跳：长时间无事件（等待审批、模型思考）时保持连接，控制面据此判断连接仍然存活 */
const HEARTBEAT_MS = 15000;
const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 12 * 1024 * 1024 });
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/healthz') return;
  const auth = Buffer.from(req.headers.authorization ?? '');
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
    return reply.code(401).send({ message: 'internal runner authentication required' });
});
app.setErrorHandler((error: any, _req, reply) =>
  reply.code(error.statusCode ?? 400).send({
    message: error.message ?? 'Runner error',
    // 只带快照引用、而 Runner 没有对应内容的 Skill：控制面据此补发全文后重试
    ...(error.code === SKILL_CONTENT_REQUIRED && Array.isArray(error.missingSkills)
      ? { code: SKILL_CONTENT_REQUIRED, missingSkills: error.missingSkills }
      : {}),
  }),
);
app.get('/healthz', async () => ({ status: 'ok', service: 'forge-runner', mode: 'business' }));
// 能力如实上报：工具目录来自平台契约（与控制面同一份），dsh 版本取自已安装的包
app.get('/v1/runtime', async () => ({
  status: 'online',
  node: process.version,
  dshVersion: DSH_VERSION,
  contractVersion: PLATFORM.version,
  sessions: kernel.size,
  capacity: kernel.capacity,
  active: kernel.active,
  queued: kernel.queued,
  mode: 'real-model-only',
  // 终端沙箱：enforced（命令受沙箱约束）/ unavailable（终端会话被拒绝）/ unknown（尚未探测）
  sandbox: kernel.sandbox,
  capabilities: {
    stream: true,
    approvals: true,
    // 模型可在执行中向用户提问（ask_user_question）；是否开放仍由平台策略决定
    questions: BASE_TOOLS.includes('ask_user_question'),
    workspaceFiles: true,
    codeProjects: true,
    skills: true,
    skillSnapshots: true,
    mcp: ['stdio', 'streamable-http'],
    webSearch: WEB_SEARCH_PROVIDERS,
    // 受控终端命令（bash）属于基础能力，是否开放由平台策略决定
    shell: BASE_TOOLS.includes(SHELL_TOOL),
    fork: false,
    resume: true,
    // 回合由 Runner 执行到底，事件写入执行日志，可按 seq 断线续读
    journal: true,
    tools: PLATFORM.tools.map((tool) => tool.name),
  },
}));
app.post<{
  Body: { binding: Record<string, unknown>; tool: string; arguments?: Record<string, unknown> };
}>('/v1/plugins/test', async (req, reply) => {
  const { binding, tool, arguments: args } = req.body ?? {};
  if (!binding || binding.runtime !== 'forge-remote-worker-v1' || !Array.isArray(binding.tools))
    return reply.code(422).send({ message: '插件试运行配置无效' });
  const selected = (binding.tools as Array<{ name: string; permission: string }>).find(
    (item) => item.name === tool,
  );
  if (!selected || selected.permission !== 'read' || !args || typeof args !== 'object' || Array.isArray(args))
    return reply.code(422).send({ message: '试运行仅支持已声明的只读工具与 JSON 参数' });
  return { result: await pluginWorker.test(binding, tool, args) };
});
app.post('/v1/sessions', async (req, reply) => {
  const body = req.body as {
    manifest: unknown;
    modelConfig: RuntimeModel;
    codeProjects?: string[];
    codeRoot?: string;
    capabilities?: unknown;
  };
  if (!body?.manifest || !body?.modelConfig)
    return reply.code(422).send({ message: 'manifest and modelConfig are required' });
  setCodeRoot(body.codeRoot);
  return kernel.createSession(body.manifest, body.modelConfig, body.codeProjects, body.capabilities);
});
// 以原 id 重新装配执行会话：Runner 重启后由控制面按数据库快照重新下发配置，从磁盘会话日志接续上下文。
// 日志缺失 404、日志无法恢复 410；会话已在内存中时替换配置，下一轮以新配置重启并接续。
app.post<{
  Params: { id: string };
  Body: {
    manifest: unknown;
    modelConfig: RuntimeModel;
    codeProjects?: string[];
    codeRoot?: string;
    capabilities?: unknown;
  };
}>('/v1/sessions/:id/restore', async (req, reply) => {
  const body = req.body;
  if (!body?.manifest || !body?.modelConfig)
    return reply.code(422).send({ message: 'manifest and modelConfig are required' });
  setCodeRoot(body.codeRoot);
  return kernel.restoreSession(
    req.params.id,
    body.manifest,
    body.modelConfig,
    body.codeProjects,
    body.capabilities,
  );
});
// 代码根目录下可关联的项目：一级子目录，附 git 分支与提交。
// root：控制面当前保存的代码目录（空 = FORGE_CODE_ROOT）；执行策略页「检查」也走这里，只查询不保存
app.get<{ Querystring: { root?: string } }>('/v1/code/projects', async (req) =>
  listCodeProjects(req.query?.root),
);
app.get<{ Params: { id: string } }>('/v1/sessions/:id', async (req, reply) =>
  kernel.has(req.params.id)
    ? kernel.state(req.params.id)
    : reply.code(404).send({ message: '执行会话不存在，Runner 可能已重启' }),
);
// 提交一轮：校验通过后立即返回 turnId 与订阅起点 after，回合在 Runner 内执行到结束，与本连接无关。
// 缺少 Skill 内容时在这里以 409 + missingSkills 返回（尚未产生任何事件）。
app.post<{
  Params: { id: string };
  Body: {
    message: string;
    modelConfig?: RuntimeModel;
    codeProjects?: string[];
    codeRoot?: string;
    capabilities?: unknown;
  };
}>('/v1/sessions/:id/turns', async (req, reply) => {
  const id = req.params.id;
  if (!kernel.has(id)) return reply.code(404).send({ message: '执行会话不存在，请新建会话' });
  if (!req.body?.message || req.body.message.length > 64000)
    return reply.code(422).send({ message: 'message is required (<=64000 chars)' });
  if (req.body.modelConfig !== undefined && !validModel(req.body.modelConfig))
    return reply.code(422).send({ message: 'modelConfig requires baseUrl and model' });
  setCodeRoot(req.body.codeRoot);
  if (req.body.codeProjects !== undefined) resolveCodeProjects(req.body.codeProjects);
  return kernel.startTurn(
    id,
    req.body.message,
    req.body.modelConfig,
    req.body.codeProjects,
    req.body.capabilities,
  );
});
/**
 * 事件流（SSE）：先补发 after 之后的持久事件，再推送实时事件（含流式增量），回合结束（done）后关闭。
 * 没有进行中的回合时补发完即关闭；Runner 重启后尚未恢复的会话直接读磁盘执行日志。
 * 控制面断线后用最后收到的 seq 重新订阅即可续上，不会丢失或重复持久事件。
 */
app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
  '/v1/sessions/:id/events',
  async (req, reply) => {
    const id = req.params.id;
    const after = Number(req.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return reply.code(422).send({ message: 'after 无效' });
    const live = kernel.has(id);
    // 先订阅再读积压：两者之间产生的事件按 seq 去重，不会漏
    const buffered: KernelEvent[] = [];
    let forward: ((event: KernelEvent) => void) | null = null;
    const unsubscribe = live
      ? kernel.onEvent(id, (event) => (forward ? forward(event) : buffered.push(event)))
      : () => {};
    let backlog: KernelEvent[];
    try {
      backlog = kernel.eventsAfter(id, after);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });
    let lastSeq = after;
    let closed = false;
    const heartbeat = setInterval(() => {
      if (!raw.destroyed) raw.write(': ping\n\n');
    }, HEARTBEAT_MS);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!raw.destroyed) raw.end();
    };
    raw.on('close', close);
    const send = (event: KernelEvent) => {
      if (closed) return;
      // 流式增量不占编号，原样转发；持久事件按 seq 去重（已补发过的不再发送）
      if (!event.transient) {
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
      }
      if (!raw.destroyed) raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.kind === 'done') close();
    };
    for (const event of backlog) send(event);
    // 没有进行中的回合：积压就是全部
    if (!closed && (!live || !kernel.state(id).turnActive)) return close();
    for (const event of buffered) send(event);
    forward = send;
  },
);
// 控制面已把 seq 及之前的事件落库：Runner 执行日志移除这些事件
app.post<{ Params: { id: string }; Body: { seq: number } }>('/v1/sessions/:id/events/ack', async (req) => {
  kernel.ackEvents(req.params.id, Number(req.body?.seq));
  return { ok: true };
});
app.post<{ Params: { id: string } }>('/v1/sessions/:id/interrupt', async (req) => {
  await kernel.interrupt(req.params.id);
  return { ok: true };
});
app.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (req) => {
  await kernel.disposeSession(req.params.id);
  return { ok: true };
});
app.post<{ Params: { id: string; ticket: string } }>(
  '/v1/sessions/:id/approvals/:ticket/resolve',
  async (req) => {
    await kernel.resolveApproval(req.params.id, req.params.ticket, req.body);
    return { ok: true };
  },
);
app.post<{ Params: { id: string; ticket: string } }>(
  '/v1/sessions/:id/questions/:ticket/resolve',
  async (req) => {
    await kernel.resolveQuestion(req.params.id, req.params.ticket, req.body);
    return { ok: true };
  },
);
app.get<{ Params: { id: string } }>('/v1/sessions/:id/files', async (req) => {
  const items = await kernel.files.listFiles(req.params.id);
  return { items, truncated: items.length >= MAX_LISTED_FILES };
});
app.delete<{ Params: { id: string }; Querystring: { path: string } }>(
  '/v1/sessions/:id/file',
  async (req) => {
    await kernel.files.deleteFile(req.params.id, req.query.path);
    return { ok: true };
  },
);
app.delete<{ Params: { id: string } }>('/v1/sessions/:id/workspace', async (req) => {
  await kernel.files.purgeWorkspace(req.params.id);
  return { ok: true };
});
app.get<{ Params: { id: string }; Querystring: { path: string } }>('/v1/sessions/:id/file', async (req) => ({
  content: await kernel.files.readFile(req.params.id, req.query.path),
}));
app.get<{ Params: { id: string }; Querystring: { path: string } }>(
  '/v1/sessions/:id/raw',
  async (req, reply) => {
    const file = await kernel.files.readRaw(req.params.id, req.query.path);
    return reply
      .header('content-type', file.mime)
      .header('content-length', String(file.bytes))
      .header('x-content-type-options', 'nosniff')
      .send(file.data);
  },
);
app.addHook('onClose', async () => {
  await kernel.dispose();
  await pluginWorker.dispose();
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
await app.listen({ port: Number(process.env.PORT ?? 9000), host: '0.0.0.0' });
console.log(`Forge business Runner ready — dsh ${DSH_VERSION}, platform contract v${PLATFORM.version}`);
