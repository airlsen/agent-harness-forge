<script setup lang="ts">
import Icon from './ForgeIcon.vue';

defineProps<{ current: string }>();
</script>

<template>
  <nav class="platform-breadcrumb" aria-label="当前位置">
    <span>平台管理</span><Icon name="chevron" :size="13" /><strong>{{ current }}</strong>
  </nav>
</template>
