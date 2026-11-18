<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import FileCard from './FileCard.vue';
import Icon from './ForgeIcon.vue';
import { formatBytes } from '../utils/presentation';
import { buildFileTree, defaultCollapsed, treeRows, type FileRef } from '../utils/files';

/**
 * 会话文件目录树：目录可折叠、可整体打包下载；文件行沿用文件卡片（预览、下载、删除）。
 * 以扁平行渲染，层级用缩进表达。
 */
const props = withDefaults(
  defineProps<{
    files: FileRef[];
    downloading?: string;
    deleting?: string;
    archiving?: string | null;
    deletable?: boolean;
  }>(),
  { downloading: '', deleting: '', archiving: null, deletable: false },
);
const emit = defineEmits<{
  preview: [file: FileRef];
  download: [file: FileRef];
  delete: [file: FileRef];
  archive: [dir: string];
}>();

const tree = computed(() => buildFileTree(props.files));
const collapsed = ref(new Set<string>());
// 首次出现目录时按规模决定默认折叠；之后保留用户的展开状态，只补充新出现的目录
const known = new Set<string>();
watch(
  tree,
  (root) => {
    const defaults = defaultCollapsed(root);
    const next = new Set(collapsed.value);
    const walk = (dir: typeof root) => {
      for (const node of dir.children)
        if (node.type === 'dir') {
          if (!known.has(node.path)) {
            known.add(node.path);
            if (defaults.has(node.path)) next.add(node.path);
          }
          walk(node);
        }
    };
    walk(root);
    collapsed.value = next;
  },
  { immediate: true },
);
const rows = computed(() => treeRows(tree.value, collapsed.value));
function toggle(path: string) {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}
</script>

<template>
  <ul class="file-tree" role="tree">
    <li
      v-for="row in rows"
      :key="row.type === 'dir' ? `d:${row.node.path}` : `f:${row.file.path}`"
      :class="['file-tree-row', row.type]"
      :style="{ '--depth': row.depth }"
      role="treeitem"
      :aria-level="row.depth + 1"
      :aria-expanded="row.type === 'dir' ? row.open : undefined"
    >
      <div v-if="row.type === 'dir'" class="file-tree-dir">
        <button
          type="button"
          class="file-tree-toggle"
          :title="row.open ? '收起目录' : '展开目录'"
          @click="toggle(row.node.path)"
        >
          <Icon name="chevron" :size="12" :class="['file-tree-chevron', { open: row.open }]" /><Icon
            name="folder"
            :size="15"
          /><strong>{{ row.node.name }}</strong
          ><small>{{ row.node.files }} 个文件 · {{ formatBytes(row.node.bytes) }}</small>
        </button>
        <button
          type="button"
          class="icon-button file-tree-archive"
          :aria-label="`打包下载 ${row.node.path}`"
          title="打包下载此目录"
          :disabled="archiving !== null"
          @click="emit('archive', row.node.path)"
        >
          <span v-if="archiving === row.node.path" class="loader small"></span
          ><Icon v-else name="download" :size="14" />
        </button>
      </div>
      <FileCard
        v-else
        :file="row.file"
        compact
        hide-dir
        :deletable="deletable"
        :downloading="downloading === row.file.path"
        :deleting="deleting === row.file.path"
        @preview="emit('preview', $event)"
        @download="emit('download', $event)"
        @delete="emit('delete', $event)"
      />
    </li>
  </ul>
</template>
