<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ text?: string }>();
const description = ref<HTMLElement | null>(null);
const expanded = ref(false);
const overflowing = ref(false);
let observer: ResizeObserver | undefined;

function measure() {
  const element = description.value;
  if (!element || expanded.value) return;
  overflowing.value = element.scrollHeight > element.clientHeight + 1;
}
watch(
  () => props.text,
  async () => {
    expanded.value = false;
    await nextTick();
    measure();
  },
);
onMounted(() => {
  measure();
  observer = new ResizeObserver(measure);
  if (description.value) observer.observe(description.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="tool-description">
    <p ref="description" :class="{ clamped: !expanded }">{{ text || '暂无说明' }}</p>
    <button v-if="overflowing" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      {{ expanded ? '收起' : '展开' }}
    </button>
  </div>
</template>

<style scoped>
.tool-description p {
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tool-description .clamped {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.tool-description button {
  margin-top: 4px;
  padding: 0;
  color: var(--color-brand);
  font-size: 12px;
  line-height: 1.7;
}
</style>
