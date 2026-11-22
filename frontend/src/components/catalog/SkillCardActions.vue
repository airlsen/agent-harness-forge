<script setup lang="ts">
import type { MenuInfo } from 'ant-design-vue/es/menu/src/interface';
import Icon from '../ForgeIcon.vue';

defineProps<{
  name: string;
  downloading?: boolean;
  disabled?: boolean;
  canDelete?: boolean;
}>();

const emit = defineEmits<{
  download: [];
  delete: [];
}>();

function onMenuClick(info: MenuInfo) {
  if (info.key === 'download') emit('download');
  if (info.key === 'delete') emit('delete');
}
</script>

<template>
  <div class="skill-card-actions">
    <slot />
    <a-dropdown :trigger="['click']" placement="bottomRight">
      <a-button
        type="text"
        size="small"
        :aria-label="`更多操作：${name}`"
        title="更多操作"
        :disabled="disabled"
        :loading="downloading"
      >
        <template #icon><Icon v-if="!downloading" name="more" :size="16" /></template>
      </a-button>
      <template #overlay>
        <a-menu @click="onMenuClick">
          <a-menu-item key="download" :disabled="downloading">
            <Icon name="download" :size="15" />下载 ZIP
          </a-menu-item>
          <a-menu-divider v-if="canDelete" />
          <a-menu-item v-if="canDelete" key="delete" danger>删除草稿</a-menu-item>
        </a-menu>
      </template>
    </a-dropdown>
  </div>
</template>

<style scoped>
.skill-card-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
/* 按钮尺寸、图标与间距沿用 CatalogCard 底栏的统一规范，这里不再单独设置 */
.ant-dropdown-menu-item svg {
  margin-right: 8px;
  vertical-align: -2px;
}
</style>
