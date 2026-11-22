<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import CodeBlock from './CodeBlock.vue';
import { useCopy } from '../../utils/useCopy';
import { VEGA_CONFIG } from '../../utils/vizTheme';
import Icon from '../base/ForgeIcon.vue';

const props = withDefaults(defineProps<{ code: string; closed: boolean; live?: boolean }>(), {
  live: false,
});

const { copied, copy } = useCopy();
const container = ref<HTMLElement | null>(null);
const error = ref('');
const ready = ref(false);
let seq = 0;
let view: { finalize: () => void } | null = null;

function release() {
  view?.finalize();
  view = null;
}

async function renderChart() {
  const my = ++seq;
  release();
  error.value = '';
  ready.value = false;
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(props.code);
  } catch {
    error.value = '图表描述不是合法 JSON，已显示源码。';
    return;
  }
  // 模型常省略 $schema：含 mark/encoding 的按 Vega-Lite v6 处理
  if (spec && typeof spec === 'object' && !('$schema' in spec) && ('mark' in spec || 'encoding' in spec))
    spec = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', ...spec };
  try {
    const embed = (await import('vega-embed')).default;
    if (my !== seq) return;
    await nextTick();
    if (my !== seq || !container.value) return;
    container.value.innerHTML = '';
    const result = await embed(container.value, spec, {
      actions: { export: true, source: false, compiled: false, editor: false },
      renderer: 'svg',
      tooltip: true,
      config: VEGA_CONFIG,
    });
    if (my !== seq) {
      result.view.finalize();
      return;
    }
    view = result.view;
    ready.value = true;
  } catch {
    if (my === seq) error.value = '图表规范无法渲染，已显示源码。';
  }
}

watch(
  () => [props.code, props.closed],
  () => {
    ++seq;
    release();
    if (!props.closed) {
      error.value = '';
      ready.value = false;
      return;
    }
    void renderChart();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++seq;
  release();
});
</script>

<template>
  <figure class="code-block chart-block">
    <figcaption class="code-head">
      <span class="code-lang">数据图表</span>
      <button class="code-copy" type="button" @click="copy(code)">
        <Icon :name="copied ? 'check' : 'copy'" :size="12" />{{ copied ? '已复制' : '复制' }}
      </button>
    </figcaption>
    <CodeBlock v-if="!closed" :code="code" lang="json" :live="live" />
    <template v-else-if="error">
      <CodeBlock :code="code" lang="json" />
      <p class="diagram-error">{{ error }}</p>
    </template>
    <template v-else>
      <div ref="container" class="chart-body"></div>
      <p v-if="!ready" class="diagram-pending">图表渲染中…</p>
    </template>
  </figure>
</template>
