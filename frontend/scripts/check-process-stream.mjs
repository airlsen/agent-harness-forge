/**
 * 运行中的过程块与「跟随最新」：用真实 Vue 渲染 ProcessBlock，模拟「思考 → 调工具 → 再思考」的流式过程，
 * 确认显示区始终是同一块「当前动态」（不弹出整串调用列表、两步之间不清空、只转一个圈），
 * 以及 useStickToBottom 只在用户往上翻时停止跟随。jsdom 不做像素布局验收。
 */
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
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const temporary = await mkdtemp(join(tmpdir(), 'forge-process-'));
const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'SVGElement',
  'Element',
  'Node',
  'Event',
]) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
// 记录 ResizeObserver 回调，用于模拟「内容高度变化」
const resizeCallbacks = [];
globalThis.ResizeObserver = class {
  constructor(callback) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  disconnect() {}
  unobserve() {}
};
globalThis.MutationObserver = dom.window.MutationObserver;

const checks = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS', name);
};
let app;
try {
  const entry = join(temporary, 'process.cjs');
  await build({
    stdin: {
      contents: `export { default as ProcessBlock } from './src/components/message/ProcessBlock.vue';
export { useStickToBottom } from './src/composables/useStickToBottom';
export { createApp, h, reactive, ref, nextTick, defineComponent } from 'vue';`,
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
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      {
        name: 'process-test-adapter',
        setup(builder) {
          // 与被测逻辑无关的依赖换成最小桩：平台 store 只提供工具名表，Markdown 只输出原文
          builder.onResolve({ filter: /stores\/platform$/ }, () => ({ path: 'platform', namespace: 'stub' }));
          builder.onResolve({ filter: /MarkdownContent\.vue$/ }, () => ({
            path: 'markdown',
            namespace: 'stub',
          }));
          builder.onLoad({ filter: /^platform$/, namespace: 'stub' }, () => ({
            contents: `export const usePlatform = () => ({ tools: [{ name: 'bash', title: '终端命令执行' }, { name: 'read', title: '读取文件' }] });`,
          }));
          builder.onLoad({ filter: /^markdown$/, namespace: 'stub' }, () => ({
            contents: `import { h } from 'vue'; export default { props: ['text', 'live'], setup: (p) => () => h('div', { class: 'md' }, p.text) };`,
            resolveDir: root,
          }));
          builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
            const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
            return {
              contents: compileScript(descriptor, { id: 'process-check', inlineTemplate: true }).content,
              loader: 'ts',
              resolveDir: dirname(path),
            };
          });
        },
      },
    ],
  });
  const { ProcessBlock, useStickToBottom, createApp, h, reactive, ref, nextTick, defineComponent } = require(
    entry,
  );

  const state = reactive({ steps: [], active: true, waiting: false, writing: false });
  app = createApp({ render: () => h(ProcessBlock, { ...state }) });
  app.mount('#app');
  const host = document.querySelector('#app');
  const settle = async () => {
    await nextTick();
    await nextTick();
  };
  const header = () => host.querySelector('.process-label').textContent;
  const live = () => host.querySelector('.process-live');
  const done = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `d${i}`,
      tool: 'read',
      result: 'ok',
      arguments: { path: `f${i}` },
    }));

  await check('思考时：头部「正在思考」，当前动态显示最新思考文字，只转一个圈', async () => {
    state.steps = [{ kind: 'thinking', text: '先看看目录结构', live: true }];
    await settle();
    assert.equal(header(), '正在思考');
    assert.equal(live().querySelector('.process-live-thinking').textContent, '先看看目录结构');
    assert.equal(host.querySelectorAll('.loader').length, 1);
  });

  await check('思考结算、下一个调用还没开始：保留上一条思考，不清空', async () => {
    state.steps = [{ kind: 'thinking', text: '先看看目录结构', live: false }];
    await settle();
    assert.ok(live(), '两步之间显示区不应消失');
    assert.equal(live().querySelector('.process-live-thinking').textContent, '先看看目录结构');
  });

  await check('已调用 12 个工具后再调第 13 个：只显示当前这一个调用，不弹出整串列表', async () => {
    state.steps = [
      { kind: 'thinking', text: '想', live: false },
      {
        kind: 'tools',
        calls: [
          ...done(12),
          { id: 'c13', tool: 'bash', arguments: { command: 'curl https://example.com' }, pending: true },
        ],
      },
    ];
    await settle();
    assert.equal(header(), '正在调用：终端命令执行 · 第 13 个工具');
    assert.equal(host.querySelectorAll('.tool-call-row').length, 0, '运行中不应列出全部调用');
    assert.equal(live().querySelector('.process-live-tool-head strong').textContent, '终端命令执行');
    assert.equal(live().querySelector('.process-live-args').textContent, 'curl https://example.com');
    assert.equal(live().querySelector('.process-live-state').textContent, '正在调用…');
    assert.equal(host.querySelectorAll('.loader').length, 1, '只在头部转一个圈');
  });

  await check('等待确认时头部与当前动态都提示确认', async () => {
    state.waiting = true;
    await settle();
    assert.match(header(), /^等待你的确认：终端命令执行/);
    assert.equal(live().querySelector('.process-live-state').textContent, '等待确认');
    state.waiting = false;
  });

  await check('调用返回后：当前动态保留这个调用并显示结果状态，头部带已调用数', async () => {
    state.steps = [
      { kind: 'thinking', text: '想', live: false },
      {
        kind: 'tools',
        calls: [
          ...done(12),
          { id: 'c13', tool: 'bash', arguments: { command: 'curl' }, result: 'x', isError: true },
        ],
      },
    ];
    await settle();
    assert.equal(header(), '正在思考 · 已调用 13 个工具');
    assert.equal(live().querySelector('.process-live-tool-head strong').textContent, '终端命令执行');
    assert.equal(live().querySelector('.process-live-state').textContent, '失败');
  });

  await check('下一段思考开始：同一块区域换成思考文字；回答流式时头部显示「正在回复」', async () => {
    state.steps = [...state.steps, { kind: 'thinking', text: '换个参数再试', live: true }];
    await settle();
    assert.equal(live().querySelector('.process-live-thinking').textContent, '换个参数再试');
    state.steps = state.steps.map((step) => (step.kind === 'thinking' ? { ...step, live: false } : step));
    state.writing = true;
    await settle();
    assert.equal(header(), '正在回复 · 已调用 13 个工具');
    assert.ok(live(), '回答流式期间过程块高度不变');
  });

  await check('点开头部：运行中也能看完整时间线；结束后收起成一行摘要、不再显示当前动态', async () => {
    host.querySelector('.process-header').click();
    await settle();
    assert.equal(host.querySelectorAll('.tool-call-row').length, 13);
    assert.equal(live(), null);
    host.querySelector('.process-header').click();
    state.active = false;
    state.writing = false;
    await settle();
    assert.equal(live(), null);
    assert.equal(host.querySelectorAll('.loader').length, 0);
    assert.equal(header(), '已思考 · 调用 13 个工具 · 1 个失败');
  });

  app.unmount();
  app = null;

  await check('跟随最新：内容变高/变矮不误判，只有用户往上翻才停止，回到底部恢复', async () => {
    const pane = document.createElement('div');
    let height = 1000;
    let top = 0;
    Object.defineProperty(pane, 'clientHeight', { get: () => 400 });
    Object.defineProperty(pane, 'scrollHeight', { get: () => height });
    Object.defineProperty(pane, 'scrollTop', {
      get: () => top,
      set: (value) => {
        top = Math.max(0, Math.min(value, height - 400));
      },
    });
    let api;
    const Harness = defineComponent({
      setup() {
        api = useStickToBottom(ref(pane));
        return () => null;
      },
    });
    const harness = createApp(Harness);
    harness.mount(document.createElement('div'));
    await nextTick();
    api.jumpToLatest();
    assert.equal(top, 600);
    // 内容一下子变高 500px：观察到尺寸变化即贴底，期间触发的滚动事件不会误判为用户上翻
    height = 1500;
    api.onScroll();
    assert.equal(api.stick.value, true);
    resizeCallbacks.forEach((callback) => callback([]));
    assert.equal(top, 1100);
    // 内容变矮：浏览器把位置夹到底部，仍在跟随
    height = 900;
    top = Math.min(top, height - 400);
    api.onScroll();
    assert.equal(api.stick.value, true);
    // 用户往上翻：停止跟随，内容再变化也不拽回
    top = 100;
    api.onScroll();
    assert.equal(api.stick.value, false);
    height = 1400;
    resizeCallbacks.forEach((callback) => callback([]));
    assert.equal(top, 100);
    // 用户翻回底部附近：恢复跟随
    top = 950;
    api.onScroll();
    assert.equal(api.stick.value, true);
    // 流式输出中只往上拖了一小段（仍在底部附近）：也立即停止跟随，不会被下一帧拽回
    api.jumpToLatest();
    top -= 30;
    api.onScroll();
    assert.equal(api.stick.value, false);
    height += 40;
    resizeCallbacks.forEach((callback) => callback([]));
    assert.equal(top, 970);
    // 滚轮往上：在滚动事件之前就停止跟随
    api.jumpToLatest();
    assert.equal(api.stick.value, true);
    pane.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100 }));
    assert.equal(api.stick.value, false);
    // 往下滚轮不影响；手指往下拉同样停止跟随
    api.jumpToLatest();
    pane.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 100 }));
    assert.equal(api.stick.value, true);
    const touch = (type, clientY) => {
      const event = new window.Event(type);
      event.touches = [{ clientY }];
      pane.dispatchEvent(event);
    };
    touch('touchstart', 200);
    touch('touchmove', 260);
    assert.equal(api.stick.value, false);
    // 内层代码块还能往上滚时，滚轮滚的是代码块，不停止跟随
    api.jumpToLatest();
    const inner = document.createElement('pre');
    inner.style.overflowY = 'auto';
    Object.defineProperty(inner, 'scrollTop', { get: () => 50 });
    Object.defineProperty(inner, 'scrollHeight', { get: () => 300 });
    Object.defineProperty(inner, 'clientHeight', { get: () => 100 });
    pane.appendChild(inner);
    inner.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    assert.equal(api.stick.value, true);
    harness.unmount();
  });

  console.log(JSON.stringify({ result: 'passed', checks: checks.length }));
} finally {
  app?.unmount();
  await rm(temporary, { recursive: true, force: true });
  dom.window.close();
}
