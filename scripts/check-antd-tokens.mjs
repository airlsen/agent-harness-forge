#!/usr/bin/env node
/**
 * Forge token → antd token bridge consistency guard.
 * - Every theme file in styles/themes/ must define the full theme contract (brand scale, steps, viz colors),
 *   and styles/themes/_index.scss must forward exactly one existing theme.
 * - theme/antd.ts may only reference colors defined in the Forge palette/tokens/themes; the brand color must
 *   come from the active theme (via theme-export.module.scss), never a literal, and the four status hues must
 *   stay pinned to their 500-step scale values.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stylesDir = join(root, 'frontend/src/styles');
const themesDir = join(stylesDir, 'themes');
const palettePath = join(stylesDir, '_palette.scss');
const tokensPath = join(stylesDir, 'tokens.scss');
const antdPath = join(root, 'frontend/src/theme/antd.ts');

const paletteSrc = readFileSync(palettePath, 'utf8');
const tokensSrc = readFileSync(tokensPath, 'utf8');
const antdSrc = readFileSync(antdPath, 'utf8');
const failures = [];

/** Parse SCSS maps with numeric keys into { name: { step: hex } }. */
function parseScales(src) {
  const scales = {};
  for (const m of src.matchAll(/\$([a-z-]+):\s*\(([\s\S]*?)\);/g)) {
    const entries = {};
    for (const p of m[2].matchAll(/(\d+):\s*(#[0-9a-fA-F]{6})/g)) entries[p[1]] = p[2].toLowerCase();
    if (Object.keys(entries).length) scales[m[1]] = entries;
  }
  return scales;
}

// 1) Theme contract: each themes/_<name>.scss defines the same complete set of keys.
const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
const VIZ_KEYS = ['node-bg', 'node-border', 'activation-bg', 'active-task-bg', 'active-task-border'];
const themeFiles = readdirSync(themesDir).filter((f) => /^_.+\.scss$/.test(f) && f !== '_index.scss');
const themes = {};
for (const file of themeFiles) {
  const src = readFileSync(join(themesDir, file), 'utf8');
  const where = relative(root, join(themesDir, file));
  const brand = parseScales(src).brand ?? {};
  const missingSteps = STEPS.filter((s) => !brand[s]);
  if (missingSteps.length) failures.push(`${where}: $brand missing steps ${missingSteps.join(', ')}`);
  const step = (name) => new RegExp(`^\\$${name}:\\s*(\\d+);`, 'm').exec(src)?.[1];
  for (const name of ['button-step', 'antd-step']) {
    const value = step(name);
    if (!value || !brand[value])
      failures.push(`${where}: $${name} must be one of the $brand steps (got ${value})`);
  }
  if (!/^\$name:\s*'[^']+';/m.test(src)) failures.push(`${where}: missing $name`);
  const vizBlock = /\$viz:\s*\(([\s\S]*?)\);/.exec(src)?.[1] ?? '';
  for (const key of VIZ_KEYS) {
    if (!new RegExp(`\\b${key}:\\s*#[0-9a-fA-F]{6}\\b`).test(vizBlock))
      failures.push(`${where}: $viz missing ${key}`);
  }
  const vizPalette = /\$viz-palette:\s*\(([\s\S]*?)\);/.exec(src)?.[1] ?? '';
  const paletteCount = [...vizPalette.matchAll(/#[0-9a-fA-F]{6}\b/g)].length;
  if (paletteCount !== 8)
    failures.push(`${where}: $viz-palette must list 8 hex colors (got ${paletteCount})`);
  themes[file.slice(1, -'.scss'.length)] = { src, brand, antdStep: step('antd-step') };
}

const indexSrc = readFileSync(join(themesDir, '_index.scss'), 'utf8');
const forwards = [...indexSrc.matchAll(/^@forward\s+['"]([\w-]+)['"]/gm)].map((m) => m[1]);
if (forwards.length !== 1)
  failures.push(`styles/themes/_index.scss must @forward exactly one theme (got ${forwards.length})`);
const active = themes[forwards[0]];
if (forwards.length === 1 && !active)
  failures.push(`styles/themes/_index.scss forwards unknown theme '${forwards[0]}'`);
if (/\$brand\s*:/.test(paletteSrc))
  failures.push('_palette.scss must not define $brand; brand scales live in styles/themes/');
if (!existsSync(join(stylesDir, 'theme-export.module.scss')))
  failures.push('missing styles/theme-export.module.scss');

// 2) The Forge hex universe = palette + tokens (dark values) + all theme files.
const forgeHex = new Set();
for (const src of [paletteSrc, tokensSrc, ...Object.values(themes).map((t) => t.src)]) {
  for (const m of src.matchAll(/#[0-9a-fA-F]{6}\b/g)) forgeHex.add(m[0].toLowerCase());
}

// 3) Colors referenced by the antd bridge.
const antdHex = [...antdSrc.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase());
for (const hex of antdHex) {
  if (!forgeHex.has(hex)) {
    failures.push(
      `${relative(root, antdPath)} references ${hex}, which is not in the Forge palette/tokens/themes.`,
    );
  }
}

// 4) Brand comes from the active theme; status hues stay pinned to the 500-step scale.
if (!/colorPrimary:\s*themeColors\.antdPrimary\b/.test(antdSrc)) {
  failures.push(
    'antd colorPrimary must be themeColors.antdPrimary (from styles/theme-export.module.scss), not a literal',
  );
}
const scales = parseScales(paletteSrc);
const semantic = [
  ['colorSuccess', 'success', '500'],
  ['colorInfo', 'info', '500'],
  ['colorWarning', 'warning', '500'],
  ['colorError', 'danger', '500'],
];
const antdTokens = {};
for (const m of antdSrc.matchAll(
  /(colorSuccess|colorInfo|colorWarning|colorError):\s*'(#[0-9a-fA-F]{6})'/g,
)) {
  antdTokens[m[1]] = m[2].toLowerCase();
}
for (const [token, scale, step] of semantic) {
  const expected = scales[scale]?.[step];
  const actual = antdTokens[token];
  if (!expected) failures.push(`missing scale ${scale}.${step} in _palette.scss`);
  else if (actual !== expected)
    failures.push(`antd ${token} = ${actual}, expected ${scale}.${step} = ${expected}`);
}

if (failures.length) {
  console.error('FAIL: antd token bridge drifted from the Forge palette:\n' + failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `PASS: antd token bridge matches the Forge palette (${Object.keys(themes).length} themes, active ${forwards[0]} → ` +
      `colorPrimary ${active.brand[active.antdStep]}; ${antdHex.length} color refs, ${semantic.length} status pins).`,
  );
}
