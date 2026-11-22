/** 使用真实 Vue / Monaco 验证文件状态与撤销；jsdom 不负责像素布局或 Worker 浏览器验收。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { parse, compileScript } from '@vue/compiler-sfc';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
// 复用 Vite 的转换器，测试构建与应用使用同一套 esbuild。
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const temporary = await mkdtemp(join(tmpdir(), 'forge-monaco-'));
const dom = new JSDOM('<div id="app"></div><div id="second"></div>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
for (const name of [
  'customElements',
  'DOMRect',
  'SVGElement',
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLCanvasElement',
  'Element',
  'Node',
  'MutationObserver',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
]) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
globalThis.self = dom.window;
globalThis.CSS = { escape: (value) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`) };
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
HTMLCanvasElement.prototype.getContext = () => ({
  measureText: (text) => ({ width: text.length * 8 }),
  fillRect() {},
  clearRect() {},
  getImageData() {
    return { data: [] };
  },
  fillText() {},
  setTransform() {},
  scale() {},
});
let app;
let secondApp;
try {
  const entry = join(temporary, 'editor.cjs');
  await build({
    stdin: {
      contents: `export { default as Editor } from './src/components/editor/MonacoEditor.vue'; export { createApp, h, reactive, nextTick } from 'vue'; export * as monaco from 'monaco-editor/editor'; export { minimalTextEdit } from './src/utils/editorTextEdit';`,
      resolveDir: root,
    },
    define: {
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    outfile: entry,
    loader: { '.css': 'empty', '.ttf': 'dataurl' },
    logLevel: 'silent',
    plugins: [
      {
        name: 'vue-and-worker-test-adapter',
        setup(builder) {
          builder.onResolve({ filter: /\?worker$/ }, () => ({ path: 'worker', namespace: 'test-worker' }));
          builder.onLoad({ filter: /.*/, namespace: 'test-worker' }, () => ({
            contents:
              'export default class { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }',
          }));
          builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
            const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
            return {
              contents: compileScript(descriptor, { id: 'editor-check', inlineTemplate: true }).content,
              loader: 'ts',
              resolveDir: dirname(path),
            };
          });
        },
      },
    ],
  });
  const { Editor, createApp, h, reactive, nextTick, monaco, minimalTextEdit } = require(entry);
  for (const [before, after] of [
    ['', '新内容'],
    ['正文', ''],
    ['行一\r\n行二', '行一\r\n新增\r\n行二'],
    ['😀 abc', '😁 abcd'],
    ['相同', '相同'],
  ]) {
    const edit = minimalTextEdit(before, after);
    assert.equal(edit ? before.slice(0, edit.start) + edit.text + before.slice(edit.end) : before, after);
  }
  const original = '# 原标题\n\n' + Array.from({ length: 80 }, (_, i) => `正文 ${i + 1}`).join('\n');
  const state = reactive({ value: original, key: 'SKILL.md', active: true, readOnly: false, loading: false });
  let editor;
  let changes = 0;
  let ready;
  const mounted = new Promise((resolve) => {
    ready = resolve;
  });
  const countBefore = monaco.editor.getModels().length;
  app = createApp({
    render: () =>
      h(Editor, {
        modelValue: state.value,
        modelKey: state.key,
        active: state.active,
        readOnly: state.readOnly,
        loading: state.loading,
        style: { display: state.active ? '' : 'none' },
        'onUpdate:modelValue': (value) => {
          changes++;
          state.value = value;
        },
        onReady: (value) => {
          editor = value;
          ready();
        },
      }),
  });
  app.mount('#app');
  await mounted;
  const main = editor.getModel();
  editor.setPosition({ lineNumber: 40, column: 3 });
  editor.pushUndoStop();
  editor.executeEdits('user', [{ range: new monaco.Range(1, 1, 1, 1), text: '用户修改 ' }]);
  editor.pushUndoStop();
  await nextTick();
  assert.equal(changes, 1);
  const edited = state.value;
  const cursor = editor.getPosition();
  state.active = false;
  await nextTick();
  state.active = true;
  await nextTick();
  await nextTick();
  assert.deepEqual(editor.getPosition(), cursor);
  assert.equal(editor.getModel(), main);
  console.log('PASS 切换预览/源码保留 model、光标和用户编辑');

  const ai = edited.replace('正文 70', 'AI 补充了第 70 条规则');
  state.value = ai;
  await nextTick();
  assert.equal(main.getValue(), ai);
  assert.equal(changes, 1, '外部同步不应再次发出保存事件');
  assert.deepEqual(editor.getPosition(), cursor);
  await main.undo();
  await nextTick();
  assert.equal(state.value, edited);
  await main.undo();
  await nextTick();
  assert.equal(state.value, original, 'AI 修改之前的用户撤销记录仍存在');
  await main.redo();
  await nextTick();
  await main.redo();
  await nextTick();
  assert.equal(state.value, ai);
  console.log('PASS AI 修改可单步撤销/重做，保留此前用户历史且不重复保存');

  editor.setPosition({ lineNumber: 35, column: 2 });
  const mainCursor = editor.getPosition();
  state.key = 'references/example.md';
  state.loading = true;
  state.value = '';
  state.readOnly = true;
  await nextTick();
  assert.equal(main.getValue(), ai, '参考文件加载中的空值不能清空原文件');
  state.value = '# 参考文件';
  state.loading = false;
  await nextTick();
  const reference = editor.getModel();
  assert.notEqual(reference, main);
  assert.equal(editor.getOption(monaco.editor.EditorOption.readOnly), true);
  state.key = 'SKILL.md';
  state.value = ai;
  state.readOnly = false;
  await nextTick();
  assert.equal(editor.getModel(), main);
  assert.deepEqual(editor.getPosition(), mainCursor);
  assert.equal(editor.getOption(monaco.editor.EditorOption.readOnly), false);
  console.log('PASS 异步切换文件隔离内容、只读权限和光标');

  state.active = false;
  await nextTick();
  state.value = ai + '\n隐藏期间 AI 更新';
  await nextTick();
  state.active = true;
  await nextTick();
  await nextTick();
  assert.equal(main.getValue(), state.value);
  assert.deepEqual(editor.getPosition(), mainCursor);
  await main.undo();
  await nextTick();
  assert.equal(state.value, ai);
  console.log('PASS 预览期间收到 AI 更新后仍可恢复源码并撤销');

  let secondEditor;
  let secondReady;
  const secondMounted = new Promise((resolve) => {
    secondReady = resolve;
  });
  secondApp = createApp({
    render: () =>
      h(Editor, {
        modelValue: '独立文档',
        modelKey: 'SKILL.md',
        onReady: (value) => {
          secondEditor = value;
          secondReady();
        },
      }),
  });
  secondApp.mount('#second');
  await secondMounted;
  assert.notEqual(editor.getModel(), secondEditor.getModel());
  app.unmount();
  app = undefined;
  assert.equal(main.isDisposed(), true);
  assert.equal(reference.isDisposed(), true);
  assert.equal(secondEditor.getValue(), '独立文档');
  secondApp.unmount();
  secondApp = undefined;
  assert.equal(monaco.editor.getModels().length, countBefore);
  console.log('PASS 多实例文件隔离及销毁时清理所有 models');
} finally {
  app?.unmount();
  secondApp?.unmount();
  dom.window.close();
  await rm(temporary, { recursive: true, force: true });
}
