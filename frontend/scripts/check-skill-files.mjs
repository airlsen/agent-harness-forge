/** Skill 目录：文件树、文件名校验与整理、容量检查、预览与助手改动摘要。 */
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
  const files = await vite.ssrLoadModule('/src/utils/skillFiles.ts');
  const file = (path, bytes = 10) => ({ path, bytes, source: 'manual' });

  // 两个目录始终显示，文件按名称排序归入各自目录
  const tree = files.skillFileTree([
    file('references/b.md'),
    file('assets/t.json'),
    file('references/a.txt'),
  ]);
  assert.deepEqual(
    tree.map((folder) => [folder.dir, folder.files.map((item) => item.path)]),
    [
      ['references', ['references/a.txt', 'references/b.md']],
      ['assets', ['assets/t.json']],
    ],
  );
  assert.deepEqual(
    files.skillFileTree([]).map((folder) => [folder.dir, folder.files.length]),
    [
      ['references', 0],
      ['assets', 0],
    ],
  );

  assert.equal(files.fileNameError('references', 'rules.md'), '');
  assert.equal(files.fileNameError('assets', 'data.yaml'), '');
  assert.match(files.fileNameError('references', 'data.json'), /只支持/);
  assert.match(files.fileNameError('references', '规则.md'), /英文字母/);
  assert.match(files.fileNameError('references', '.hidden.md'), /英文字母/);
  assert.match(files.fileNameError('assets', ''), /请输入/);
  assert.equal(files.acceptFor('references'), '.md,.txt');

  assert.equal(files.suggestFileName('references', 'Weekly Report v2.MD'), 'Weekly-Report-v2.md');
  assert.equal(files.suggestFileName('references', '周报规则.md'), '');
  assert.equal(files.suggestFileName('references', '周报 rules.md'), 'rules.md');
  assert.equal(files.suggestFileName('references', 'C:\\docs\\notes.txt'), 'notes.txt');
  assert.equal(files.suggestFileName('references', 'data.json'), '');

  assert.equal(files.initialFileContent('references/rules.md'), '# rules\n\n');
  assert.equal(files.initialFileContent('assets/data.json'), '');
  assert.equal(files.editorLanguage('assets/a.yml'), 'yaml');
  assert.equal(files.editorLanguage('assets/a.csv'), 'plaintext');
  assert.equal(files.previewMarkdown('references/a.md', '# 标题'), '# 标题');
  assert.equal(files.previewMarkdown('assets/a.json', '{"a":1}'), '```json\n{"a":1}\n```');
  // 内容里有反引号时使用更长的围栏，HTML 只展示源码
  assert.equal(files.previewMarkdown('assets/a.html', '<b>```</b>'), '````html\n<b>```</b>\n````');

  const many = Array.from({ length: 20 }, (_, index) => file(`references/r${index}.md`));
  assert.match(files.capacityError(many, 'references/new.md', 1), /最多 20 个/);
  assert.equal(files.capacityError(many, 'references/r0.md', 1), ''); // 覆盖不算新增
  assert.match(files.capacityError([], 'references/a.md', 120_001), /120 KB/);
  assert.match(
    files.capacityError(
      [
        file('assets/a.md', 110_000),
        file('assets/b.md', 110_000),
        file('assets/c.md', 110_000),
        file('assets/d.md', 110_000),
      ],
      'assets/e.md',
      100_000,
    ),
    /512 KB/,
  );

  const summary = files.summarizeAssistantChanges([
    { action: 'write_file', path: 'references/rules.md' },
    { action: 'update_draft', path: 'SKILL.md' },
    { action: 'write_file', path: 'assets/old.md' },
    { action: 'delete_file', path: 'assets/old.md' },
  ]);
  assert.deepEqual(summary.written, ['SKILL.md', 'references/rules.md']);
  assert.deepEqual(summary.deleted, ['assets/old.md']);
  assert.equal(summary.text, '已更新 SKILL.md、references/rules.md；已删除 assets/old.md，尚未发布。');
  assert.equal(files.summarizeAssistantChanges([]).text, '');
  console.log('PASS Skill 目录：文件树、文件名校验与整理、容量检查、预览、助手改动摘要');
} finally {
  await vite.close();
}
