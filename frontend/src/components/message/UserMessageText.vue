<script setup lang="ts">
/**
 * 用户消息正文：原样显示（保留换行，不按 Markdown 渲染），工作台与 Skill 编写助手共用。
 * 超过 maxLines 行时默认收起，最后一行渐隐，点击「展开全部」查看全文；未超出时不显示按钮。
 * 气泡样式（背景、字号、行高）由调用方提供，这里只负责收起与展开。
 * 正文用 v-text 输出：pre-wrap 下模板里的缩进空白会显示出来。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from '../base/ForgeIcon.vue';

const props = withDefaults(defineProps<{ text: string; maxLines?: number }>(), { maxLines: 5 });
const root = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);
const expanded = ref(false);
const overflowing = ref(false);
let observer: ResizeObserver | null = null;

/** 收起状态下内容是否超出限定行数；展开时保持按钮可见，以便收起 */
function measure() {
  const el = body.value;
  if (!el || expanded.value) return;
  overflowing.value = el.scrollHeight > el.clientHeight + 1;
}
async function toggle() {
  expanded.value = !expanded.value;
  if (expanded.value) return;
  // 收起长消息后内容高度骤减，把消息拉回视野，避免停在下方不相关的位置
  await nextTick();
  root.value?.scrollIntoView({ block: 'nearest' });
}
onMounted(() => {
  measure();
  // 面板拖宽/变窄时换行数随之变化，重新判断是否需要收起
  if (typeof ResizeObserver !== 'undefined' && body.value) {
    observer = new ResizeObserver(() => measure());
    observer.observe(body.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());
watch(
  () => props.text,
  async () => {
    expanded.value = false;
    await nextTick();
    measure();
  },
);
</script>
<template>
  <div ref="root" class="user-message-content">
    <div
      ref="body"
      :class="['user-message-body', { collapsed: !expanded, faded: !expanded && overflowing }]"
      :style="{ '--user-message-lines': maxLines }"
      v-text="text"
    ></div>
    <button
      v-if="overflowing"
      type="button"
      class="user-message-toggle"
      :aria-expanded="expanded"
      @click="toggle"
    >
      {{ expanded ? '收起' : '展开全部'
      }}<Icon name="arrow-down-s-line" :size="14" :class="{ up: expanded }" />
    </button>
  </div>
</template>
<style scoped>
.user-message-content {
  min-width: 0;
}
.user-message-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* 按行高限定行数：不支持 lh 单位的浏览器回退为常用行高 */
.user-message-body.collapsed {
  max-height: calc(1.9em * var(--user-message-lines));
  max-height: calc(1lh * var(--user-message-lines));
  overflow: hidden;
}
.user-message-body.faded {
  mask-image: linear-gradient(to bottom, black calc(100% - 1.5em), transparent);
}
.user-message-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin: 2px 0 4px;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.85;
  cursor: pointer;
}
.user-message-toggle:hover {
  opacity: 1;
  text-decoration: underline;
}
.user-message-toggle:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
  border-radius: 4px;
}
.user-message-toggle svg {
  transition: transform 0.15s ease;
}
.user-message-toggle svg.up {
  transform: rotate(180deg);
}
</style>
