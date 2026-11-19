<script setup lang="ts" generic="T extends string">
import { computed } from 'vue';

/**
 * 目录分类筛选：antd Segmented。
 * 浅灰底槽 + 白色浮起的选中项；只有选中文字用主题色，数量保持中性灰。
 * 企业场景、技能管理等目录页共用，保证 tab 外观一致。
 */
export type CatalogFilterOption<V extends string = string> = {
  value: V;
  label: string;
  /** 不传则不显示数量（例如数据尚未读取完成） */
  count?: number;
};

const props = defineProps<{ options: CatalogFilterOption<T>[] }>();
const value = defineModel<T>('value', { required: true });

// 不传 label，交给 #label 插槽渲染「名称 + 数量」
const segmentedOptions = computed(() =>
  props.options.map((item) => ({ value: item.value, title: item.label, payload: item })),
);
</script>

<template>
  <a-segmented v-model:value="value" class="catalog-filter" :options="segmentedOptions">
    <template #label="{ payload }">
      <span class="catalog-filter-label">{{ payload.label }}</span><span
        v-if="payload.count !== undefined"
        class="catalog-filter-count"
        >{{ payload.count }}</span
      >
    </template>
  </a-segmented>
</template>

<style scoped>
/* 选中 / 未选中的字重与数量盒子尺寸完全一致，切换时选项宽度不变，只有白色滑块平移。 */
.catalog-filter {
  flex: 0 1 auto;
  max-width: 100%;
  padding: 3px;
  overflow-x: auto;
  color: var(--btn-secondary-fg);
  background: var(--surface-muted);
  border-radius: 999px;
  scrollbar-width: none;
}
.catalog-filter::-webkit-scrollbar {
  display: none;
}
.catalog-filter :deep(.ant-segmented-item),
.catalog-filter :deep(.ant-segmented-thumb) {
  border-radius: 999px;
}
.catalog-filter :deep(.ant-segmented-item) {
  flex: 0 0 auto;
}
/* 未选中项悬停：不铺灰底，只加深文字，保持底槽干净 */
.catalog-filter :deep(.ant-segmented-item::after) {
  display: none;
}
.catalog-filter :deep(.ant-segmented-item:hover:not(.ant-segmented-item-selected)) {
  color: var(--color-text-primary);
}
.catalog-filter :deep(.ant-segmented-item-selected),
.catalog-filter :deep(.ant-segmented-thumb) {
  background: var(--surface-card);
  box-shadow: var(--shadow-sm);
}
.catalog-filter :deep(.ant-segmented-item-selected) {
  color: var(--color-brand);
}
.catalog-filter :deep(.ant-segmented-item-label) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  /* 26px 选项 + 上下 3px 底槽 = 32px，与 antd 默认按钮 / 输入框齐平 */
  min-height: 26px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 500;
  line-height: 26px;
  white-space: nowrap;
}
/* 鼠标点击不出现描边；只在键盘 Tab 聚焦时给出聚焦提示（无障碍需要） */
.catalog-filter :deep(.ant-segmented-item:has(.ant-segmented-item-input:focus-visible)) {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
/* 数量：两种状态共用同一个胶囊盒子，未选中时底色透明，选中时铺浅灰 */
.catalog-filter-count {
  display: inline-grid;
  min-width: 20px;
  height: 18px;
  place-items: center;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--color-text-secondary);
  background: transparent;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  line-height: 1;
  transition: background-color 150ms ease;
}
.catalog-filter :deep(.ant-segmented-item-selected) .catalog-filter-count {
  background: var(--surface-muted);
}
@media (max-width: 700px) {
  .catalog-filter {
    flex: 1 1 100%;
    width: 100%;
  }
}
</style>
