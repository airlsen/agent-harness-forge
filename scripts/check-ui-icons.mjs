#!/usr/bin/env node
/** Product-owned UI uses SVG icons, never emoji glyphs. User/agent content is not filtered. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u2600-\u27bf\uFE0F\u20E3\u200D]/u;
const emojiLibrary =
  /\b(?:twemoji|emojione|emoji-picker|noto color emoji|apple color emoji|segoe ui emoji)\b/i;
const extensions = new Set(['.vue', '.ts', '.js', '.mjs', '.css', '.html', '.svg', '.json']);

function decode(value) {
  const point = (digits, radix) => {
    const value = Number.parseInt(digits, radix);
    return value <= 0x10ffff ? String.fromCodePoint(value) : '';
  };
  return value
    .replace(/&#x([\da-f]+);?/gi, (_, digits) => point(digits, 16))
    .replace(/&#(\d+);?/g, (_, digits) => point(digits, 10))
    .replace(/\\u\{([\da-f]{1,6})\}/gi, (_, digits) => point(digits, 16))
    .replace(/\\u([\da-f]{4})/gi, (_, digits) => String.fromCharCode(Number.parseInt(digits, 16)))
    .replace(/\\([\da-f]{1,6})(?:\s|(?=[^\da-f]|$))/gi, (_, digits) => point(digits, 16));
}

function findEmoji(value) {
  // Bare copyright/trademark symbols are legal copy, not decorative icons.
  return emoji.exec(decode(value).replace(/[\u00a9\u00ae\u2122](?!\uFE0F)/gu, ''));
}

function filesAt(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesAt(path) : extensions.has(extname(path)) ? [path] : [];
  });
}

// The guard also catches encoded emoji, while leaving normal product copy and SVG alone.
for (const sample of [
  String.fromCodePoint(0x1f4a1),
  String.raw`\u{1f4a1}`,
  String.raw`\ud83d\udca1`,
  '&#x1f4a1;',
  '&#128161;',
  String.raw`\1f4a1 `,
]) {
  assert.ok(findEmoji(sample), 'Encoded emoji must not bypass the UI icon guard');
}
assert.equal(findEmoji('企业场景 <svg><path d="M3 3h7v7H3z" /></svg>'), null);
assert.equal(findEmoji('Copyright \u00a9 Forge'), null);

const files = [
  ...filesAt(join(root, 'frontend/src')),
  join(root, 'frontend/index.html'),
  join(root, 'frontend/package.json'),
  join(root, 'backend/src/api/services/scenario_service.py'),
  join(root, 'backend/src/api/services/settings_service.py'),
];
const failures = [];
for (const path of files) {
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (findEmoji(line) || emojiLibrary.test(line)) failures.push(`${relative(root, path)}:${index + 1}`);
    });
}
const icon = readFileSync(join(root, 'frontend/src/components/base/ForgeIcon.vue'), 'utf8');
assert.match(icon, /<svg[\s>]/);
assert.match(icon, /<path\s/);
assert.doesNotMatch(icon, /<img[\s>]|v-html/);
if (failures.length) {
  console.error('FAIL: product-owned emoji/icon-font decorations found:\n' + failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `PASS: ${files.length} product UI/seed files checked; no emoji icons or emoji libraries. Icons use local SVG paths.`,
  );
}
