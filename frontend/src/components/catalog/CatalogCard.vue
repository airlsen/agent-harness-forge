<script setup lang="ts">
import Icon from '../ForgeIcon.vue';

/**
 * 目录卡片：扁平无投影；hover / 键盘聚焦时边框变主题色并上浮 2px。
 * 结构：头部（36px 图标 + 标题 + 状态标签）→ 两行描述 → 标签 → 附加内容 → 底栏按钮（右对齐）。
 * 插槽：
 *   #sub     标题下的一行元信息（多个 <span> 之间自动加「·」）
 *   #tags    描述下方的标签区，放 <a-tag :bordered="false">
 *   default  标签之后的附加内容（如错误提示）
 *   #ops     底栏左侧的次要操作
 *   #footer  底栏右侧的主要操作
 */
defineProps<{
  title: string;
  icon: string;
  /** scene-icon 色调：code / file / chart / book / shield */
  tone?: string;
  description?: string;
  /** 描述为空时的占位文案 */
  placeholder?: string;
  status?: string;
  /** antd Tag color：success / warning / error / processing；不传为中性灰 */
  statusColor?: string;
}>();
</script>

<template>
  <article class="catalog-card">
    <div class="catalog-card-body">
      <header class="catalog-card-head">
        <span :class="['scene-icon', tone]"><Icon :name="icon" :size="20" /></span>
        <div class="catalog-card-heading">
          <h2 :title="title">{{ title }}</h2>
          <p v-if="$slots.sub" class="catalog-card-sub"><slot name="sub" /></p>
        </div>
        <a-tag v-if="status" class="catalog-card-status" :color="statusColor" :bordered="false">{{
          status
        }}</a-tag>
      </header>
      <p class="catalog-card-desc">{{ description || placeholder }}</p>
      <div v-if="$slots.tags" class="catalog-card-tags"><slot name="tags" /></div>
      <div v-if="$slots.default" class="catalog-card-extra"><slot /></div>
    </div>
    <footer v-if="$slots.footer || $slots.ops" class="catalog-card-footer">
      <div v-if="$slots.ops" class="catalog-card-ops"><slot name="ops" /></div>
      <slot name="footer" />
    </footer>
  </article>
</template>

<style scoped>
.catalog-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 16px 16px 0;
  background: var(--surface-card);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: none;
  transition:
    transform 170ms ease,
    border-color 170ms ease;
}
.catalog-card:hover,
.catalog-card:has(:focus-visible) {
  transform: translateY(-2px);
  border-color: var(--color-brand);
  box-shadow: none;
}
/* 正文与底栏之间至少 16px；底栏 margin-top:auto 压到卡片底部，同一行卡片底栏对齐 */
.catalog-card-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding-bottom: 16px;
}
.catalog-card-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.catalog-card-head .scene-icon {
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 8px;
}
.catalog-card-heading {
  flex: 1;
  min-width: 0;
}
.catalog-card-heading h2 {
  margin: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 36px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 有元信息时标题收成两行：标题 + 元信息，整体与 36px 图标同高 */
.catalog-card-heading:has(.catalog-card-sub) h2 {
  line-height: 20px;
}
.catalog-card-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 8px;
  margin: 2px 0 0;
  color: var(--color-text-tertiary);
  font-size: 12px;
  line-height: 16px;
}
.catalog-card-sub > :deep(span + span::before) {
  content: '·';
  margin-right: 8px;
}
.catalog-card-status {
  flex-shrink: 0;
  margin: 7px 0 0;
}
.catalog-card-desc {
  /* 固定两行：描述长短不一时同一行卡片仍等高 */
  display: -webkit-box;
  min-height: calc(13px * 1.7 * 2);
  margin: 12px 0 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.catalog-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.catalog-card-tags :deep(.ant-tag) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  margin: 0;
}
.catalog-card-tags :deep(.ant-tag > span) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.catalog-card-extra {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.catalog-card-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-height: 48px;
  margin-top: auto;
  padding: 8px 0;
}
.catalog-card-ops {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-right: auto;
}
/* icon 插槽里是 ForgeIcon 裸 <svg>，不是 .anticon，antd 不会补图标与文字的间距 */
.catalog-card-footer :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.catalog-card-footer :deep(.ant-btn-text:not(:disabled)) {
  color: var(--color-text-secondary);
}
.catalog-card-footer :deep(.ant-btn-text:not(:disabled):hover) {
  color: var(--color-text-primary);
}
@media (prefers-reduced-motion: reduce) {
  .catalog-card {
    transition: none;
  }
  .catalog-card:hover,
  .catalog-card:has(:focus-visible) {
    transform: none;
  }
}
</style>
