/** 业务 Runner 入口。仅控制面凭内部 Token 可访问，浏览器永不直连。 */
import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { DshKernel, type RuntimeModel } from './kernel/dsh-kernel.js';
import type { Bundle, UserCtx } from './kernel/types.js';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 9))
  throw new Error('Forge Runner requires Node >=24.9.0; current runtime: ' + process.version);
const token = process.env.FORGE_RUNNER_TOKEN;
if (!token || token.length < 24) throw new Error('FORGE_RUNNER_TOKEN (>=24 chars) is required');
const expected = Buffer.from(`Bearer ${token}`);
const kernel = new DshKernel();
const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 1024 * 1024 });
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/healthz') return;
  const auth = Buffer.from(req.headers.authorization ?? '');
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
    return reply.code(401).send({ message: 'internal runner authentication required' });
});
app.setErrorHandler((error: any, _req, reply) =>
  reply.code(error.statusCode ?? 400).send({ message: error.message ?? 'Runner error' }),
);
app.get('/healthz', async () => ({ status: 'ok', service: 'forge-runner', mode: 'business' }));
app.get('/v1/runtime', async () => ({
  status: 'online',
  node: process.version,
  dshVersion: '0.2.2-rc.1',
  sessions: kernel.size,
  capacity: kernel.capacity,
  mode: 'real-model-only',
  capabilities: { stream: true, approvals: true, workspaceFiles: true, shell: false, fork: false },
}));
app.post('/v1/sessions', async (req, reply) => {
  if (kernel.size >= kernel.capacity)
    return reply.code(429).send({ message: '会话容量已满，请关闭暂不使用的会话' });
  const body = req.body as { bundle: Bundle; userCtx: UserCtx; modelConfig: RuntimeModel };
  if (!body?.bundle || !body?.modelConfig)
    return reply.code(422).send({ message: 'bundle and modelConfig are required' });
  return kernel.createSession(body.bundle, body.userCtx, body.modelConfig);
});
app.get<{ Params: { id: string } }>('/v1/sessions/:id', async (req, reply) =>
  kernel.has(req.params.id)
    ? { exists: true, busy: kernel.isBusy(req.params.id) }
    : reply.code(404).send({ message: '执行会话不存在，Runner 可能已重启' }),
);
app.post<{ Params: { id: string }; Body: { message: string } }>(
  '/v1/sessions/:id/stream',
  async (req, reply) => {
    const id = req.params.id;
    if (!kernel.has(id)) return reply.code(404).send({ message: '执行会话不存在，请新建会话' });
    if (kernel.isBusy(id)) return reply.code(409).send({ message: '会话正在执行' });
    if (!req.body?.message || req.body.message.length > 64000)
      return reply.code(422).send({ message: 'message is required (<=64000 chars)' });
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
      await kernel.sendTurn(id, req.body.message);
    } finally {
      unsubscribe();
      if (!reply.raw.destroyed) reply.raw.end();
    }
  },
);
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
app.get<{ Params: { id: string } }>('/v1/sessions/:id/files', async (req) => ({
  items: await kernel.listFiles(req.params.id),
}));
app.get<{ Params: { id: string }; Querystring: { path: string } }>('/v1/sessions/:id/file', async (req) => ({
  content: await kernel.readFile(req.params.id, req.query.path),
}));
app.addHook('onClose', () => kernel.dispose());
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
await app.listen({ port: Number(process.env.PORT ?? 9000), host: '0.0.0.0' });
console.log('Forge business Runner ready — real models only; shell disabled');
