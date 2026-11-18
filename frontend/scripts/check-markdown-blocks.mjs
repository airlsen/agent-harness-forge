#!/usr/bin/env node
/** splitMarkdown 分块逻辑单元检查：纯函数、无网络。正文合并为 html 块，围栏代码单独成块。 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// DOMPurify 依赖浏览器 DOM：在加载被测模块前挂上 jsdom 的 window。
globalThis.window = new JSDOM('').window;

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/*'] } },
});
const checks = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS', name);
};
const FENCE = '```';
try {
  const { splitMarkdown, fenceClosed } = await vite.ssrLoadModule('/src/utils/markdownBlocks.ts');

  await check('正文与代码块按出现顺序拆分', () => {
    const md = `# 标题\n\n说明\n\n${FENCE}TS\nconst a = 1;\n${FENCE}\n\n结尾`;
    const blocks = splitMarkdown(md);
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['html', 'code', 'html'],
    );
    assert.match(blocks[0].html, /<h1>标题<\/h1>/);
    assert.equal(blocks[1].lang, 'ts');
    assert.equal(blocks[1].code, 'const a = 1;');
    assert.equal(blocks[1].closed, true);
    assert.match(blocks[2].html, /结尾/);
  });

  await check('mermaid / vega 围栏保留语言名，交由对应组件渲染', () => {
    const md = `${FENCE}mermaid\ngraph TD; A-->B\n${FENCE}\n\n${FENCE}vega\n{"mark":"bar"}\n${FENCE}`;
    const langs = splitMarkdown(md).map((b) => b.lang);
    assert.deepEqual(langs, ['mermaid', 'vega']);
  });

  await check('流式中未闭合的围栏标记为 closed=false', () => {
    const blocks = splitMarkdown(`前文\n\n${FENCE}python\nprint(1)`);
    assert.equal(blocks.at(-1).kind, 'code');
    assert.equal(blocks.at(-1).closed, false);
    assert.equal(fenceClosed(`${FENCE}js\na\n${FENCE}`), true);
    assert.equal(fenceClosed('````md\n```\ninner'), false);
    assert.equal(fenceClosed('````md\n```\ninner\n````'), true);
  });

  await check('文本尾部增长时已有块的 key 与内容保持稳定', () => {
    const base = `段落\n\n${FENCE}js\nx()\n${FENCE}\n\n后续`;
    const before = splitMarkdown(base);
    const after = splitMarkdown(`${base}继续输出`);
    assert.deepEqual(
      before.map((b) => b.key),
      after.map((b) => b.key),
    );
    assert.deepEqual(before.slice(0, 2), after.slice(0, 2));
  });

  await check('空文本不产生块', () => {
    assert.deepEqual(splitMarkdown(''), []);
    assert.deepEqual(splitMarkdown(undefined), []);
  });

  await check('html 块经过消毒：去掉脚本、事件属性与内联样式', () => {
    const md =
      '<script>alert(1)</script>\n\n<p onclick="x()" style="color:red">hi</p>\n\n<iframe src="x"></iframe>';
    const html = splitMarkdown(md)
      .map((b) => b.html ?? '')
      .join('');
    assert.doesNotMatch(html, /<script|onclick|style=|<iframe/i);
    assert.match(html, /hi/);
  });

  const { normalizeLang, highlightCode } = await vite.ssrLoadModule('/src/utils/highlight.ts');

  await check('语言别名归一化，白名单外的语言走纯文本', () => {
    assert.equal(normalizeLang('TS'), 'typescript');
    assert.equal(normalizeLang('py'), 'python');
    assert.equal(normalizeLang('sh'), 'bash');
    assert.equal(normalizeLang('json'), 'json');
    assert.equal(normalizeLang('brainfuck'), '');
    assert.equal(normalizeLang(''), '');
  });

  await check('Shiki 按需加载语言并输出带配色的高亮 HTML', async () => {
    const html = await highlightCode('const a = 1;', 'ts');
    assert.match(html, /<pre[^>]*class="shiki/);
    assert.match(html, /style="[^"]*color/);
    // 深色主题：tokyo-night 关键字紫色，注释已提亮
    assert.match(html, /color:#BB9AF7/i);
    const comment = await highlightCode('// note', 'js');
    assert.match(comment, /color:#7580A8/i);
    const plain = await highlightCode('<b>x</b>', 'unknown-lang');
    assert.doesNotMatch(plain, /<b>/);
  });

  const { sanitizeDiagramSvg } = await vite.ssrLoadModule('/src/utils/sanitizeSvg.ts');

  await check('Mermaid SVG 消毒保留 foreignObject 节点文字，移除脚本与事件属性', () => {
    const svg =
      '<svg id="m" xmlns="http://www.w3.org/2000/svg"><style>#m p{margin:0}</style><g class="node"><rect/>' +
      '<foreignObject width="80" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="line-height:1.5">' +
      '<span class="nodeLabel"><p>开始</p></span><img src="x" onerror="alert(1)"/><script>alert(2)</script>' +
      '</div></foreignObject></g><a href="javascript:alert(3)"><text onclick="alert(4)">65%</text></a></svg>';
    const clean = sanitizeDiagramSvg(svg);
    assert.match(clean, /<foreignObject[^>]*>.*<p>开始<\/p>/s);
    assert.match(clean, /<style>/);
    assert.match(clean, /65%/);
    assert.doesNotMatch(clean, /<script|onerror|onclick|javascript:|<img/i);
  });

  const { MERMAID_CONFIG, VEGA_CONFIG, VIZ_PALETTE } = await vite.ssrLoadModule('/src/utils/vizTheme.ts');

  await check('图与图表共用品牌色板，Mermaid 使用可自定义的 base 主题', () => {
    assert.equal(MERMAID_CONFIG.theme, 'base');
    assert.equal(MERMAID_CONFIG.securityLevel, 'strict');
    const vars = MERMAID_CONFIG.themeVariables;
    VIZ_PALETTE.forEach((color, i) => assert.equal(vars[`pie${i + 1}`], color));
    // base 主题只认十六进制颜色
    for (const [key, value] of Object.entries(vars))
      if (/color|bkg|border|^pie\d/i.test(key) && key !== 'useGradient')
        assert.match(value, /^#[0-9a-f]{6}$/i, key);
    assert.deepEqual(VEGA_CONFIG.range.category, VIZ_PALETTE);
  });

  console.log(`\n${checks.length} checks passed`);
} finally {
  await vite.close();
}
