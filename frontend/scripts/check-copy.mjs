#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/*'] } },
});
try {
  const { bindFeedbackApi } = await vite.ssrLoadModule('/src/utils/common/feedback.ts');
  const { useCopy } = await vite.ssrLoadModule('/src/composables/useCopy.ts');
  const errors = [];
  bindFeedbackApi({ message: { error: (text) => errors.push(text) }, modal: null });
  globalThis.window = { clearTimeout, setTimeout };
  let text = '';
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (value) => (text = value) } },
  });
  const { copied, copy } = useCopy();
  assert.equal(await copy('内容'), true);
  assert.equal(text, '内容');
  assert.equal(copied.value, true);
  navigator.clipboard.writeText = async () => {
    throw new Error('permission denied');
  };
  assert.equal(await copy('失败的内容'), false);
  assert.equal(copied.value, false);
  assert.match(errors[0], /复制失败/);
  delete navigator.clipboard;
  assert.equal(await copy('无剪贴板'), false);
  assert.equal(errors.length, 2);
  console.log('PASS clipboard success, denied permission and unavailable API report the correct result');
} finally {
  await vite.close();
}
