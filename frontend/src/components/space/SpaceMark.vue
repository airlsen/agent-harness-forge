<script setup lang="ts">
import { computed } from 'vue';
import type { SpaceBrief } from '../../types/platform';

/** 空间色块：圆角方块 + 名称首字（纯文字，不含图标）；公共空间为灰色「公」 */
const props = withDefaults(
  defineProps<{ space: Pick<SpaceBrief, 'name' | 'color' | 'isPublic'>; size?: number }>(),
  {
    size: 20,
  },
);
const initial = computed(() => Array.from(props.space.name.trim())[0]?.toUpperCase() ?? '');
</script>
<template>
  <span
    :class="['space-mark', `space-color-${space.color}`]"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.55)}px` }"
    aria-hidden="true"
  >
    {{ initial }}
  </span>
</template>
<style scoped>
.space-mark {
  display: inline-grid;
  flex: none;
  place-items: center;
  border-radius: 5px;
  background: var(--space-gray);
  color: var(--neutral-0);
  font-weight: 600;
  line-height: 1;
}
.space-color-orange {
  background: var(--space-orange);
}
.space-color-blue {
  background: var(--space-blue);
}
.space-color-green {
  background: var(--space-green);
}
.space-color-purple {
  background: var(--space-purple);
}
.space-color-red {
  background: var(--space-red);
}
.space-color-cyan {
  background: var(--space-cyan);
}
.space-color-yellow {
  background: var(--space-yellow);
}
.space-color-pink {
  background: var(--space-pink);
}
</style>
