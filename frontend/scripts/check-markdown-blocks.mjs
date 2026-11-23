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
  const { splitMarkdown, fenceClosed } = await vite.ssrLoadModule('/src/utils/markdown/blocks.ts');

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

  // 带引用式链接定义的文档走整组渲染（不缓存）：在末尾追加一条不使用的定义即可得到整组渲染的参照结果。
  const wholeGroup = (md, options) =>
    splitMarkdown(`${md}\n\n[unused-reference]: https://example.com/unused`, options)
      .map((b) => b.html ?? '')
      .join('');
  const htmlOf = (md, options) =>
    splitMarkdown(md, options)
      .map((b) => b.html ?? '')
      .join('');
  const STREAM_DOC = [
    '## 一、概览',
    '',
    '这是**第一段**，含 `行内代码`、[链接](https://example.com/a) 和裸地址 https://example.com/b。',
    '',
    '- 列表一',
    '- 列表二',
    '  - 嵌套项',
    '',
    '> 引用内容',
    '> 第二行',
    '',
    '| 列 | 值 |',
    '| --- | --- |',
    '| a | 1 |',
    '',
    '1. 有序一',
    '2. 有序二',
    '',
    '---',
    '',
    '最后一段~~删除线~~结束。',
  ].join('\n');

  await check('逐段缓存渲染与整组渲染结果一致（完成后与流式中都一致）', () => {
    assert.equal(htmlOf(STREAM_DOC), wholeGroup(STREAM_DOC));
    assert.equal(htmlOf(STREAM_DOC), htmlOf(STREAM_DOC)); // 第二次命中缓存
    for (let end = 1; end <= STREAM_DOC.length; end += 7) {
      const prefix = STREAM_DOC.slice(0, end);
      assert.equal(htmlOf(prefix, { live: true }), wholeGroup(prefix, { live: true }), `前 ${end} 字`);
    }
  });

  await check('原始 HTML 跨段开合时整组渲染，段落仍在标签内', () => {
    const html = htmlOf('<details>\n<summary>展开</summary>\n\n内容段落\n\n</details>');
    assert.match(html, /<details>[\s\S]*<p>内容段落<\/p>[\s\S]*<\/details>/);
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

  await check('裸图片地址自动内嵌，普通网址仍为可点击链接', () => {
    const imageUrl = 'https://mdn.alipayobjects.com/one_clip/afts/img/chart-id/original';
    const html = splitMarkdown(`图表地址：${imageUrl}`)
      .map((b) => b.html ?? '')
      .join('');
    assert.match(
      html,
      /<img[^>]+src="https:\/\/mdn\.alipayobjects\.com\/one_clip\/afts\/img\/chart-id\/original"/,
    );
    assert.match(html, /loading="lazy"/);
    assert.match(html, /decoding="async"/);
    assert.match(html, /referrerpolicy="no-referrer"/);
    assert.match(html, /href="https:\/\/mdn\.alipayobjects\.com/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);

    const link = splitMarkdown('https://example.com/docs')
      .map((b) => b.html ?? '')
      .join('');
    assert.match(link, /<a[^>]+href="https:\/\/example\.com\/docs"/);
    assert.doesNotMatch(link, /<img/i);
  });

  await check('流式输出期间不发起图片请求，完成后再自动加载', () => {
    const imageUrl = 'https://mdn.alipayobjects.com/one_clip/afts/img/chart-id/original';
    const liveHtml = splitMarkdown(imageUrl, { live: true })
      .map((b) => b.html ?? '')
      .join('');
    assert.doesNotMatch(liveHtml, /<img/i);
    assert.match(liveHtml, /<a[^>]+href="https:\/\/mdn\.alipayobjects\.com/);

    const finishedHtml = splitMarkdown(imageUrl)
      .map((b) => b.html ?? '')
      .join('');
    assert.match(finishedHtml, /<img/i);
  });

  await check('Markdown 图片可显示，但只接受 HTTPS 并移除危险/替代资源属性', () => {
    const secure = splitMarkdown('![区域销售额](https://cdn.example.com/chart.png)')
      .map((b) => b.html ?? '')
      .join('');
    assert.match(secure, /<img[^>]+src="https:\/\/cdn\.example\.com\/chart\.png"/);
    assert.match(secure, /alt="区域销售额"/);
    assert.match(secure, /referrerpolicy="no-referrer"/);

    const unsafe = splitMarkdown(
      '<img src="http://cdn.example.com/chart.png" srcset="https://evil.example/track.png 2x" onerror="alert(1)" alt="图表">',
    )
      .map((b) => b.html ?? '')
      .join('');
    assert.doesNotMatch(unsafe, /<img|srcset|onerror|http:\/\/cdn\.example\.com/);
    assert.match(unsafe, /图表/);
  });

  await check('GFM 表格与删除线可渲染（标题后紧跟表格也能识别）', () => {
    const md = [
      '## 二、Dubbo RPC 接口',
      '| # | 接口 | 方法数 |',
      '|---|---|---|',
      '| 1 | `LoginApi` | 77 |',
      '| — | ~~PassportApi~~ | 0 |',
    ].join('\n');
    const html = splitMarkdown(md)
      .map((b) => b.html ?? '')
      .join('');
    assert.match(html, /<h2>二、Dubbo RPC 接口<\/h2>/);
    assert.match(html, /<table>[\s\S]*<th>接口<\/th>[\s\S]*<code>LoginApi<\/code>/);
    assert.match(html, /<del>PassportApi<\/del>/);
    assert.doesNotMatch(html, /\|---/);
  });

  await check('开启 GFM 后裸链接仍由 linkifyText 处理，表格单元格内同样生效', () => {
    const inline = splitMarkdown('文档见 https://example.com/docs。')
      .map((b) => b.html ?? '')
      .join('');
    assert.match(
      inline,
      /<a class="markdown-external-link" href="https:\/\/example\.com\/docs"[^>]*target="_blank"[^>]*>https:\/\/example\.com\/docs<\/a>。/,
    );

    const cell = splitMarkdown('| 链接 | 说明 |\n|---|---|\n| https://example.com/a | 文档 |')
      .map((b) => b.html ?? '')
      .join('');
    assert.match(cell, /<td><a class="markdown-external-link" href="https:\/\/example\.com\/a"/);
  });

  await check('代码围栏中的图片地址仍作为代码，不触发外部图片请求', () => {
    const url = 'https://mdn.alipayobjects.com/one_clip/afts/img/chart-id/original';
    const blocks = splitMarkdown(`${FENCE}text\n${url}\n${FENCE}`);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'code');
    assert.equal(blocks[0].code, url);
  });

  const { normalizeLang, highlightCode } = await vite.ssrLoadModule('/src/utils/markdown/highlight.ts');

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

  const { sanitizeDiagramSvg } = await vite.ssrLoadModule('/src/utils/markdown/sanitizeSvg.ts');

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

  const { MERMAID_CONFIG, VEGA_CONFIG, VIZ_PALETTE } = await vite.ssrLoadModule(
    '/src/utils/markdown/vizTheme.ts',
  );
  const { default: themeColors } = await vite.ssrLoadModule('/src/styles/theme-export.module.scss');

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
    assert.equal(VIZ_PALETTE.length, 8);
    assert.equal(vars.pie9, VIZ_PALETTE[0]); // 超过 8 类时循环取色
    assert.equal(VEGA_CONFIG.mark.color, VIZ_PALETTE[0]); // 单系列默认取色板首位（品牌色）
    assert.match(themeColors.vizNodeBorder, /^#[0-9a-f]{6}$/i); // 色值来自当前主题（styles/themes/）
    assert.equal(vars.primaryBorderColor, themeColors.vizNodeBorder); // 流程图沿用界面主题色
    assert.equal(vars.actorBorder, themeColors.vizNodeBorder);
    assert.equal(vars.xyChart.plotColorPalette, VIZ_PALETTE.join(', ')); // Mermaid 柱状/折线图同色板
  });

  console.log(`\n${checks.length} checks passed`);
} finally {
  await vite.close();
}
