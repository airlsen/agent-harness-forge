/** 文本对比：逐行增删、行号、词级高亮、未改动行折叠与左右并排对齐。 */
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
  const { diffText, foldRows, splitRows, splitLines } = await vite.ssrLoadModule('/src/utils/textDiff.ts');
  const lines = (count, prefix = '第') => Array.from({ length: count }, (_, i) => `${prefix}${i + 1} 行`);

  // 换行符与末尾换行不算改动
  assert.deepEqual(splitLines('a\r\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.equal(foldRows(diffText('a\nb\n', 'a\r\nb').rows).length, 0);

  // 改一个词：一删一增配对，行号正确，只高亮改动的词
  const before = ['## 开始前确认', '缺哪些就问哪些，发请求前需要先获批。', '结尾'].join('\n');
  const after = ['## 开始前确认', '缺哪些就问哪些，不猜。发请求不需要事先获批。', '结尾'].join('\n');
  const changed = diffText(before, after);
  assert.equal(changed.added, 1);
  assert.equal(changed.removed, 1);
  const remove = changed.rows.find((row) => row.kind === 'remove');
  const add = changed.rows.find((row) => row.kind === 'add');
  assert.equal(remove.oldLine, 2);
  assert.equal(add.newLine, 2);
  assert.equal(remove.segments.map((s) => s.text).join(''), remove.text);
  assert.equal(add.segments.map((s) => s.text).join(''), add.text);
  assert.ok(add.segments.some((s) => s.changed && s.text.includes('不猜')));
  assert.ok(add.segments.some((s) => !s.changed && s.text.includes('缺哪些就问哪些')));
  // 整行都变了：不做词级高亮
  const rewritten = diffText('alpha beta gamma', '完全不同的一句话');
  assert.equal(rewritten.rows.find((row) => row.kind === 'add').segments, undefined);

  // 新增与删除文件
  assert.deepEqual(
    diffText('', 'x\ny').rows.map((row) => [row.kind, row.newLine]),
    [
      ['add', 1],
      ['add', 2],
    ],
  );
  assert.equal(diffText('x\ny', '').removed, 2);

  // 远离改动的未改动行折叠，改动前后各保留 3 行
  const base = lines(40);
  const edited = [...base];
  edited[19] = '改过的第 20 行';
  const blocks = foldRows(diffText(base.join('\n'), edited.join('\n')).rows);
  assert.deepEqual(
    blocks.map((block) => [block.type, block.rows.length]),
    [
      ['fold', 16],
      ['rows', 8],
      ['fold', 17],
    ],
  );
  // 只隔两三行的未改动内容不折叠
  const near = [...base];
  near[0] = '改过的第 1 行';
  near[6] = '改过的第 7 行';
  assert.deepEqual(
    foldRows(diffText(base.join('\n'), near.join('\n')).rows).map((block) => block.type),
    ['rows', 'fold'],
  );

  // 左右并排：两删一增对齐成两行，第二行右侧为空
  const pairs = splitRows(diffText('a\nb\nc\nd', 'a\nB\nd').rows);
  assert.deepEqual(
    pairs.map((pair) => [pair.left?.text ?? null, pair.right?.text ?? null]),
    [
      ['a', 'a'],
      ['b', 'B'],
      ['c', null],
      ['d', 'd'],
    ],
  );

  console.log(JSON.stringify({ result: 'passed', checks: 7 }));
} finally {
  await vite.close();
}
