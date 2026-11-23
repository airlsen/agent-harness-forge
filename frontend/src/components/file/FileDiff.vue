<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import DialogShell from '../base/DialogShell.vue';
import Icon from '../base/ForgeIcon.vue';
import { api } from '../../api/client';
import { formatBytes } from '../../utils/common/format';
import {
  CHANGE_LABELS,
  changeDiffUrl,
  parseUnifiedDiff,
  type ChangeAction,
  type FileChange,
} from '../../utils/file/files';

/** 单个文件在某一轮的改动对比（unified diff，带新旧行号）；二进制或过大文件只显示大小变化。 */
const props = defineProps<{ sessionId: number; change: FileChange }>();
const emit = defineEmits<{ close: [] }>();

interface DiffView {
  path: string;
  action: ChangeAction;
  linesAdded: number | null;
  linesRemoved: number | null;
  beforeBytes: number;
  afterBytes: number;
  binary: boolean;
  truncated: boolean;
  diff: string;
}
const loading = ref(true);
const error = ref('');
const view = ref<DiffView | null>(null);
const lines = computed(() => parseUnifiedDiff(view.value?.diff ?? '').filter((line) => line.kind !== 'meta'));

let alive = true;
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api<DiffView>(changeDiffUrl(props.sessionId, props.change.id));
    if (alive) view.value = data;
  } catch (reason) {
    if (alive) error.value = (reason as Error).message || '读取改动失败';
  } finally {
    if (alive) loading.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  alive = false;
});
</script>

<template>
  <DialogShell
    variant="modal"
    label="文件改动对比"
    panel-class="file-preview rich-file-preview file-diff"
    @close="emit('close')"
  >
    <header>
      <div>
        <h2>{{ change.path }}</h2>
        <p>
          {{ CHANGE_LABELS[change.action] }}
          <template v-if="view && !view.binary && view.linesAdded !== null">
            · <b class="diff-add-count">+{{ view.linesAdded }}</b>
            <b class="diff-remove-count">−{{ view.linesRemoved }}</b></template
          >
          <template v-if="view">
            · {{ formatBytes(view.beforeBytes) }} → {{ formatBytes(view.afterBytes) }}</template
          >
        </p>
      </div>
      <div class="file-preview-tools">
        <button class="icon-button" aria-label="关闭对比" @click="emit('close')">
          <Icon name="close" :size="20" />
        </button>
      </div>
    </header>
    <div class="file-preview-body">
      <div v-if="loading" class="file-preview-state" role="status">
        <span class="loader small"></span>正在读取改动…
      </div>
      <div v-else-if="error" class="file-preview-state error" role="alert">
        <Icon name="info" :size="18" />{{ error }}
        <button class="button secondary small" @click="load">重试</button>
      </div>
      <div v-else-if="view?.binary" class="file-preview-state">
        <Icon name="info" :size="18" />二进制或过大的文件不显示逐行对比。
      </div>
      <div v-else-if="!lines.length" class="file-preview-state">
        <Icon name="info" :size="18" />内容没有文本差异（可能只是空文件或换行符变化）。
      </div>
      <template v-else>
        <table class="diff-table">
          <tbody>
            <tr v-for="(line, index) in lines" :key="index" :class="`diff-${line.kind}`">
              <td class="diff-num">{{ line.oldLine ?? '' }}</td>
              <td class="diff-num">{{ line.newLine ?? '' }}</td>
              <td class="diff-sign">
                {{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : '' }}
              </td>
              <td class="diff-code">{{ line.text }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="view?.truncated" class="file-preview-note">对比内容过长，仅显示前一部分。</p>
      </template>
    </div>
    <footer>
      <button class="button primary" @click="emit('close')">完成</button>
    </footer>
  </DialogShell>
</template>
