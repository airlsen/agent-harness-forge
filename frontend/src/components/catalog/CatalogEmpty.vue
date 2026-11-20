<script setup lang="ts">
import Icon from '../ForgeIcon.vue';

/**
 * 目录空态：antd Empty + 品牌浅色图标块；标题、说明走默认插槽外的独立元素，
 * 避免 Empty 自带 <p> 里嵌套标题 / 段落。默认插槽放下一步操作按钮。
 */
defineProps<{ icon: string; title: string; description?: string }>();
</script>

<template>
  <a-empty class="catalog-empty" :description="false">
    <template #image>
      <span class="catalog-empty-symbol"><Icon :name="icon" :size="24" /></span>
    </template>
    <div class="catalog-empty-copy">
      <h2 class="catalog-empty-title">{{ title }}</h2>
      <p v-if="description" class="catalog-empty-description">{{ description }}</p>
    </div>
    <div v-if="$slots.default" class="catalog-empty-actions"><slot /></div>
  </a-empty>
</template>

<style scoped>
.catalog-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* flex 列布局的页面里撑满工具栏下方的剩余高度，空态文案垂直居中；
     非 flex 父级下退化为自然高度，min-height 兜底。 */
  flex: 1 0 auto;
  min-height: 240px;
  margin: 0;
  padding: 40px 24px;
  border: 0;
  background: transparent;
  box-shadow: none;
  text-align: center;
}
.catalog-empty :deep(.ant-empty-image) {
  height: auto;
  margin: 0;
}
.catalog-empty-symbol {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  border-radius: 12px;
  color: var(--color-brand-active);
  background: var(--color-brand-muted);
}
.catalog-empty :deep(.ant-empty-footer) {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  width: 100%;
  margin: 16px 0 0;
}
.catalog-empty-copy {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: 400px;
}
.catalog-empty-title {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 16px;
  font-weight: 600;
  line-height: 24px;
}
.catalog-empty-description {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 22px;
  text-wrap: balance;
  overflow-wrap: anywhere;
}
.catalog-empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
/* icon 插槽里是 ForgeIcon 裸 <svg>，不是 .anticon，antd 不会补图标与文字的间距 */
.catalog-empty-actions :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-shadow: none;
}
@media (max-width: 700px) {
  .catalog-empty {
    padding: 32px 16px;
  }
}
</style>
