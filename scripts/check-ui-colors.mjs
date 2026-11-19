#!/usr/bin/env node
/**
 * Product UI colors reference Forge tokens, not raw hex. Hardcoded hex is only
 * legal in the files that *define* color values: the palette/token SCSS and the
 * data-viz ramp. This guard keeps the token migration from regressing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensions = new Set(['.vue', '.ts', '.js', '.mjs', '.css', '.scss', '.sass']);
// Files that legitimately *define* color values (raw scales, tokens, data-viz ramps).
const allowlist = [/[/\\]styles[/\\]/, /[/\\]utils[/\\]vizTheme\.ts$/, /[/\\]theme[/\\]antd\.ts$/];
// 6-digit (and 3-digit) hex. 8-digit hex (`#RRGGBBAA`) is alpha shadow/overlay,
// an elevation concern rather than a semantic color, so it is intentionally out of scope.
const hex = /#[0-9a-fA-F]{3,6}\b/g;
const white = new Set(['#fff', '#ffffff']);

function filesAt(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesAt(path) : extensions.has(extname(path)) ? [path] : [];
  });
}

const files = filesAt(join(root, 'frontend/src'));
const failures = [];
for (const path of files) {
  const rel = relative(root, path).replaceAll('\\', '/');
  if (allowlist.some((re) => re.test(rel))) continue;
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(hex)) {
        if (white.has(match[0].toLowerCase())) continue;
        failures.push(`${rel}:${index + 1}  ${match[0]}`);
      }
    });
}

if (failures.length) {
  console.error(
    'FAIL: hardcoded hex colors outside the token/palette/viz definitions:\n' + failures.join('\n'),
  );
  process.exitCode = 1;
} else {
  console.log(
    `PASS: ${files.length} UI files checked; no stray hex colors. UI colors reference Forge tokens.`,
  );
}
