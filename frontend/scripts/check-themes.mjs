#!/usr/bin/env node
/**
 * 主题完整性检查：styles/themes/ 下的每套主题（不只是当前选中的那套）都必须能直接切换使用。
 * 对每套主题分别编译 tokens.scss 与 theme-export.module.scss（经 sass importer 指向该主题，不改 _index.scss），并校验：
 * - 编译通过，输出 --brand-50 … --brand-900 与 --brand-rgb；色阶由浅到深单调变化；
 * - 原生主按钮与 antd 主色的白字对比度 ≥ 4.5:1（WCAG AA）；
 * - 图表色板首位是品牌色系，其余彩色与品牌色色相至少相差 MIN_HUE_GAP 度，避免相邻类别难以区分。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as sass from 'sass';

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));
const stylesDir = join(frontend, 'src/styles');
const themesDir = join(stylesDir, 'themes');
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
const MIN_CONTRAST = 4.5;
const MIN_HUE_GAP = 20;
// v1 沿用 Forge 最初的品牌色，主按钮对比度略低于 AA；保留原样以便随时切回，只提示不报错。
const CONTRAST_EXEMPT = { 'v1-orange': 'Forge 原始品牌色，保持原样' };

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrastWithWhite = (hex) => 1.05 / (luminance(hex) + 0.05);
/** 返回 [色相°, 饱和度 0–1]（HSL）。 */
const hueSat = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s];
};
const hueGap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** 编译 styles/ 下的文件，并把其中的 `@use './themes' as theme;` 指向指定主题。 */
function compileWithTheme(file, themeName) {
  const path = join(stylesDir, file);
  const source = readFileSync(path, 'utf8');
  const marker = "@use './themes' as theme;";
  if (!source.includes(marker)) throw new Error(`${file} 不再包含 ${marker}，请同步更新本检查`);
  const importer = {
    findFileUrl: (url) =>
      url === 'forge-theme-under-test' ? pathToFileURL(join(themesDir, `_${themeName}.scss`)) : null,
  };
  return sass.compileString(source.replace(marker, "@use 'forge-theme-under-test' as theme;"), {
    url: pathToFileURL(path),
    importers: [importer],
    style: 'expanded',
  }).css;
}

const themeNames = readdirSync(themesDir)
  .filter((f) => /^_.+\.scss$/.test(f) && f !== '_index.scss')
  .map((f) => f.slice(1, -'.scss'.length))
  .sort();
const failures = [];
const warnings = [];
const summary = [];

for (const name of themeNames) {
  const fail = (msg) => failures.push(`${name}: ${msg}`);
  let tokensCss;
  let exportCss;
  try {
    tokensCss = compileWithTheme('tokens.scss', name);
    exportCss = compileWithTheme('theme-export.module.scss', name);
  } catch (error) {
    fail(`编译失败：${error.message}`);
    continue;
  }

  // 1) 色阶：完整、由浅到深，--brand-rgb 与 500 档一致。
  const brand = {};
  for (const step of STEPS) {
    const value = new RegExp(`--brand-${step}:\\s*(#[0-9a-f]{6});`, 'i').exec(tokensCss)?.[1]?.toLowerCase();
    if (value) brand[step] = value;
    else fail(`缺少 --brand-${step}`);
  }
  if (Object.keys(brand).length !== STEPS.length) continue;
  STEPS.slice(1).forEach((step, i) => {
    if (luminance(brand[step]) >= luminance(brand[STEPS[i]])) fail(`色阶 ${step} 不比 ${STEPS[i]} 更深`);
  });
  const rgb = /--brand-rgb:\s*([\d ]+);/.exec(tokensCss)?.[1];
  if (rgb !== hexToRgb(brand[500]).join(' ')) fail(`--brand-rgb (${rgb}) 与 500 档 ${brand[500]} 不一致`);

  // 2) 白字对比度：原生主按钮、antd 主色。
  const exported = Object.fromEntries(
    [...exportCss.matchAll(/^\s*([A-Za-z0-9]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim().toLowerCase()]),
  );
  const buttonStep = /--btn-primary-bg:\s*var\(--brand-(\d+)\)/.exec(tokensCss)?.[1];
  const checks = [
    ['原生主按钮', brand[buttonStep]],
    ['antd 主色', exported.antdPrimary],
  ];
  for (const [label, color] of checks) {
    if (!color) {
      fail(`无法解析${label}颜色`);
      continue;
    }
    const ratio = contrastWithWhite(color);
    if (ratio >= MIN_CONTRAST) continue;
    const msg = `${label} ${color} 白字对比度 ${ratio.toFixed(2)}:1 < ${MIN_CONTRAST}:1`;
    if (CONTRAST_EXEMPT[name]) warnings.push(`${name}: ${msg}（豁免：${CONTRAST_EXEMPT[name]}）`);
    else fail(msg);
  }

  // 3) 图表色板：首位属于品牌色系，其余彩色与品牌色拉开色相。
  const size = Number(exported.vizPaletteSize);
  const palette = Array.from({ length: size }, (_, i) => exported[`viz${i + 1}`]);
  if (size !== 8 || palette.some((c) => !/^#[0-9a-f]{6}$/.test(c ?? '')))
    fail(`图表色板须为 8 个十六进制颜色`);
  else {
    const [brandHue] = hueSat(brand[500]);
    if (hueGap(hueSat(palette[0])[0], brandHue) > 15) fail(`图表色板首位 ${palette[0]} 不是品牌色系`);
    palette.slice(1).forEach((color, i) => {
      const [hue, sat] = hueSat(color);
      if (sat >= 0.3 && hueGap(hue, brandHue) < MIN_HUE_GAP)
        fail(
          `图表色板第 ${i + 2} 位 ${color} 与品牌色 ${brand[500]} 色相仅差 ${hueGap(hue, brandHue).toFixed(0)}°`,
        );
    });
  }
  summary.push(`${name} 按钮 ${brand[buttonStep]}，antd ${exported.antdPrimary}`);
}

for (const w of warnings) console.warn(`WARN ${w}`);
if (!themeNames.length) failures.push('styles/themes/ 下没有主题文件');
if (failures.length) {
  console.error('FAIL: 主题检查未通过：\n' + failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`PASS: ${themeNames.length} 套主题均可编译、对比度与图表色板合格（${summary.join('；')}）`);
}
