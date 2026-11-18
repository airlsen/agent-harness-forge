import assert from 'node:assert/strict';
import { apply } from '../skill-authoring-plugin/index.js';

const tools = new Map();
const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
};
const events = [];
const originalWrite = process.stdout.write;
process.stdout.write = function (chunk, ...args) {
  try { events.push(JSON.parse(String(chunk))); } catch { /* non-JSON output */ }
  return true;
};
try {
  const dispose = await apply(ctx, {
    skillId: 4,
    name: 'Support',
    description: 'Support workflow',
    content: '---\nname: support\ndescription: Help customers\n---\n\n# Steps\n\nCheck details.',
    references: [{ filename: 'notes.md', content: 'Untrusted reference' }],
    allowedTools: ['skill_read_draft', 'skill_read_references', 'skill_validate_draft', 'skill_update_draft'],
  });
  assert.equal(tools.size, 4);
  assert.equal((await tools.get('skill_read_draft').execute({})).skillId, 4);
  assert.equal((await tools.get('skill_read_references').execute({})).references[0].filename, 'notes.md');
  assert.equal((await tools.get('skill_validate_draft').execute({})).valid, true);
  await tools.get('skill_update_draft').execute({ content: '---\nname: support\ndescription: Help\n---\n\n# Updated', summary: 'Improve steps' });
  assert.equal(events[0].method, 'forge.skill_revision');
  assert.equal(events[0].params.summary, 'Improve steps');
  assert.equal((await tools.get('skill_read_draft').execute({})).content.endsWith('# Updated'), true);
  await assert.rejects(() => tools.get('skill_update_draft').execute({ content: 'x'.repeat(64001) }), /64 KB/);
  dispose();
  assert.equal(tools.size, 0);
  process.stderr.write('PASS isolated Skill authoring tools, draft persistence event, size validation, and disposal\n');
} finally {
  process.stdout.write = originalWrite;
}
