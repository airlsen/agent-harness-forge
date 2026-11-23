import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DSH_VERSION: string = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json')), 'utf8'),
).version;
