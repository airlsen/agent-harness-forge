/** 业务 Runner 入口。仅控制面凭内部 Token 可访问，浏览器永不直连。 */
import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { DshKernel, MAX_LISTED_FILES, validModel, type RuntimeModel } from './kernel/dsh-kernel.js';
import { PluginWorkerClient } from './plugin-worker-client.js';
import type { Bundle, UserCtx } from './kernel/types.js';
import { listCodeProjects, resolveCodeProjects, setCodeRoot } from './kernel/code-projects.js';
import { SKILL_CONTENT_REQUIRED } from './kernel/capabilities.js';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 9))
  throw new Error('Forge Runner requires Node >=24.9.0; current runtime: ' + process.version);
const token = process.env.FORGE_RUNNER_TOKEN;
if (!token || token.length < 24) throw new Error('FORGE_RUNNER_TOKEN (>=24 chars) is required');
const expected = Buffer.from(`Bearer ${token}`);
const pluginWorker = await PluginWorkerClient.start();
const kernel = new DshKernel(pluginWorker);
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
app.get('/v1/runtime', async () => ({
  status: 'online',
  node: process.version,
  dshVersion: '0.2.2-rc.1',
  sessions: kernel.size,
  capacity: kernel.capacity,
  active: kernel.active,
  queued: kernel.queued,
  mode: 'real-model-only',
  capabilities: {
    stream: true,
    approvals: true,
    workspaceFiles: true,
    codeProjects: true,
    skills: true,
    skillSnapshots: true,
    mcp: ['stdio', 'streamable-http'],
    webSearch: true,
    shell: false,
    fork: false,
    resume: true,
  },
}));
app.post<{
  Body: { binding: Record<string, unknown>; tool: string; arguments?: Record<string, unknown> };
}>('/v1/plugins/test', async (req, reply) => {
  const { binding, tool, arguments: args } = req.body ?? {};
  if (!binding || binding.runtime !== 'forge-remote-worker-v1' || !Array.isArray(binding.tools))
    return reply.code(422).send({ message: '插件试运行配置无效' });
  const selected = (binding.tools as Array<{ name: string; permission: string }>).find((item) => item.name === tool);
  if (!selected || selected.permission !== 'read' || !args || typeof args !== 'object' || Array.isArray(args))
    return reply.code(422).send({ message: '试运行仅支持已声明的只读工具与 JSON 参数' });
  return { result: await pluginWorker.test(binding, tool, args) };
});
app.post('/v1/sessions', async (req, reply) => {
  const body = req.body as {
    bundle: Bundle;
    userCtx: UserCtx;
    modelConfig: RuntimeModel;
    codeProjects?: string[];
    codeRoot?: string;
    capabilities?: unknown;
  };
  if (!body?.bundle || !body?.modelConfig)
    return reply.code(422).send({ message: 'bundle and modelConfig are required' });
  setCodeRoot(body.codeRoot);
  return kernel.createSession(
    body.bundle,
    body.userCtx,
    body.modelConfig,
    body.codeProjects,
    body.capabilities,
  );
});
// 以原 id 重新装配执行会话：Runner 重启后由控制面按数据库快照重新下发配置，从磁盘会话日志接续上下文。
// 日志缺失 404、日志无法恢复 410；会话已在内存中时替换配置，下一轮以新配置重启并接续。
app.post<{
  Params: { id: string };
  Body: {
    bundle: Bundle;
    userCtx: UserCtx;
    modelConfig: RuntimeModel;
    codeProjects?: string[];
    codeRoot?: string;
    capabilities?: unknown;
  };
}>('/v1/sessions/:id/restore', async (req, reply) => {
  const body = req.body;
  if (!body?.bundle || !body?.modelConfig)
    return reply.code(422).send({ message: 'bundle and modelConfig are required' });
  setCodeRoot(body.codeRoot);
  return kernel.restoreSession(
    req.params.id,
    body.bundle,
    body.userCtx,
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
    ? { exists: true, busy: kernel.isBusy(req.params.id), policyRef: kernel.policyRef(req.params.id) }
    : reply.code(404).send({ message: '执行会话不存在，Runner 可能已重启' }),
);
app.post<{
  Params: { id: string };
  Body: {
    message: string;
    modelConfig?: RuntimeModel;
    codeProjects?: string[];
    codeRoot?: string;
    capabilities?: unknown;
  };
}>('/v1/sessions/:id/stream', async (req, reply) => {
  const id = req.params.id;
  if (!kernel.has(id)) return reply.code(404).send({ message: '执行会话不存在，请新建会话' });
  if (kernel.isBusy(id)) return reply.code(409).send({ message: '会话正在执行' });
  if (kernel.isQueued(id)) return reply.code(409).send({ message: '会话正在排队等待执行，请稍候' });
  if (!req.body?.message || req.body.message.length > 64000)
    return reply.code(422).send({ message: 'message is required (<=64000 chars)' });
  // 必须在接管响应流之前校验，否则错误无法以 422 返回给控制面。
  if (req.body.modelConfig !== undefined && !validModel(req.body.modelConfig))
    return reply.code(422).send({ message: 'modelConfig requires baseUrl and model' });
  setCodeRoot(req.body.codeRoot);
  if (req.body.codeProjects !== undefined) resolveCodeProjects(req.body.codeProjects);
  // 解析结果直接交给 sendTurn（不会重复解析）；缺少 Skill 内容时在这里以 409 返回
  if (req.body.capabilities !== undefined)
    req.body.capabilities = kernel.resolveTurnCapabilities(req.body.capabilities, id);
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const unsubscribe = kernel.onEvent(id, (event) => {
    if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  reply.raw.on('close', unsubscribe);
  try {
    await kernel.sendTurn(
      id,
      req.body.message,
      undefined,
      req.body.modelConfig,
      req.body.codeProjects,
      req.body.capabilities,
    );
  } finally {
    unsubscribe();
    if (!reply.raw.destroyed) reply.raw.end();
  }
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
app.get<{ Params: { id: string } }>('/v1/sessions/:id/files', async (req) => {
  const items = await kernel.listFiles(req.params.id);
  return { items, truncated: items.length >= MAX_LISTED_FILES };
});
app.delete<{ Params: { id: string }; Querystring: { path: string } }>(
  '/v1/sessions/:id/file',
  async (req) => {
    await kernel.deleteFile(req.params.id, req.query.path);
    return { ok: true };
  },
);
app.delete<{ Params: { id: string } }>('/v1/sessions/:id/workspace', async (req) => {
  await kernel.purgeWorkspace(req.params.id);
  return { ok: true };
});
app.get<{ Params: { id: string }; Querystring: { path: string } }>('/v1/sessions/:id/file', async (req) => ({
  content: await kernel.readFile(req.params.id, req.query.path),
}));
app.get<{ Params: { id: string }; Querystring: { path: string } }>(
  '/v1/sessions/:id/raw',
  async (req, reply) => {
    const file = await kernel.readRaw(req.params.id, req.query.path);
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
console.log('Forge business Runner ready — real models only; shell disabled');
