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
  const files = await vite.ssrLoadModule('/src/utils/files.ts');

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
} finally {
  await vite.close();
}
console.log(JSON.stringify({ result: 'passed', checks: checks.length }));
