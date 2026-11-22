<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from '../base/ForgeIcon.vue';
import TextDiff from './TextDiff.vue';
import { CHANGE_LABELS, fileDir, fileName, type ChangeAction } from '../../utils/files';
import { diffText } from '../../utils/textDiff';

/** 一组文件的修改前后对比：左侧文件列表（状态与增删行数），右侧逐行对比，可切换合并 / 左右视图。 */
export interface ReviewFile {
  path: string;
  action: ChangeAction;
  /** 读取修改前后的完整文本；新增文件的修改前、删除文件的修改后为空字符串 */
  load: () => Promise<{ before: string; after: string }>;
}
type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; before: string; after: string; added: number; removed: number };

const props = defineProps<{ files: ReviewFile[] }>();
const mode = defineModel<'unified' | 'split'>('mode', { default: 'unified' });

const selected = ref('');
const loaded = ref<Record<string, Loaded>>({});
let generation = 0;
async function load(file: ReviewFile, current: number) {
  loaded.value = { ...loaded.value, [file.path]: { state: 'loading' } };
  let next: Loaded;
  try {
    const { before, after } = await file.load();
    const { added, removed } = diffText(before, after);
    next = { state: 'ready', before, after, added, removed };
  } catch (error) {
    next = { state: 'error', message: (error as Error).message || '读取文件失败' };
  }
  if (current === generation) loaded.value = { ...loaded.value, [file.path]: next };
}
watch(
  () => props.files,
  (files) => {
    const current = ++generation;
    loaded.value = {};
    selected.value = files[0]?.path ?? '';
    for (const file of files) void load(file, current);
  },
  { immediate: true },
);

const active = computed(() => props.files.find((file) => file.path === selected.value) ?? null);
const activeState = computed(() => (active.value ? loaded.value[active.value.path] : undefined));
const totals = computed(() => {
  let added = 0;
  let removed = 0;
  for (const state of Object.values(loaded.value))
    if (state.state === 'ready') {
      added += state.added;
      removed += state.removed;
    }
  return { added, removed };
});
function counts(path: string) {
  const state = loaded.value[path];
  return state?.state === 'ready' ? state : null;
}
const modeOptions = [
  { label: '合并', value: 'unified' },
  { label: '左右', value: 'split' },
];
</script>

<template>
  <div class="change-review">
    <div class="change-review-bar">
      <span
        >改了 {{ files.length }} 个文件<span class="turn-changes-lines"
          ><b class="add">+{{ totals.added }}</b
          ><b class="remove">−{{ totals.removed }}</b></span
        ></span
      >
      <a-segmented v-model:value="mode" size="small" :options="modeOptions" aria-label="对比方式" />
    </div>
    <div :class="['change-review-body', { single: files.length < 2 }]">
      <ul v-if="files.length > 1" class="change-review-files" aria-label="改动的文件">
        <li v-for="file in files" :key="file.path" :class="`action-${file.action}`">
          <button
            type="button"
            :class="{ active: file.path === selected }"
            :aria-current="file.path === selected ? 'true' : undefined"
            :title="file.path"
            @click="selected = file.path"
          >
            <span class="turn-change-badge">{{ CHANGE_LABELS[file.action] }}</span>
            <span class="change-review-name"
              ><strong>{{ fileName(file.path) }}</strong
              ><small v-if="fileDir(file.path)">{{ fileDir(file.path) }}</small></span
            >
            <span v-if="counts(file.path)" class="turn-changes-lines"
              ><b class="add">+{{ counts(file.path)!.added }}</b
              ><b class="remove">−{{ counts(file.path)!.removed }}</b></span
            >
          </button>
        </li>
      </ul>
      <section v-if="active" class="change-review-diff">
        <header>
          <span :class="`action-${active.action}`"
            ><span class="turn-change-badge">{{ CHANGE_LABELS[active.action] }}</span></span
          ><strong>{{ active.path }}</strong>
        </header>
        <div v-if="!activeState || activeState.state === 'loading'" class="change-review-state" role="status">
          <span class="loader small"></span>正在读取…
        </div>
        <div v-else-if="activeState.state === 'error'" class="change-review-state error" role="alert">
          <Icon name="info" :size="16" />{{ activeState.message }}
          <button type="button" class="button secondary small" @click="load(active, generation)">重试</button>
        </div>
        <TextDiff v-else :before="activeState.before" :after="activeState.after" :mode="mode" />
      </section>
    </div>
  </div>
</template>
