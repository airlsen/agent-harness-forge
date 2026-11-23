/**
 * 由 contracts/session-manifest.schema.json 生成 src/kernel/manifest.generated.ts。
 *
 *   node scripts/gen-manifest-types.mjs          重新生成
 *   node scripts/gen-manifest-types.mjs --check  只检查是否最新（npm test 中运行）
 *
 * Schema 本身由控制面的 Pydantic 模型导出（backend/src/api/core/manifest.py），根目录 `make contracts` 会依次执行两步。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = resolve(ROOT, '../contracts/session-manifest.schema.json');
const OUTPUT = resolve(ROOT, 'src/kernel/manifest.generated.ts');

/** 字段级 title 会被生成成一堆别名类型（type Builtin = string[]）：只保留 $defs 与根上的类型名 */
function stripPropertyTitles(node) {
  if (Array.isArray(node)) return node.forEach(stripPropertyTitles);
  if (!node || typeof node !== 'object') return;
  for (const child of Object.values(node.properties ?? {})) {
    delete child.title;
    stripPropertyTitles(child);
  }
  for (const key of ['$defs', 'items', 'anyOf', 'allOf', 'oneOf', 'additionalProperties']) {
    const value = node[key];
    if (key === '$defs') Object.values(value ?? {}).forEach(stripPropertyTitles);
    else stripPropertyTitles(value);
  }
}

export async function render() {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
  stripPropertyTitles(schema);
  return compile(schema, 'SessionManifest', {
    // 与仓库其余代码同一份格式配置：生成文件也能通过 make lint 的 prettier 检查
    style: JSON.parse(readFileSync(resolve(ROOT, '../.prettierrc.json'), 'utf8')),
    bannerComment:
      '/* 由 contracts/session-manifest.schema.json 生成（runner/scripts/gen-manifest-types.mjs），请勿手改；修改后执行 make contracts */',
    additionalProperties: false,
    unreachableDefinitions: false,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = await render();
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUTPUT, 'utf8');
    if (current !== text) {
      console.error('FAIL src/kernel/manifest.generated.ts 与会话清单 Schema 不一致：请执行 make contracts');
      process.exit(1);
    }
    console.log('PASS manifest types are generated from the current schema');
  } else {
    writeFileSync(OUTPUT, text);
    console.log(`已生成 ${OUTPUT}`);
  }
}
