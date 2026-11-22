<script setup lang="ts">
import Icon from '../base/ForgeIcon.vue';

/** 目录搜索框：antd Input 默认外观（圆角 / 边框 / 聚焦光圈），只定宽度。 */
defineProps<{ placeholder?: string }>();
const value = defineModel<string>('value', { required: true });
</script>

<template>
  <a-input v-model:value="value" class="catalog-search" :placeholder="placeholder" allow-clear>
    <template #prefix><Icon name="search" :size="15" /></template>
  </a-input>
</template>

<style scoped>
.catalog-search {
  width: 240px;
  flex-shrink: 0;
}
.catalog-search :deep(.ant-input) {
  min-height: 0; /* 中和 style.css 全局 :where(input){min-height:41px}，否则输入框被撑高 */
}
.catalog-search :deep(.ant-input-prefix) {
  color: var(--color-text-tertiary);
}
@media (max-width: 700px) {
  .catalog-search {
    width: 100%;
  }
}
</style>
