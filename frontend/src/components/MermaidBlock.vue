<script lang="ts">
/** mermaid 懒加载单例与全局渲染序号（模块级，跨组件实例共享，避免临时节点 id 冲突） */
let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
let mermaidRenderSeq = 0;
function getMermaid() {
  if (!mermaidReady)
    mermaidReady = import('mermaid').then((mod) => {
      mod.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
      return mod.default;
    });
  return mermaidReady;
}
</script>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import DOMPurify from 'dompurify';
import CodeBlock from './CodeBlock.vue';
import { useCopy } from '../utils/useCopy';
import Icon from './ForgeIcon.vue';

const props = withDefaults(defineProps<{ code: string; closed: boolean; live?: boolean }>(), {
  live: false,
});

const { copied, copy } = useCopy();
const svg = ref('');
const error = ref('');
const rendering = ref(false);
const showSource = ref(false);
let seq = 0;

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
    svg.value = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } });
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
onBeforeUnmount(() => ++seq);
</script>

<template>
  <figure class="code-block diagram-block">
    <figcaption class="code-head">
      <span class="code-lang">Mermaid 图</span>
      <span class="diagram-actions">
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
    <div v-else-if="svg" class="diagram-body" v-html="svg"></div>
    <p v-else class="diagram-pending">图渲染中…</p>
  </figure>
</template>
