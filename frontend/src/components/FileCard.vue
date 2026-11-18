<script setup lang="ts">
import { computed } from 'vue';
import Icon from './ForgeIcon.vue';
import { formatBytes } from '../utils/presentation';
import { KIND_META, fileDir, fileKind, fileName, previewable, type FileRef } from '../utils/files';

/** 会话文件卡片：点击卡片预览（不可预览的类型直接下载），右侧提供下载按钮。 */
const props = withDefaults(defineProps<{ file: FileRef; compact?: boolean; downloading?: boolean }>(), {
  compact: false,
  downloading: false,
});
const emit = defineEmits<{ preview: [file: FileRef]; download: [file: FileRef] }>();
const kind = computed(() => fileKind(props.file.path, props.file.mime));
const meta = computed(() => KIND_META[kind.value]);
const canPreview = computed(() => previewable(props.file));
const detail = computed(() =>
  [fileDir(props.file.path), meta.value.label, props.file.bytes ? formatBytes(props.file.bytes) : '']
    .filter(Boolean)
    .join(' · '),
);
function open() {
  if (canPreview.value) emit('preview', props.file);
  else emit('download', props.file);
}
</script>

<template>
  <div :class="['file-card', `kind-${kind}`, { compact }]">
    <button
      type="button"
      class="file-card-main"
      :title="canPreview ? `预览 ${file.path}` : `下载 ${file.path}`"
      @click="open"
    >
      <span class="file-card-icon"><Icon :name="meta.icon" :size="compact ? 16 : 18" /></span>
      <span class="file-card-text">
        <strong>{{ fileName(file.path) }}</strong>
        <small>{{ detail }}</small>
        <em v-if="file.description && !compact">{{ file.description }}</em>
      </span>
    </button>
    <button
      type="button"
      class="icon-button file-card-download"
      :aria-label="`下载 ${fileName(file.path)}`"
      title="下载"
      :disabled="downloading"
      @click="emit('download', file)"
    >
      <span v-if="downloading" class="loader small"></span><Icon v-else name="download" :size="15" />
    </button>
  </div>
</template>
