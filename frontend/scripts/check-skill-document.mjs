/** Skill 元信息读写保留正文、扩展字段与中文展示名。 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
});
try {
  const { readSkillDocument, updateSkillMetadata, initialSkillDocument } = await vite.ssrLoadModule(
    '/src/utils/skillDocument.ts',
  );
  const initial = initialSkillDocument('中文名称');
  assert.equal(readSkillDocument(initial).data.title, '中文名称');
  const source = initial.replace('name: my-skill', 'extra: keep\nname: my-skill');
  const updated = updateSkillMetadata(source, '新名称', '说明：包含冒号\n第二行', 'new-id');
  const result = readSkillDocument(updated);
  assert.equal(result.data.title, '新名称');
  assert.equal(result.data.name, 'new-id');
  assert.equal(result.data.description, '说明：包含冒号\n第二行');
  assert.equal(result.data.extra, 'keep');
  assert.equal(result.body, readSkillDocument(source).body);
  assert.throws(() => updateSkillMetadata(source, '', '有效说明', 'new-id'));
  assert.throws(() => updateSkillMetadata(source, '标题', '有效说明', '中文标识'));
  assert.throws(() => readSkillDocument('没有元信息'));
  assert.throws(() => readSkillDocument('---\nname: [oops\n---\nbody'));
  console.log('PASS Skill 元信息同步、扩展字段保留、正文保留、格式校验');
} finally {
  await vite.close();
}
