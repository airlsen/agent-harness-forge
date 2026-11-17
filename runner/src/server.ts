/**
 * Runner HTTP 入口：/v1/* → AgentKernel（控制面唯一入口）。
 * Fastify + 进程内最小鉴权（Runner 仅在集群内可达，公网永不暴露）。
 */

import Fastify from 'fastify';
import { DshKernel } from './kernel/dsh-kernel.js';

const kernel = new DshKernel();
const app = Fastify({ logger: true });

app.post('/v1/sessions', async (req) => {
  const { bundle, userCtx } = req.body as any;
  return kernel.createSession(bundle, userCtx);
});

app.post('/v1/sessions/:id/turns', async (req) => {
  const { id } = req.params as any;
  const { message, ...opts } = req.body as any;
  await kernel.sendTurn(id, message, opts);
  return { ok: true };
});

app.post('/v1/sessions/:id/interrupt', async (req) => {
  const { id } = req.params as any;
  await kernel.interrupt(id);
  return { ok: true };
});

app.post('/v1/sessions/:id/fork', async (req) => {
  const { id } = req.params as any;
  const { atSeq } = req.body as any;
  return kernel.fork(id, atSeq);
});

app.post('/v1/sessions/:id/approvals/:ticket/resolve', async (req) => {
  const { id, ticket } = req.params as any;
  await kernel.resolveApproval(id, ticket, req.body);
  return { ok: true };
});

app.get('/healthz', async () => ({ status: 'ok', service: 'forge-runner' }));

const port = Number(process.env.PORT ?? 9000);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
