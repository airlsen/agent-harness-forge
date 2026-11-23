#!/usr/bin/env node
/** 会话文件工具函数检查：类型识别、预览判定、CSV 解析、代码围栏与交付物解析。纯函数、无网络。 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/*'] } },
});
const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
  console.log('PASS', name);
};
try {
  const files = await vite.ssrLoadModule('/src/utils/file/files.ts');

  check('file kinds follow extensions first, then MIME', () => {
    const cases = {
      'img/chart.PNG': 'image',
      'logo.svg': 'image',
      'report.pdf': 'pdf',
      'site/index.html': 'html',
      'README.md': 'markdown',
      'data.csv': 'table',
      'data.tsv': 'table',
      'main.py': 'code',
      'config.yaml': 'code',
      Dockerfile: 'code',
      'notes.txt': 'text',
      'deck.pptx': 'office',
      'bundle.zip': 'archive',
      'clip.mp4': 'video',
      'voice.mp3': 'audio',
      'blob.bin': 'binary',
    };
    for (const [path, kind] of Object.entries(cases)) assert.equal(files.fileKind(path), kind, path);
    assert.equal(files.fileKind('photo', 'image/jpeg'), 'image');
    assert.equal(files.fileKind('LICENSE', 'text/plain'), 'text');
  });
  check('path helpers split name, directory and extension', () => {
    assert.equal(files.fileName('a/b/报告.final.md'), '报告.final.md');
    assert.equal(files.fileDir('a/b/报告.md'), 'a/b');
    assert.equal(files.fileDir('报告.md'), '');
    assert.equal(files.fileExt('.env'), '');
    assert.equal(files.codeLanguage('src/app.tsx'), 'tsx');
    assert.equal(files.codeLanguage('unknown.xyz'), 'text');
  });
  check('only browser-renderable files are previewable; huge text downloads instead', () => {
    assert.equal(files.previewable({ path: 'a.png', bytes: 5_000_000 }), true);
    assert.equal(files.previewable({ path: 'a.md', bytes: 100 }), true);
    assert.equal(files.previewable({ path: 'a.md', bytes: files.TEXT_PREVIEW_LIMIT + 1 }), false);
    assert.equal(files.previewable({ path: 'a.xlsx', bytes: 100 }), false);
    assert.equal(files.previewable({ path: 'a.bin', bytes: 100 }), false);
  });
  check('code fences outgrow backtick runs inside the content', () => {
    assert.equal(files.fenced('print(1)\n', 'python'), '```python\nprint(1)\n```');
    assert.equal(files.fenced('a ```` b', 'md'), '`````md\na ```` b\n`````');
  });
  check('CSV parsing handles quotes, escaped quotes, CRLF, newlines in cells and BOM', () => {
    const { rows, truncated } = files.parseDelimited(
      '\uFEFF名称,备注\r\n"A, Inc","说 ""好""\n第二行"\r\nB,\n',
    );
    assert.deepEqual(rows, [
      ['名称', '备注'],
      ['A, Inc', '说 "好"\n第二行'],
      ['B', ''],
    ]);
    assert.equal(truncated, false);
    assert.deepEqual(files.parseDelimited('a\tb\n1\t2', '\t').rows, [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  check('CSV preview stops at the row limit and reports truncation', () => {
    const text = Array.from({ length: 10 }, (_, i) => `r${i},x`).join('\n');
    const result = files.parseDelimited(text, ',', 4);
    assert.equal(result.rows.length, 4);
    assert.equal(result.truncated, true);
    assert.equal(files.parseDelimited('a\nb\n', ',', 2).truncated, false);
  });
  check('present results parse defensively', () => {
    assert.deepEqual(
      files.parseDeliverables(
        JSON.stringify({
          files: [{ path: 'r.md', bytes: 9, description: '报告' }, { path: '' }, { bytes: 1 }],
        }),
      ),
      [{ path: 'r.md', bytes: 9, description: '报告' }],
    );
    assert.deepEqual(files.parseDeliverables('not json'), []);
    assert.deepEqual(files.parseDeliverables('{"files":"x"}'), []);
    assert.deepEqual(files.parseDeliverables(undefined), []);
  });
  check('later declarations of the same path win and listing refreshes size/type', () => {
    const merged = files.mergeDeliverables(
      [{ path: 'a.md', bytes: 1 }],
      [
        { path: 'b.png', bytes: 2 },
        { path: 'a.md', bytes: 3, description: '新版' },
      ],
    );
    assert.deepEqual(merged, [
      { path: 'a.md', bytes: 3, description: '新版' },
      { path: 'b.png', bytes: 2 },
    ]);
    assert.deepEqual(
      files.withListing(merged[0], [{ path: 'a.md', bytes: 40, mime: 'text/markdown', modifiedAt: 't' }]),
      { path: 'a.md', bytes: 40, mime: 'text/markdown', modifiedAt: 't', description: '新版' },
    );
    assert.deepEqual(files.withListing(merged[1], []), { path: 'b.png', bytes: 2 });
  });
  check('raw file URLs encode the whole path as one query value', () => {
    assert.equal(
      files.rawFileUrl(7, '图表/a b&c.png'),
      '/agent/sessions/7/files/raw?path=%E5%9B%BE%E8%A1%A8%2Fa%20b%26c.png',
    );
  });
  check('archive, delete and diff URLs are encoded', () => {
    assert.equal(files.archiveUrl(7), '/agent/sessions/7/files/archive');
    assert.equal(
      files.archiveUrl(7, '图表/out'),
      '/agent/sessions/7/files/archive?dir=%E5%9B%BE%E8%A1%A8%2Fout',
    );
    assert.equal(files.fileUrl(7, 'a b.md'), '/agent/sessions/7/files?path=a%20b.md');
    assert.equal(files.changeDiffUrl(7, 42), '/agent/sessions/7/files/changes/42');
  });
  check('turn changes are parsed defensively and totalled', () => {
    assert.equal(files.parseChanges(null), null);
    assert.equal(files.parseChanges({ total: 0, files: [] }), null);
    const changes = files.parseChanges({
      messageId: 9,
      added: 1,
      modified: 1,
      deleted: 1,
      total: 4,
      files: [
        { id: 1, path: 'a.md', action: 'added', bytes: 10, linesAdded: 3, linesRemoved: 0 },
        { id: 2, path: 'b.md', action: 'modified', bytes: 5, linesAdded: 1, linesRemoved: 2 },
        { id: 3, path: 'c.png', action: 'deleted', bytes: 99, linesAdded: null, linesRemoved: null },
        { id: 4, path: 'bad', action: 'renamed' },
        { path: 'no-id.md', action: 'added' },
      ],
    });
    assert.equal(changes.total, 4);
    assert.deepEqual(
      changes.files.map((file) => [file.id, file.action, file.linesAdded]),
      [
        [1, 'added', 3],
        [2, 'modified', 1],
        [3, 'deleted', null],
      ],
    );
    assert.deepEqual(files.changeLineTotals(changes), { added: 4, removed: 2 });
    assert.equal(
      files.changeLineTotals({ ...changes, files: changes.files.filter((file) => file.id === 3) }),
      null,
    );
  });
  check('file tree groups directories first with counts, sizes and collapse state', () => {
    const tree = files.buildFileTree([
      { path: 'z.txt', bytes: 1 },
      { path: 'out/file10.csv', bytes: 10 },
      { path: 'out/file2.csv', bytes: 20 },
      { path: 'out/deep/x.md', bytes: 5 },
      { path: 'a.md', bytes: 2 },
    ]);
    assert.equal(tree.files, 5);
    assert.deepEqual(
      tree.children.map((node) => [node.type, node.name]),
      [
        ['dir', 'out'],
        ['file', 'a.md'],
        ['file', 'z.txt'],
      ],
    );
    const out = tree.children[0];
    assert.equal(out.files, 3);
    assert.equal(out.bytes, 35);
    // 目录在前，文件名按数字自然排序
    assert.deepEqual(
      out.children.map((node) => node.name),
      ['deep', 'file2.csv', 'file10.csv'],
    );
    const rows = files.treeRows(tree, new Set());
    assert.deepEqual(
      rows.map((row) => [row.type, row.depth, row.type === 'dir' ? row.node.path : row.file.path]),
      [
        ['dir', 0, 'out'],
        ['dir', 1, 'out/deep'],
        ['file', 2, 'out/deep/x.md'],
        ['file', 1, 'out/file2.csv'],
        ['file', 1, 'out/file10.csv'],
        ['file', 0, 'a.md'],
        ['file', 0, 'z.txt'],
      ],
    );
    assert.deepEqual(
      files.treeRows(tree, new Set(['out'])).map((row) => (row.type === 'dir' ? row.open : row.file.path)),
      [false, 'a.md', 'z.txt'],
    );
    assert.equal(files.defaultCollapsed(tree).size, 0);
    assert.deepEqual([...files.defaultCollapsed(tree, 2)], ['out/deep']);
  });
  check('unified diffs carry line kinds and old/new line numbers', () => {
    const lines = files.parseUnifiedDiff(
      [
        '--- a/r.md',
        '+++ b/r.md',
        '@@ -1,3 +1,3 @@',
        ' keep',
        '-old',
        '--- not a header',
        '+new',
        ' tail',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text]),
      [
        ['meta', null, null, '--- a/r.md'],
        ['meta', null, null, '+++ b/r.md'],
        ['hunk', null, null, '@@ -1,3 +1,3 @@'],
        ['context', 1, 1, 'keep'],
        ['remove', 2, null, 'old'],
        ['remove', 3, null, '-- not a header'],
        ['add', null, 2, 'new'],
        ['context', 4, 3, 'tail'],
      ],
    );
    assert.deepEqual(files.parseUnifiedDiff(''), []);
  });
} finally {
  await vite.close();
}
console.log(JSON.stringify({ result: 'passed', checks: checks.length }));
