<script setup lang="ts">
import { computed } from 'vue';
import { PUBLIC_SPACE_ID, useSpace } from '../../stores/space';
import SpaceMark from './SpaceMark.vue';

/**
 * 内容所属空间的小标记。
 * 默认只在「当前不在公共空间、而这条内容来自公共空间」时显示「公共」——提示它是全员共享的。
 * always：总是显示所属空间名称（例如「全部空间」视图、审计记录）。
 */
const props = defineProps<{ spaceId?: number | null; always?: boolean }>();
const space = useSpace();
const info = computed(() => space.byId(props.spaceId ?? PUBLIC_SPACE_ID));
const shown = computed(() => {
  if (!info.value) return false;
  if (props.always) return true;
  return info.value.isPublic && !space.inPublic;
});
</script>
<template>
  <span
    v-if="shown && info"
    class="space-tag"
    :title="info.isPublic ? '公共空间：所有空间都能看到和使用' : `所属空间：${info.name}`"
  >
    <SpaceMark :space="info" :size="14" />{{ info.name }}
  </span>
</template>
<style scoped>
.space-tag {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  max-width: 120px;
  height: 20px;
  padding: 0 6px 0 3px;
  overflow: hidden;
  border: 1px solid var(--border-light);
  border-radius: 4px;
  background: var(--surface-subtle-bg);
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  text-overflow: ellipsis;
  vertical-align: middle;
  white-space: nowrap;
}
</style>
