/**
 * Isolated managed-plugin worker. It exposes only the reviewed demo adapters and
 * verifies a short-lived, session-bound Runner lease before every invocation.
 * It intentionally has no DSH dependency, workspace mount, or model credential.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';

type Lease = { sessionId: string; expiresAt: number };
type InvokeBody = {
  lease?: string;
  binding?: { package?: string; version?: string };
  tool?: string;
  arguments?: Record<string, unknown>;
};

const configuredSecret = process.env.FORGE_PLUGIN_WORKER_SECRET;
if (!configuredSecret || configuredSecret.length < 32)
  throw new Error('FORGE_PLUGIN_WORKER_SECRET (>=32 chars) is required');
const secret = configuredSecret;

const customers = [
  { id: 'crm-1001', name: '陈晨', email: 'chen.chen@example.test', company: '光屿科技', stage: '已沟通' },
  { id: 'crm-1002', name: '林夏', email: 'lin.xia@example.test', company: '远景零售', stage: '意向客户' },
  { id: 'crm-1003', name: 'Alex Morgan', email: 'alex.morgan@example.test', company: 'Northstar Labs', stage: '跟进中' },
];
let noteSequence = 0;

function outline(args: Record<string, unknown>) {
  const text = String(args.text ?? '').trim();
  if (!text || text.length > 30000) throw new Error('需要提供不超过 30000 个字符的待整理文本');
  const maxItems = Number.isInteger(args.maxItems) ? Math.min(20, Math.max(1, Number(args.maxItems))) : 8;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const ranked = lines.filter((line) => /^#{1,6}\s+/.test(line) || /^[-*•]\s+/.test(line));
  const items: string[] = [];
  for (const line of (ranked.length ? ranked : lines)) {
    const value = line.replace(/^#{1,6}\s+/, '').replace(/^[-*•]\s+/, '').replace(/\s+/g, ' ').slice(0, 280);
    if (value && !items.includes(value)) items.push(value);
    if (items.length >= maxItems) break;
  }
  return { items, characterCount: text.length };
}

function verifyLease(value: unknown): Lease | null {
  if (typeof value !== 'string') return null;
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return null;
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const actual = Buffer.from(signature);
  const anticipated = Buffer.from(expected);
  if (actual.length !== anticipated.length || !timingSafeEqual(actual, anticipated)) return null;
  try {
    const lease = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Lease;
    if (!lease.sessionId || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now()) return null;
    return lease;
  } catch {
    return null;
  }
}

function findCustomer(args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim().toLowerCase();
  if (!query || query.length > 120) throw new Error('需要提供不超过 120 个字符的客户名称或邮箱关键词');
  return {
    customers: customers.filter((customer) =>
      `${customer.name} ${customer.email} ${customer.company}`.toLowerCase().includes(query),
    ),
  };
}

function addCustomerNote(args: Record<string, unknown>) {
  const customerId = String(args.customerId ?? '').trim();
  const note = String(args.note ?? '').trim();
  if (!customers.some((customer) => customer.id === customerId)) throw new Error('未找到演示 CRM 客户');
  if (!note || note.length > 2000) throw new Error('跟进备注长度必须在 1 到 2000 个字符之间');
  noteSequence += 1;
  return { customerId, noteId: `demo-note-${noteSequence}`, saved: true };
}

const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
app.get('/healthz', async () => ({ status: 'ok', service: 'forge-plugin-worker' }));
app.post<{ Body: InvokeBody }>('/v1/invoke', async (request, reply) => {
  const lease = verifyLease(request.body?.lease);
  if (!lease) return reply.code(401).send({ message: 'invalid or expired plugin lease' });
  const binding = request.body?.binding;
  const tool = request.body?.tool;
  const args = request.body?.arguments ?? {};
  try {
    if (binding?.package === 'forge-text-tools' && binding.version === '0.1.0' && tool === 'text_extract_outline')
      return { result: outline(args), sessionId: lease.sessionId };
    if (binding?.package === 'forge-demo-crm' && binding.version === '0.1.0' && tool === 'crm_find_customer')
      return { result: findCustomer(args), sessionId: lease.sessionId };
    if (binding?.package === 'forge-demo-crm' && binding.version === '0.1.0' && tool === 'crm_add_customer_note')
      return { result: addCustomerNote(args), sessionId: lease.sessionId };
    return reply.code(403).send({ message: 'plugin binding or tool is not approved for this worker' });
  } catch (error) {
    return reply.code(422).send({ message: error instanceof Error ? error.message : 'plugin execution failed' });
  }
});

const port = Number(process.env.FORGE_PLUGIN_WORKER_PORT ?? 0);
const address = await app.listen({ port, host: '127.0.0.1' });
const actualPort = new URL(address).port;
process.stdout.write(JSON.stringify({ type: 'forge-plugin-worker-ready', port: actualPort }) + '\n');
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
