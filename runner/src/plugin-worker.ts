/**
 * Isolated managed-plugin worker. It exposes reviewed built-ins plus a generic
 * remote-worker protocol. Uploaded archives are never imported as Node modules.
 * Every call is restricted by a short-lived, session-bound Runner lease.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import Fastify from 'fastify';

type LeaseBinding = {
  package?: string;
  version?: string;
  artifactHash?: string;
  runtime?: string;
  tools?: { name?: string }[];
  execution?: {
    kind?: string;
    endpoint?: string;
    networkDomains?: string[];
    timeoutSeconds?: number;
    authRef?: string;
  };
};
type Lease = { sessionId: string; expiresAt: number; bindings?: LeaseBinding[] };
type InvokeBody = {
  lease?: string;
  binding?: { package?: string; version?: string; artifactHash?: string; runtime?: string };
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
  {
    id: 'crm-1003',
    name: 'Alex Morgan',
    email: 'alex.morgan@example.test',
    company: 'Northstar Labs',
    stage: '跟进中',
  },
];
let noteSequence = 0;

function outline(args: Record<string, unknown>) {
  const text = String(args.text ?? '').trim();
  if (!text || text.length > 30000) throw new Error('需要提供不超过 30000 个字符的待整理文本');
  const maxItems = Number.isInteger(args.maxItems) ? Math.min(20, Math.max(1, Number(args.maxItems))) : 8;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const ranked = lines.filter((line) => /^#{1,6}\s+/.test(line) || /^[-*•]\s+/.test(line));
  const items: string[] = [];
  for (const line of ranked.length ? ranked : lines) {
    const value = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*•]\s+/, '')
      .replace(/\s+/g, ' ')
      .slice(0, 280);
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
  const query = String(args.query ?? '')
    .trim()
    .toLowerCase();
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

function globallyRoutable(address: string): boolean {
  if (address.includes(':')) {
    const normalized = address.toLowerCase();
    return (
      normalized !== '::1' &&
      !normalized.startsWith('fc') &&
      !normalized.startsWith('fd') &&
      !normalized.startsWith('fe80')
    );
  }
  const [first, second] = address.split('.').map(Number);
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first === 169 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

async function remoteEndpoint(
  execution: LeaseBinding['execution'],
): Promise<{ endpoint: string; timeout: number }> {
  if (!execution || execution.kind !== 'remote-worker' || typeof execution.endpoint !== 'string')
    throw new Error('远程 Worker 执行契约无效');
  const endpoint = new URL(execution.endpoint);
  const host = endpoint.hostname.toLowerCase().replace(/\.$/, '');
  const domains = (execution.networkDomains ?? []).map((value) =>
    String(value).toLowerCase().replace(/\.$/, ''),
  );
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    isIP(host) ||
    !domains.includes(host)
  )
    throw new Error('远程 Worker endpoint 不符合网络白名单');
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('远程 Worker 域名无法解析');
  }
  if (!addresses.length || addresses.some(({ address }) => !globallyRoutable(address)))
    throw new Error('远程 Worker 不能连接本机或内网地址');
  const timeout = Number.isInteger(execution.timeoutSeconds) ? Number(execution.timeoutSeconds) : 20;
  if (timeout < 3 || timeout > 60) throw new Error('远程 Worker 超时配置无效');
  return { endpoint: endpoint.href, timeout };
}

async function invokeRemote(
  execution: LeaseBinding['execution'],
  tool: string,
  args: Record<string, unknown>,
) {
  const { endpoint, timeout } = await remoteEndpoint(execution);
  const authRef = execution?.authRef;
  if (authRef && !/^FORGE_PLUGIN_AUTH_[A-Z0-9_]{1,80}$/.test(authRef))
    throw new Error('远程 Worker 认证引用无效');
  const credential = authRef ? process.env[authRef] : undefined;
  if (authRef && !credential) throw new Error('远程 Worker 认证未配置');
  const signal = AbortSignal.timeout(timeout * 1000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify({ tool, arguments: args }),
      signal,
      redirect: 'error',
    });
  } catch {
    throw new Error('远程 Worker 不可达或请求超时');
  }
  const declaredBytes = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > 256 * 1024)
    throw new Error('远程 Worker 响应超过 256 KB 限制');
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body || typeof body !== 'object' || !('result' in body))
    throw new Error(
      typeof body?.message === 'string' ? body.message.slice(0, 500) : '远程 Worker 返回无效响应',
    );
  if (Buffer.byteLength(JSON.stringify(body.result)) > 256 * 1024)
    throw new Error('远程 Worker 响应超过 256 KB 限制');
  return body.result;
}

function leaseBinding(lease: Lease, body: InvokeBody): LeaseBinding | null {
  const binding = body.binding;
  if (!binding?.package || !binding.version || !binding.artifactHash || !body.tool) return null;
  return (
    lease.bindings?.find(
      (candidate) =>
        candidate.package === binding.package &&
        candidate.version === binding.version &&
        candidate.artifactHash === binding.artifactHash &&
        candidate.runtime === binding.runtime &&
        candidate.tools?.some((tool) => tool.name === body.tool),
    ) ?? null
  );
}

const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
app.get('/healthz', async () => ({ status: 'ok', service: 'forge-plugin-worker' }));
app.post<{ Body: InvokeBody }>('/v1/invoke', async (request, reply) => {
  const lease = verifyLease(request.body?.lease);
  if (!lease) return reply.code(401).send({ message: 'invalid or expired plugin lease' });
  const binding = leaseBinding(lease, request.body ?? {});
  if (!binding)
    return reply.code(403).send({ message: 'plugin binding or tool is not granted by this lease' });
  const tool = request.body?.tool;
  const args = request.body?.arguments ?? {};
  try {
    if (
      binding.package === 'forge-text-tools' &&
      binding.version === '0.1.0' &&
      tool === 'text_extract_outline'
    )
      return { result: outline(args), sessionId: lease.sessionId };
    if (binding.package === 'forge-demo-crm' && binding.version === '0.1.0' && tool === 'crm_find_customer')
      return { result: findCustomer(args), sessionId: lease.sessionId };
    if (
      binding.package === 'forge-demo-crm' &&
      binding.version === '0.1.0' &&
      tool === 'crm_add_customer_note'
    )
      return { result: addCustomerNote(args), sessionId: lease.sessionId };
    if (binding.runtime === 'forge-remote-worker-v1')
      return {
        result: await invokeRemote(binding.execution, String(tool), args),
        sessionId: lease.sessionId,
      };
    return reply.code(403).send({ message: 'plugin runtime is not approved for this worker' });
  } catch (error) {
    return reply
      .code(422)
      .send({ message: error instanceof Error ? error.message : 'plugin execution failed' });
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
