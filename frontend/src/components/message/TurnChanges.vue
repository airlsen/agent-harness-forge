<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../base/ForgeIcon.vue';
import {
  CHANGE_LABELS,
  changeLineTotals,
  fileName,
  fileDir,
  type FileChange,
  type WorkspaceChanges,
} from '../../utils/files';

/** 本轮工作区改动：折叠摘要（新增/修改/删除与行数），展开后逐文件查看对比或打开当前文件。 */
const props = defineProps<{ changes: WorkspaceChanges; existing: Set<string> }>();
const emit = defineEmits<{ diff: [change: FileChange]; open: [path: string] }>();
const totals = computed(() => changeLineTotals(props.changes));
const summary = computed(() =>
  (['added', 'modified', 'deleted'] as const)
    .filter((action) => props.changes[action])
    .map((action) => `${CHANGE_LABELS[action]} ${props.changes[action]}`)
    .join(' · '),
);
const hidden = computed(() => props.changes.total - props.changes.files.length);
</script>

<template>
  <details class="turn-changes">
    <summary>
      <Icon name="folder" :size="13" /><span class="turn-changes-title"
        >改动了 {{ changes.total }} 个文件</span
      ><span class="turn-changes-summary">{{ summary }}</span
      ><span v-if="totals" class="turn-changes-lines"
        ><b class="add">+{{ totals.added }}</b
        ><b class="remove">−{{ totals.removed }}</b></span
      ><Icon name="chevron" :size="12" class="step-chevron" />
    </summary>
    <ul>
      <li v-for="change in changes.files" :key="change.id" :class="`action-${change.action}`">
        <span class="turn-change-badge">{{ CHANGE_LABELS[change.action] }}</span>
        <button
          type="button"
          class="turn-change-path"
          :disabled="!existing.has(change.path)"
          :title="existing.has(change.path) ? `打开 ${change.path}` : '文件已不在工作区'"
          @click="emit('open', change.path)"
        >
          <strong>{{ fileName(change.path) }}</strong><small v-if="fileDir(change.path)">{{
            fileDir(change.path)
          }}</small>
        </button>
        <span v-if="change.linesAdded !== null && change.linesRemoved !== null" class="turn-changes-lines"
          ><b class="add">+{{ change.linesAdded }}</b
          ><b class="remove">−{{ change.linesRemoved }}</b></span
        ><span v-else class="turn-change-binary">二进制</span>
        <button type="button" class="button text small turn-change-diff" @click="emit('diff', change)">
          对比
        </button>
      </li>
      <li v-if="hidden > 0" class="turn-changes-more">另有 {{ hidden }} 个文件的改动未列出</li>
    </ul>
  </details>
</template>
