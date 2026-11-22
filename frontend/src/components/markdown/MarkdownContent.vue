<script setup lang="ts">
/**
 * 分块 Markdown 渲染：普通内容消毒后直出；代码块交给 CodeBlock（Shiki 高亮）；
 * ```mermaid 围栏渲染为图，```vega / ```vega-lite 围栏渲染为数据图表。
 * 流式中块的 key 稳定，只有正在增长的最后一个块会重新渲染。
 */
import { computed } from 'vue';
import { splitMarkdown } from '../../utils/markdownBlocks';
import CodeBlock from './CodeBlock.vue';
import MermaidBlock from './MermaidBlock.vue';
import ChartBlock from './ChartBlock.vue';

const props = withDefaults(
  defineProps<{ text: string; live?: boolean; variant?: 'message' | 'document' }>(),
  {
    live: false,
    variant: 'message',
  },
);
const blocks = computed(() => splitMarkdown(props.text, { live: props.live }));

const CHART_LANGS = new Set(['vega', 'vega-lite', 'vegalite', 'chart']);
const isChart = (lang: string) => CHART_LANGS.has(lang);
</script>

<template>
  <div class="markdown-body" :class="{ 'markdown-document': variant === 'document' }">
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

<style scoped>
/* 文档阅读排版显式启用，不改变聊天消息的密度与颜色。 */
.markdown-document {
  min-width: 0;
  color: var(--color-text-primary);
  font-size: 15px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.markdown-document :deep(h1),
.markdown-document :deep(h2),
.markdown-document :deep(h3),
.markdown-document :deep(h4) {
  color: var(--color-text-primary);
  font-weight: 600;
  line-height: 1.4;
}
.markdown-document :deep(h1) {
  font-size: 24px;
  margin: 0 0 20px;
}
.markdown-document :deep(h2) {
  font-size: 20px;
  margin: 30px 0 12px;
}
.markdown-document :deep(h3) {
  font-size: 17px;
  margin: 24px 0 10px;
}
.markdown-document :deep(h4) {
  font-size: 15px;
  margin: 20px 0 8px;
}
.markdown-document :deep(p) {
  margin: 0 0 14px;
}
.markdown-document :deep(ul),
.markdown-document :deep(ol) {
  padding-left: 24px;
  margin: 0 0 16px;
}
.markdown-document :deep(li) {
  margin: 5px 0;
}
.markdown-document :deep(li > p) {
  margin: 0;
}
.markdown-document :deep(blockquote) {
  margin: 18px 0;
  padding: 10px 16px;
  border-left: 3px solid var(--border-strong);
  color: var(--color-text-secondary);
  background: var(--surface-shell);
}
.markdown-document :deep(blockquote > p:last-child) {
  margin-bottom: 0;
}
.markdown-document :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 20px 0;
  font-size: 14px;
}
.markdown-document :deep(th),
.markdown-document :deep(td) {
  padding: 10px 14px;
  border: 1px solid var(--border-default);
}
.markdown-document :deep(th) {
  background: var(--surface-shell);
  font-weight: 600;
}
.markdown-document :deep(img) {
  max-width: 100%;
  height: auto;
}
.markdown-document :deep(.code-block) {
  min-width: 0;
  max-width: 100%;
  margin: 20px 0;
}
.markdown-document :deep(.code-body) {
  overflow-x: auto;
}
.markdown-document :deep(.code-body pre) {
  font-size: 13px;
  line-height: 1.7;
}
.markdown-document :deep(.md-html > :first-child) {
  margin-top: 0;
}
</style>
