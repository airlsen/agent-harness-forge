import assert from 'node:assert/strict';
import { apply } from '../forge-plugin-bridge/index.js';

const tools = new Map();
const preExecuteHooks = [];
const events = [];
const originalWrite = process.stdout.write;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(String(init?.body ?? '{}'));
  if (request.tool === 'text_extract_outline' && String(request.arguments?.text ?? '').length > 30000)
    return { ok: false, json: async () => ({ message: '单次文本不能超过 30000 个字符' }) };
  const result = request.tool === 'text_extract_outline'
    ? { items: ['标题', '第一项'], characterCount: 21 }
    : request.tool === 'crm_find_customer'
      ? { customers: [{ id: 'crm-1001' }] }
      : request.tool === 'acme_find_contact'
        ? { contacts: [{ id: 'acme-1' }] }
        : { customerId: 'crm-1001', noteId: 'demo-note-1', saved: true };
  return { ok: true, json: async () => ({ result }) };
};
process.stdout.write = function (chunk, ...args) {
  try { events.push(JSON.parse(String(chunk))); } catch { /* non-JSON output */ }
  return true;
};
try {
  const dispose = await apply(
    {
      tools: {
        register(definition) {
          tools.set(definition.name, definition);
          return () => tools.delete(definition.name);
        },
      },
      on(name, handler) {
        if (name === 'tools/pre-execute') preExecuteHooks.push(handler);
        return () => {
          const index = preExecuteHooks.indexOf(handler);
          if (index >= 0) preExecuteHooks.splice(index, 1);
        };
      },
    },
    {
      allowedTools: ['text_extract_outline', 'crm_find_customer', 'crm_add_customer_note', 'acme_find_contact'],
      gatewayUrl: 'http://127.0.0.1:9411',
      lease: 'abcdefghijklmnopqrstuvwxyz0123456789-lease',
      bindings: [
        {
          package: 'forge-text-tools',
          version: '0.1.0',
          artifactHash: 'a'.repeat(64),
          runtime: 'forge-bridge',
          tools: [
            {
              name: 'text_extract_outline',
              description: 'Extract outline',
              permission: 'read',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
            },
          ],
        },
        {
          package: 'forge-demo-crm',
          version: '0.1.0',
          artifactHash: 'b'.repeat(64),
          runtime: 'forge-bridge',
          tools: [
            {
              name: 'crm_find_customer',
              description: 'Find demo CRM customer',
              permission: 'read',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
            },
            {
              name: 'crm_add_customer_note',
              description: 'Write demo CRM note',
              permission: 'approval',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
            },
          ],
        },
        {
          package: 'acme-contacts',
          version: '1.2.3',
          artifactHash: 'c'.repeat(64),
          runtime: 'forge-remote-worker-v1',
          tools: [
            {
              name: 'acme_find_contact',
              description: 'Find an Acme contact through the reviewed remote worker',
              permission: 'read',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
            },
          ],
        },
      ],
    },
  );
  assert.equal(tools.size, 4);
  const result = await tools.get('text_extract_outline').execute({
    text: '# 标题\n\n- 第一项\n- 第二项\n正文。',
    maxItems: 2,
  });
  assert.deepEqual(result.items, ['标题', '第一项']);
  assert.equal(result.characterCount, 21);
  const customers = await tools.get('crm_find_customer').execute({ query: '光屿' });
  assert.equal(customers.customers[0].id, 'crm-1001');
  const contacts = await tools.get('acme_find_contact').execute({ query: 'Alex' });
  assert.equal(contacts.contacts[0].id, 'acme-1');
  const approval = await preExecuteHooks[0](
    { name: 'crm_add_customer_note', callId: 'call-1', arguments: { customerId: 'crm-1001', note: '回电' } },
    () => ({ kind: 'allow' }),
  );
  assert.equal(approval.kind, 'ask');
  const note = await tools.get('crm_add_customer_note').execute({ customerId: 'crm-1001', note: '回电' });
  assert.equal(note.saved, true);
  assert.equal(events[0].method, 'forge.plugin_loaded');
  assert.equal(events.filter((event) => event.method === 'forge.plugin_call').length, 4);
  await assert.rejects(
    () => tools.get('text_extract_outline').execute({ text: 'x'.repeat(30001) }),
    /30000/,
  );
  dispose();
  assert.equal(tools.size, 0);
  process.stderr.write('PASS managed Forge plugin bridge registers only granted tools and disposes cleanly\n');
} finally {
  process.stdout.write = originalWrite;
  globalThis.fetch = originalFetch;
}
