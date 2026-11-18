#!/usr/bin/env node
/**
 * wechat-copy — 把任意 HTML 转成可直接粘贴进微信公众号编辑器的页面
 *
 * 原理：公众号编辑器会清洗 <style>、class、外部 CSS，只保留内联 style。
 * 本工具做三件事：
 *   1. 用 juice 把所有 CSS（含 <style> 和外链样式表）内联到每个元素的 style 属性上
 *   2. 清洗公众号会过滤/不支持的标签和属性（script、iframe、on* 事件、危险定位等）
 *   3. 生成一个带「一键复制」按钮的预览页，浏览器打开后点击按钮，
 *      再到公众号后台 Ctrl+V 即可，样式原样保留
 *
 * 用法：
 *   node inline-wechat.js 输入.html [-o 输出.html]
 *
 * 不指定 -o 时，默认输出到 「输入文件名.wechat.html」
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import juice from 'juice';
import * as cheerio from 'cheerio';

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { input: null, output: null, keepClass: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') args.output = argv[++i];
    else if (a === '--keep-class') args.keepClass = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (!a.startsWith('-') && !args.input) args.input = a;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.input) {
  console.log(`用法: node inline-wechat.js <输入.html> [-o 输出.html] [--keep-class]

选项:
  -o, --output   输出文件路径（默认: <输入>.wechat.html）
  --keep-class   保留 class 属性（公众号会忽略，但保留方便调试）
`);
  process.exit(args.help ? 0 : 1);
}

const inputPath = path.resolve(args.input);
const outputPath = path.resolve(
  args.output ?? args.input.replace(/\.html?$/i, '') + '.wechat.html',
);

// ---------- 公众号会过滤的标签/属性 ----------
const DROP_TAGS = [
  'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'option',
  'noscript', 'template', 'audio', 'video', 'source', 'canvas',
];

// 这些 CSS 声明在公众号里无效或会导致整段样式被吞，直接从 style 里剔除
const DROP_CSS_PROPS = new Set([
  'position',        // fixed/absolute/sticky 一律被过滤；relative 布局在粘贴后也常错位，统一去掉更稳
  'top', 'right', 'bottom', 'left', // 脱离 position 后无意义，避免残留
  'z-index',
  'float',
  'clear',
  'cursor',
  'transition',
  'animation',
  'transform',
  'filter',
  'box-shadow',      // 公众号部分版本会吞掉含阴影的整条 style，保守移除
]);

function sanitizeStyle(style) {
  return style
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => {
      const prop = d.split(':')[0].trim().toLowerCase();
      if (DROP_CSS_PROPS.has(prop)) return false;
      if (/var\s*\(/.test(d)) return false;      // CSS 变量不被支持
      if (/expression\s*\(/i.test(d)) return false;
      if (/url\s*\(\s*['"]?\s*javascript:/i.test(d)) return false;
      return true;
    })
    .join('; ');
}

// ---------- 主流程 ----------
const rawHtml = await readFile(inputPath, 'utf8');

// 1) CSS 内联化（juiceResources 会同时处理 <style> 与相对路径的外链 css）
const inlined = await new Promise((resolve, reject) => {
  juice.juiceResources(
    rawHtml,
    {
      removeStyleTags: true,
      preserveMediaQueries: false,
      preserveFontFaces: false,
      preserveImportant: true,
      applyStyleTags: true,
      webResources: { relativeTo: path.dirname(inputPath), images: false },
    },
    (err, html) => (err ? reject(err) : resolve(html)),
  );
});

// 2) 清洗
const $ = cheerio.load(inlined);

// 公众号只保留正文，把 body 里的内容提出来（没有 body 就全量）
const $root = $('body').length ? $('body') : $.root();

$root.find(DROP_TAGS.join(',')).remove();

$root.find('*').each((_, el) => {
  const $el = $(el);
  const attribs = { ...el.attribs };
  for (const name of Object.keys(attribs)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) $el.removeAttr(name);            // 事件属性
    else if (!args.keepClass && lower === 'class') $el.removeAttr(name);
    else if (lower === 'id') $el.removeAttr(name);
    else if (lower === 'srcset' || lower === 'sizes') $el.removeAttr(name);
    else if (lower === 'style') {
      const cleaned = sanitizeStyle(attribs[name]);
      if (cleaned) $el.attr('style', cleaned);
      else $el.removeAttr('style');
    }
  }
});

// 提取清洗后的正文 HTML
const contentHtml = ($('body').length ? $('body').html() : $.root().html() ?? '').trim();

// 统计提示
const imgCount = cheerio.load(contentHtml)('img').length;

// 3) 生成带复制按钮的预览页
const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>公众号排版预览 - ${path.basename(inputPath)}</title>
<style>
  body { margin: 0; background: #f3f4f6; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .toolbar {
    position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 12px;
    padding: 12px 20px; background: #1f2937; color: #fff; font-size: 14px;
  }
  .toolbar button {
    padding: 8px 20px; font-size: 14px; border: 0; border-radius: 6px;
    background: #07c160; color: #fff; cursor: pointer;
  }
  .toolbar button:hover { background: #06ad56; }
  .toolbar .tip { color: #9ca3af; }
  .phone {
    max-width: 677px; margin: 24px auto; background: #fff;
    padding: 20px 16px; box-shadow: 0 1px 4px rgba(0,0,0,.08);
  }
</style>
</head>
<body>
<div class="toolbar">
  <button id="copyBtn">复制正文</button>
  <span id="status" class="tip">点击复制后，到公众号后台编辑器 Ctrl+V 粘贴（共 ${imgCount} 张图片，粘贴后请检查图片是否正常）</span>
</div>
<div class="phone">
  <div id="wx-content">${contentHtml}</div>
</div>
<script>
const btn = document.getElementById('copyBtn');
const statusEl = document.getElementById('status');

function fallbackCopy() {
  // 兼容方案：选中正文区域后用 execCommand 复制
  const range = document.createRange();
  range.selectNode(document.getElementById('wx-content'));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand('copy');
  sel.removeAllRanges();
  return ok;
}

btn.addEventListener('click', async () => {
  const content = document.getElementById('wx-content');
  const html = content.innerHTML;
  const text = content.innerText;
  try {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
    statusEl.textContent = '✅ 已复制！去公众号后台 Ctrl+V 粘贴';
  } catch (e) {
    if (fallbackCopy()) {
      statusEl.textContent = '✅ 已复制（兼容模式）！去公众号后台 Ctrl+V 粘贴';
    } else {
      statusEl.textContent = '❌ 自动复制失败：请手动框选下方正文区域后 Ctrl+C';
    }
  }
});
</script>
</body>
</html>
`;

await writeFile(outputPath, page, 'utf8');

console.log('✅ 转换完成');
console.log(`   输入: ${inputPath}`);
console.log(`   输出: ${outputPath}`);
console.log(`   正文图片数: ${imgCount}`);
console.log('');
console.log('下一步：用 Chrome/Edge 打开输出文件 → 点击「复制正文」→ 到公众号后台 Ctrl+V');
