<script setup lang="ts">
import Icon from '../ForgeIcon.vue';

/**
 * 弹窗 / 抽屉内的分组区块：浅灰底、图标 + 粗体标题、细分隔线。
 * 说明文字不进区块正文，放在 #extra（右侧操作）或标题旁的 ⓘ 悬停提示（hint）。
 */
defineProps<{ icon: string; title: string; hint?: string }>();
</script>

<template>
  <section class="panel-section">
    <header class="panel-section-header">
      <h3 class="panel-section-title">
        <Icon :name="icon" :size="15" />{{ title }}
        <a-tooltip v-if="hint" :title="hint">
          <span class="panel-section-hint" tabindex="0" :aria-label="hint"
            ><Icon name="info" :size="14"
          /></span>
        </a-tooltip>
      </h3>
      <div v-if="$slots.extra" class="panel-section-extra"><slot name="extra" /></div>
    </header>
    <div class="panel-section-body"><slot /></div>
  </section>
</template>

<style scoped>
.panel-section {
  padding: 0 16px 16px;
  border-radius: 8px;
  background: var(--surface-subtle-bg);
}
.panel-section + .panel-section {
  margin-top: 12px;
}
.panel-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border-default);
}
.panel-section-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 600;
}
.panel-section-title > :deep(svg:first-child) {
  color: var(--color-text-secondary);
}
.panel-section-hint {
  display: inline-flex;
  color: var(--color-text-tertiary);
  cursor: help;
}
.panel-section-hint:focus-visible {
  border-radius: 4px;
  outline: 2px solid var(--border-focus);
}
.panel-section-extra {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
