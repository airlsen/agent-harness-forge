#!/usr/bin/env node
/** Catalog ordering stays local to the page and never mistakes draft updates for releases. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/*'] } },
});
try {
  const { orderScenarios, orderManagedSkills, orderPublishedSkills, orderByCreated, catalogDate } =
    await vite.ssrLoadModule('/src/utils/common/catalogOrdering.ts');
  const d = (day) => `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
  const ids = (items) => items.map((item) => item.id);
  const scenarios = [
    { id: 1, space: 'official', status: 'template', createdAt: d(30), published_version: 0 },
    { id: 2, space: 'official', status: 'template', createdAt: d(30), published_version: 0 },
    {
      id: 3,
      space: 'personal',
      status: 'published',
      createdAt: d(1),
      publishedAt: d(20),
      published_version: 1,
      updatedAt: d(30),
    },
    { id: 4, space: 'personal', status: 'draft', createdAt: d(25), publishedAt: null, published_version: 0 },
    {
      id: 5,
      space: 'personal',
      status: 'published',
      createdAt: d(30),
      publishedAt: null,
      published_version: 1,
    },
    {
      id: 6,
      space: 'personal',
      status: 'published',
      createdAt: d(29),
      publishedAt: d(10),
      published_version: 1,
      updatedAt: d(30),
    },
  ];
  assert.deepEqual(ids(orderScenarios(scenarios)), [4, 3, 6, 5, 1, 2]);
  assert.deepEqual(ids(scenarios), [1, 2, 3, 4, 5, 6], 'global order must not be mutated');
  const skills = [
    { id: 1, createdAt: d(30), updatedAt: d(30), publishedRevisionId: 1, publishedAt: d(10) },
    { id: 2, createdAt: d(15), updatedAt: d(30), publishedRevisionId: null, publishedAt: null },
    { id: 3, createdAt: d(1), updatedAt: d(30), publishedRevisionId: 2, publishedAt: d(20), status: 'draft' },
    { id: 4, createdAt: d(30), updatedAt: d(30), publishedRevisionId: 4, publishedAt: null },
  ];
  assert.deepEqual(ids(orderManagedSkills(skills)), [3, 2, 1, 4]);
  skills[0].publishedAt = d(25);
  assert.deepEqual(ids(orderManagedSkills(skills)), [1, 3, 2, 4], 'republish changes order');
  assert.deepEqual(
    ids(
      orderPublishedSkills([
        { id: 1, publishedAt: d(2) },
        { id: 3, publishedAt: d(2) },
        { id: 2, publishedAt: null },
      ]),
    ),
    [3, 1, 2],
  );
  assert.deepEqual(
    ids(
      orderByCreated([
        { id: 1, createdAt: 'invalid' },
        { id: 2, createdAt: d(5) },
        { id: 3, createdAt: d(5) },
      ]),
    ),
    [3, 2, 1],
  );
  assert.equal(catalogDate('发布', null), '发布日期未知');
  assert.equal(catalogDate('创建', 'invalid'), '创建日期未知');
  console.log('PASS catalog dates, mixed status ordering, stable ties and immutable global order');
} finally {
  await vite.close();
}
