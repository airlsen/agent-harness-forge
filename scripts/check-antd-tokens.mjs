#!/usr/bin/env node
/**
 * Forge token → antd token bridge consistency guard.
 * theme/antd.ts may only reference colors defined in the Forge palette/tokens, and the
 * five semantic hues must stay pinned to their 500-step scale values.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const palettePath = join(root, 'frontend/src/styles/_palette.scss');
const tokensPath = join(root, 'frontend/src/styles/tokens.scss');
const antdPath = join(root, 'frontend/src/theme/antd.ts');

const paletteSrc = readFileSync(palettePath, 'utf8');
const tokensSrc = readFileSync(tokensPath, 'utf8');
const antdSrc = readFileSync(antdPath, 'utf8');

// 1) Parse the raw SCSS scales into { name: { step: hex } }.
const scales = {};
for (const m of paletteSrc.matchAll(/\$([a-z-]+):\s*\(([\s\S]*?)\);/g)) {
  const entries = {};
  for (const p of m[2].matchAll(/(\d+):\s*(#[0-9a-fA-F]{6})/g)) {
    entries[p[1]] = p[2].toLowerCase();
  }
  scales[m[1]] = entries;
}

// 2) The Forge hex universe = palette + tokens (dark values live in tokens.scss).
const forgeHex = new Set();
for (const src of [paletteSrc, tokensSrc]) {
  for (const m of src.matchAll(/#[0-9a-fA-F]{6}\b/g)) forgeHex.add(m[0].toLowerCase());
}

// 3) Colors referenced by the antd bridge.
const antdHex = [...antdSrc.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase());

const failures = [];
for (const hex of antdHex) {
  if (!forgeHex.has(hex)) {
    failures.push(`${relative(root, antdPath)} references ${hex}, which is not in the Forge palette/tokens.`);
  }
}

// 4) Semantic hues must stay pinned to the 500-step scale.
const semantic = [
  ['colorPrimary', 'brand', '500'],
  ['colorSuccess', 'success', '500'],
  ['colorInfo', 'info', '500'],
  ['colorWarning', 'warning', '500'],
  ['colorError', 'danger', '500'],
];
const antdTokens = {};
for (const m of antdSrc.matchAll(
  /(colorPrimary|colorSuccess|colorInfo|colorWarning|colorError):\s*'(#[0-9a-fA-F]{6})'/g,
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
    `PASS: antd token bridge matches the Forge palette (${antdHex.length} color refs, ${semantic.length} semantic pins).`,
  );
}
