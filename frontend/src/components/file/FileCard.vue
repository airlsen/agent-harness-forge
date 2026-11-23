<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../base/ForgeIcon.vue';
import { formatBytes } from '../../utils/common/format';
import { KIND_META, fileDir, fileKind, fileName, previewable, type FileRef } from '../../utils/file/files';

/** 会话文件卡片：点击卡片预览（不可预览的类型直接下载），右侧提供下载（及可选的删除）按钮。 */
const props = withDefaults(
  defineProps<{
    file: FileRef;
    compact?: boolean;
    downloading?: boolean;
    /** 目录树中已由层级表达所在目录，不再重复显示 */
    hideDir?: boolean;
    deletable?: boolean;
    deleting?: boolean;
    /** 文件已被删除或清理：保留卡片作为记录，但不可预览下载 */
    missing?: boolean;
  }>(),
  { compact: false, downloading: false, hideDir: false, deletable: false, deleting: false, missing: false },
);
const emit = defineEmits<{ preview: [file: FileRef]; download: [file: FileRef]; delete: [file: FileRef] }>();
const kind = computed(() => fileKind(props.file.path, props.file.mime));
const meta = computed(() => KIND_META[kind.value]);
const canPreview = computed(() => previewable(props.file));
const detail = computed(() =>
  props.missing
    ? '文件已删除或已过保留期限'
    : [
        props.hideDir ? '' : fileDir(props.file.path),
        meta.value.label,
        props.file.bytes ? formatBytes(props.file.bytes) : '',
      ]
        .filter(Boolean)
        .join(' · '),
);
function open() {
  if (props.missing) return;
  if (canPreview.value) emit('preview', props.file);
  else emit('download', props.file);
}
</script>

<template>
  <div :class="['file-card', `kind-${kind}`, { compact, deletable, missing }]">
    <button
      type="button"
      class="file-card-main"
      :title="missing ? file.path : canPreview ? `预览 ${file.path}` : `下载 ${file.path}`"
      :aria-disabled="missing || undefined"
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
      v-if="!missing"
      type="button"
      class="icon-button file-card-download"
      :aria-label="`下载 ${fileName(file.path)}`"
      title="下载"
      :disabled="downloading"
      @click="emit('download', file)"
    >
      <span v-if="downloading" class="loader small"></span><Icon v-else name="download" :size="15" />
    </button>
    <button
      v-if="deletable"
      type="button"
      class="icon-button file-card-delete"
      :aria-label="`删除 ${fileName(file.path)}`"
      title="删除"
      :disabled="deleting"
      @click="emit('delete', file)"
    >
      <span v-if="deleting" class="loader small"></span><Icon v-else name="trash" :size="15" />
    </button>
  </div>
</template>
