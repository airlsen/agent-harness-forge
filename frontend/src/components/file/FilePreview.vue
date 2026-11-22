<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import DialogShell from '../base/DialogShell.vue';
import Icon from '../base/ForgeIcon.vue';
import Markdown from '../markdown/MarkdownContent.vue';
import MarkdownPreview from '../markdown/MarkdownPreview.vue';
import { apiBlob, saveBlob } from '../../api/client';
import { formatBytes } from '../../utils/presentation';
import {
  HIGHLIGHT_LIMIT,
  KIND_META,
  codeLanguage,
  fenced,
  fileExt,
  fileKind,
  fileName,
  isTextKind,
  parseDelimited,
  rawFileUrl,
  type FileRef,
} from '../../utils/files';

/**
 * 会话文件预览：按原始字节读取后分类型渲染。
 * 模型生成的 HTML 放进无同源权限的 sandbox iframe；SVG 以 <img> 渲染（不会执行其中脚本）。
 */
const props = defineProps<{ sessionId: number; file: FileRef }>();
const emit = defineEmits<{ close: [] }>();

const kind = computed(() => fileKind(props.file.path, props.file.mime));
const loading = ref(true);
const error = ref('');
const blob = ref<Blob | null>(null);
const objectUrl = ref('');
const text = ref('');
const mode = ref<'preview' | 'source'>('preview');
const hasSourceMode = computed(() => ['html', 'markdown', 'table'].includes(kind.value));
const size = computed(() => blob.value?.size ?? props.file.bytes);
const table = computed(() =>
  kind.value === 'table' ? parseDelimited(text.value, fileExt(props.file.path) === 'tsv' ? '\t' : ',') : null,
);
const columns = computed(() => Math.max(0, ...(table.value?.rows ?? []).map((row) => row.length)));
const code = computed(() =>
  kind.value === 'html' ? fenced(text.value, 'html') : fenced(text.value, codeLanguage(props.file.path)),
);
const highlight = computed(() => size.value <= HIGHLIGHT_LIMIT);

let alive = true;
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await apiBlob(rawFileUrl(props.sessionId, props.file.path));
    if (!alive) return;
    blob.value = data;
    if (isTextKind(kind.value)) text.value = await data.text();
    else objectUrl.value = URL.createObjectURL(data);
  } catch (reason) {
    if (alive) error.value = (reason as Error).message || '文件读取失败';
  } finally {
    if (alive) loading.value = false;
  }
}
function download() {
  if (blob.value) saveBlob(blob.value, fileName(props.file.path));
}
onMounted(load);
onBeforeUnmount(() => {
  alive = false;
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
});
</script>

<template>
  <DialogShell
    variant="modal"
    label="文件预览"
    panel-class="file-preview rich-file-preview"
    @close="emit('close')"
  >
    <header>
      <div>
        <h2>{{ fileName(file.path) }}</h2>
        <p>{{ file.path }} · {{ KIND_META[kind].label }} · {{ formatBytes(size) }}</p>
        <p v-if="file.description" class="file-preview-description">{{ file.description }}</p>
      </div>
      <div class="file-preview-tools">
        <div
          v-if="hasSourceMode && !loading && !error"
          class="segmented"
          role="tablist"
          aria-label="显示方式"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="mode === 'preview'"
            :class="{ selected: mode === 'preview' }"
            @click="mode = 'preview'"
          >
            预览</button
          ><button
            type="button"
            role="tab"
            :aria-selected="mode === 'source'"
            :class="{ selected: mode === 'source' }"
            @click="mode = 'source'"
          >
            源码
          </button>
        </div>
        <button class="icon-button" aria-label="关闭预览" @click="emit('close')">
          <Icon name="close" :size="20" />
        </button>
      </div>
    </header>
    <div :class="['file-preview-body', `kind-${kind}`, `mode-${mode}`]">
      <div v-if="loading" class="file-preview-state" role="status">
        <span class="loader small"></span>正在读取文件…
      </div>
      <div v-else-if="error" class="file-preview-state error" role="alert">
        <Icon name="info" :size="18" />{{ error }}
        <button class="button secondary small" @click="load">重试</button>
      </div>
      <template v-else>
        <div v-if="kind === 'image'" class="file-preview-image">
          <img :src="objectUrl" :alt="fileName(file.path)" />
        </div>
        <iframe
          v-else-if="kind === 'pdf'"
          class="file-preview-frame"
          :src="objectUrl"
          :title="file.path"
        ></iframe>
        <audio v-else-if="kind === 'audio'" class="file-preview-media" :src="objectUrl" controls></audio>
        <video v-else-if="kind === 'video'" class="file-preview-media" :src="objectUrl" controls></video>
        <iframe
          v-else-if="kind === 'html' && mode === 'preview'"
          class="file-preview-frame"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          :srcdoc="text"
          :title="file.path"
        ></iframe>
        <div v-else-if="kind === 'markdown' && mode === 'preview'" class="file-preview-markdown">
          <MarkdownPreview :content="text" enable-mermaid show-line-numbers />
        </div>
        <div v-else-if="kind === 'table' && mode === 'preview' && table" class="file-preview-table">
          <table>
            <thead v-if="table.rows.length">
              <tr>
                <th v-for="column in columns" :key="column">{{ table.rows[0][column - 1] ?? '' }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in table.rows.slice(1)" :key="index">
                <td v-for="column in columns" :key="column">{{ row[column - 1] ?? '' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="table.truncated" class="file-preview-note">
            仅预览前 {{ table.rows.length }} 行，完整内容请下载查看。
          </p>
        </div>
        <div v-else-if="(kind === 'code' || kind === 'html') && highlight" class="file-preview-code">
          <Markdown :text="code" />
        </div>
        <pre v-else class="file-preview-text">{{ text }}</pre>
      </template>
    </div>
    <footer>
      <button class="button secondary" :disabled="!blob" @click="download">
        <Icon name="download" :size="16" />下载文件</button
      ><button class="button primary" @click="emit('close')">完成</button>
    </footer>
  </DialogShell>
</template>
