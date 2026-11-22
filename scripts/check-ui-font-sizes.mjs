#!/usr/bin/env node
/**
 * Product UI text is never smaller than 12px. Forge type scale:
 *   12px  auxiliary (time, size, count, tags) — the floor
 *   13px  secondary (pane titles, buttons, descriptions)
 *   14px  body, messages and every text input (workbench, chat, Skill assistant)
 *   15px  document reading (SKILL.md preview, published skill)
 *   16px+ headings; phone inputs stay 16px so iOS does not zoom on focus
 * This guard rejects px font sizes below the floor in styles and chart themes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensions = new Set(['.vue', '.ts', '.css', '.scss', '.sass']);
const minimum = 12;
// `font-size: 11px` in CSS, and `fontSize: 11` / `labelFontSize: 11` in chart/editor options.
const patterns = [/font-size:\s*(\d+(?:\.\d+)?)px/g, /[fF]ontSize:\s*['"]?(\d+(?:\.\d+)?)/g];

function filesAt(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesAt(path) : extensions.has(extname(path)) ? [path] : [];
  });
}

const files = filesAt(join(root, 'frontend/src')).filter((path) => !path.endsWith('.d.ts'));
const failures = [];
for (const path of files) {
  const rel = relative(root, path).replaceAll('\\', '/');
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      for (const pattern of patterns) {
        for (const match of line.matchAll(pattern)) {
          if (Number(match[1]) < minimum) failures.push(`${rel}:${index + 1}  ${match[0]}`);
        }
      }
    });
}

if (failures.length) {
  console.error(`FAIL: font sizes below ${minimum}px (use the Forge type scale):\n` + failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`PASS: ${files.length} UI files checked; no text below ${minimum}px.`);
}
