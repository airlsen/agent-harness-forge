<script setup lang="ts">
/**
 * 分块 Markdown 渲染：普通内容消毒后直出；代码块交给 CodeBlock（Shiki 高亮）；
 * ```mermaid 围栏渲染为图，```vega / ```vega-lite 围栏渲染为数据图表。
 * 流式中块的 key 稳定，只有正在增长的最后一个块会重新渲染。
 */
import { computed } from 'vue';
import { splitMarkdown } from '../utils/markdownBlocks';
import CodeBlock from './CodeBlock.vue';
import MermaidBlock from './MermaidBlock.vue';
import ChartBlock from './ChartBlock.vue';

const props = withDefaults(defineProps<{ text: string; live?: boolean }>(), { live: false });
const blocks = computed(() => splitMarkdown(props.text, { live: props.live }));

const CHART_LANGS = new Set(['vega', 'vega-lite', 'vegalite', 'chart']);
const isChart = (lang: string) => CHART_LANGS.has(lang);
</script>

<template>
  <div class="markdown-body">
    <template v-for="block in blocks" :key="block.key">
      <MermaidBlock
        v-if="block.kind === 'code' && block.lang === 'mermaid'"
        :code="block.code"
        :closed="block.closed"
        :live="live"
      />
      <ChartBlock
        v-else-if="block.kind === 'code' && isChart(block.lang)"
        :code="block.code"
        :closed="block.closed"
        :live="live"
      />
      <CodeBlock v-else-if="block.kind === 'code'" :code="block.code" :lang="block.lang" :live="live" />
      <div v-else class="md-html" v-html="block.html"></div>
    </template>
  </div>
</template>
