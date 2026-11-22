<script lang="ts">
import { MERMAID_CONFIG } from '../../utils/vizTheme';

/** mermaid 懒加载单例与全局渲染序号（模块级，跨组件实例共享，避免临时节点 id 冲突） */
let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
let mermaidRenderSeq = 0;
function getMermaid() {
  if (!mermaidReady)
    mermaidReady = import('mermaid').then((mod) => {
      mod.default.initialize(MERMAID_CONFIG);
      return mod.default;
    });
  return mermaidReady;
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { sanitizeDiagramSvg } from '../../utils/sanitizeSvg';
import CodeBlock from './CodeBlock.vue';
import DialogShell from '../base/DialogShell.vue';
import { useCopy } from '../../utils/useCopy';
import Icon from '../base/ForgeIcon.vue';

const props = withDefaults(defineProps<{ code: string; closed: boolean; live?: boolean }>(), {
  live: false,
});

const { copied, copy } = useCopy();
const svg = ref('');
const error = ref('');
const rendering = ref(false);
const showSource = ref(false);
const fullView = ref(false);
const inlineDiagram = ref<HTMLElement | null>(null);
const viewer = ref<HTMLElement | null>(null);
const inlineHeight = ref(0);
const zoom = ref(1);
const fitWidth = ref(0);
const fitHeight = ref(0);
let resizeObserver: ResizeObserver | null = null;
let seq = 0;

function fitDiagram() {
  if (!viewer.value) return;
  const diagram = viewer.value.querySelector('svg');
  const viewBox = diagram?.viewBox.baseVal;
  if (!viewBox?.width || !viewBox.height) return;
  const width = Math.max(1, viewer.value.clientWidth - 48);
  const height = Math.max(1, viewer.value.clientHeight - 48);
  const scale = Math.min(width / viewBox.width, height / viewBox.height);
  fitWidth.value = viewBox.width * scale;
  fitHeight.value = viewBox.height * scale;
}

async function openFullView() {
  inlineHeight.value = inlineDiagram.value?.getBoundingClientRect().height ?? 0;
  zoom.value = 1;
  fullView.value = true;
  await nextTick();
  if (!fullView.value || !viewer.value) return;
  fitDiagram();
  resizeObserver = new ResizeObserver(fitDiagram);
  resizeObserver.observe(viewer.value);
}

function closeFullView() {
  resizeObserver?.disconnect();
  resizeObserver = null;
  fullView.value = false;
}

async function render() {
  const my = ++seq;
  error.value = '';
  svg.value = '';
  rendering.value = true;
  const id = `mmd-${++mermaidRenderSeq}`;
  try {
    const mermaid = await getMermaid();
    const result = await mermaid.render(id, props.code);
    if (my !== seq) return;
    svg.value = sanitizeDiagramSvg(result.svg);
  } catch {
    // mermaid 渲染失败时会往 body 挂一个临时错误节点，清掉
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
    if (my === seq) error.value = '图表语法有误，已显示源码（可复制后到 mermaid.live 修复）。';
  } finally {
    if (my === seq) rendering.value = false;
  }
}

watch(
  () => [props.code, props.closed],
  () => {
    ++seq;
    closeFullView();
    if (!props.closed) {
      svg.value = '';
      error.value = '';
      rendering.value = false;
      return;
    }
    void render();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++seq;
  resizeObserver?.disconnect();
});
</script>

<template>
  <figure class="code-block diagram-block">
    <figcaption class="code-head">
      <span class="code-lang">Mermaid 图</span>
      <span class="diagram-actions">
        <button v-if="svg && !error" class="code-copy" type="button" @click="openFullView">查看全图</button>
        <button v-if="svg && !error" class="code-copy" type="button" @click="showSource = !showSource">
          {{ showSource ? '查看图形' : '查看源码' }}
        </button>
        <button class="code-copy" type="button" @click="copy(code)">
          <Icon :name="copied ? 'check' : 'copy'" :size="12" />{{ copied ? '已复制' : '复制' }}
        </button>
      </span>
    </figcaption>
    <template v-if="!closed || showSource || error">
      <CodeBlock :code="code" lang="mermaid" :live="live" />
      <p v-if="error" class="diagram-error">{{ error }}</p>
    </template>
    <div
      v-else-if="svg"
      ref="inlineDiagram"
      class="diagram-body"
      :style="{ minHeight: fullView ? `${inlineHeight}px` : undefined }"
    >
      <div v-if="!fullView" v-html="svg"></div>
    </div>
    <p v-else class="diagram-pending">图渲染中…</p>
    <DialogShell
      v-if="fullView"
      variant="modal"
      label="Mermaid 图全图"
      panel-class="mermaid-viewer"
      @close="closeFullView"
    >
      <header class="mermaid-viewer-head">
        <strong>Mermaid 图</strong>
        <div class="mermaid-viewer-actions">
          <button
            type="button"
            :disabled="zoom <= 0.5"
            aria-label="缩小图形"
            @click="zoom = Math.max(0.5, zoom - 0.25)"
          >
            −
          </button>
          <button type="button" title="适应屏幕" @click="zoom = 1">{{ Math.round(zoom * 100) }}%</button>
          <button
            type="button"
            :disabled="zoom >= 4"
            aria-label="放大图形"
            @click="zoom = Math.min(4, zoom + 0.25)"
          >
            +
          </button>
          <button type="button" aria-label="关闭全图" @click="closeFullView">
            <Icon name="close" :size="18" />
          </button>
        </div>
      </header>
      <div ref="viewer" class="mermaid-viewer-canvas" tabindex="0" aria-label="图形画布，可滚动查看">
        <div
          class="mermaid-viewer-graphic"
          :style="{ width: `${fitWidth * zoom}px`, height: `${fitHeight * zoom}px` }"
          v-html="svg"
        ></div>
      </div>
    </DialogShell>
  </figure>
</template>

<style>
.modal.mermaid-viewer {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100dvh;
  max-width: none;
  max-height: none;
  border-radius: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--color-text-primary);
}
.mermaid-viewer-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 56px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-default);
}
.mermaid-viewer-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.mermaid-viewer-actions button {
  min-width: 36px;
  height: 36px;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--color-text-secondary);
  background: transparent;
  cursor: pointer;
}
.mermaid-viewer-actions button:hover:not(:disabled) {
  color: var(--color-text-primary);
  background: var(--surface-hover);
}
.mermaid-viewer-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mermaid-viewer-canvas {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: auto;
  padding: 24px;
  /* Mermaid uses a fixed light palette; a white canvas keeps its text legible in dark mode. */
  background: var(--neutral-0);
}
.mermaid-viewer-graphic {
  flex: none;
  margin: auto;
}
.mermaid-viewer-graphic svg {
  display: block;
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
}
</style>
