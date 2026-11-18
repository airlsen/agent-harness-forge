import assert from 'node:assert/strict';
import { PluginWorkerClient } from '../src/plugin-worker-client.ts';

const worker = await PluginWorkerClient.start();
try {
  const request = {
    lease: worker.issueLease('session-test'),
    binding: { package: 'forge-demo-crm', version: '0.1.0' },
    tool: 'crm_find_customer',
    arguments: { query: '光屿' },
  };
  const response = await fetch(`${worker.url}/v1/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.customers[0].id, 'crm-1001');

  const denied = await fetch(`${worker.url}/v1/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, lease: 'not-a-valid-lease' }),
  });
  assert.equal(denied.status, 401);

  const unknown = await fetch(`${worker.url}/v1/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, tool: 'crm_delete_customer' }),
  });
  assert.equal(unknown.status, 403);
  process.stdout.write('PASS isolated plugin worker accepts a scoped lease and rejects forged or unapproved calls\n');
} finally {
  await worker.dispose();
}
