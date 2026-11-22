<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { diffText, foldRows, splitRows, type DiffBlock, type DiffRow } from '../../utils/textDiff';

/**
 * 两段文本的对比（与工作台「本轮改动」同一套红绿样式）：
 * 合并视图上下对照，左右视图并排；行内只高亮改动的词，远离改动的未改动行折叠，可逐块展开。
 */
const props = withDefaults(defineProps<{ before: string; after: string; mode?: 'unified' | 'split' }>(), {
  mode: 'unified',
});

const result = computed(() => diffText(props.before, props.after));
const blocks = computed(() => foldRows(result.value.rows));
const expanded = ref(new Set<DiffBlock>());
watch(blocks, () => (expanded.value = new Set()));
const visible = computed(() =>
  blocks.value.map((block) => ({
    block,
    open: block.type === 'rows' || expanded.value.has(block),
    split: splitRows(block.rows),
  })),
);
function expand(block: DiffBlock) {
  expanded.value = new Set([...expanded.value, block]);
}
const sign = (row: DiffRow | null) => (row?.kind === 'add' ? '+' : row?.kind === 'remove' ? '−' : '');
/** 左右视图中一侧单元格的底色：同一行左右可能一删一增 */
const side = (row: DiffRow | null) => (row ? `diff-side-${row.kind}` : 'diff-side-empty');
</script>

<template>
  <div v-if="!blocks.length" class="text-diff-empty">内容没有变化。</div>
  <table v-else-if="mode === 'unified'" class="diff-table text-diff">
    <tbody v-for="(item, index) in visible" :key="index">
      <tr v-if="!item.open" class="diff-fold">
        <td colspan="4">
          <button type="button" @click="expand(item.block)">
            展开 {{ item.block.rows.length }} 行未改动
          </button>
        </td>
      </tr>
      <template v-else>
        <tr v-for="(row, rowIndex) in item.block.rows" :key="rowIndex" :class="`diff-${row.kind}`">
          <td class="diff-num">{{ row.oldLine ?? '' }}</td>
          <td class="diff-num">{{ row.newLine ?? '' }}</td>
          <td class="diff-sign">{{ sign(row) }}</td>
          <td class="diff-code">
            <template v-if="row.segments"
              ><span
                v-for="(segment, segmentIndex) in row.segments"
                :key="segmentIndex"
                :class="{ 'diff-word': segment.changed }"
                >{{ segment.text }}</span
              ></template
            ><template v-else>{{ row.text }}</template>
          </td>
        </tr>
      </template>
    </tbody>
  </table>
  <table v-else class="diff-table text-diff text-diff-split">
    <colgroup>
      <col class="diff-col-num" />
      <col />
      <col class="diff-col-num" />
      <col />
    </colgroup>
    <tbody v-for="(item, index) in visible" :key="index">
      <tr v-if="!item.open" class="diff-fold">
        <td colspan="4">
          <button type="button" @click="expand(item.block)">
            展开 {{ item.block.rows.length }} 行未改动
          </button>
        </td>
      </tr>
      <template v-else>
        <tr v-for="(pair, rowIndex) in item.split" :key="rowIndex">
          <template v-for="(row, sideIndex) in [pair.left, pair.right]" :key="sideIndex">
            <td :class="['diff-num', side(row)]">{{ (sideIndex ? row?.newLine : row?.oldLine) ?? '' }}</td>
            <td :class="['diff-code', side(row)]">
              <template v-if="row?.segments"
                ><span
                  v-for="(segment, segmentIndex) in row.segments"
                  :key="segmentIndex"
                  :class="{ 'diff-word': segment.changed }"
                  >{{ segment.text }}</span
                ></template
              ><template v-else>{{ row?.text ?? '' }}</template>
            </td>
          </template>
        </tr>
      </template>
    </tbody>
  </table>
</template>
