<script setup lang="ts">
import { computed, ref } from 'vue';
import { usePlatform } from '../../stores/platform';
import { toolArgSummary, type ToolCallView } from '../../utils/turns';
import Icon from '../base/ForgeIcon.vue';
import { builtinToolTitle } from '../../utils/files';

// flat：只渲染调用行（无分组标题），用于过程块内的时间线；waiting：进行中的调用正在等待用户确认
const props = defineProps<{ calls: ToolCallView[]; flat?: boolean; waiting?: boolean }>();
const app = usePlatform();
const open = ref(false);
const running = computed(() => props.calls.some((call) => call.pending));
const failures = computed(() => props.calls.filter((call) => !call.pending && call.isError).length);
const grouped = computed(() => props.calls.length > 1);
const current = computed(() => [...props.calls].reverse().find((call: ToolCallView) => call.pending));
const summary = computed(() => {
  if (running.value && current.value)
    return `${toolTitle(current.value.tool)} · ${props.waiting ? '等待你的确认' : '正在调用…'}`;
  if (!grouped.value) return toolTitle(props.calls[0]?.tool ?? '工具');
  const names = [...new Set(props.calls.map((call) => toolTitle(call.tool)))];
  return `${props.calls.length} 次工具调用 · ${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}`;
});
function toolTitle(name: string) {
  return app.tools.find((tool) => tool.name === name)?.title ?? builtinToolTitle(name);
}
function argSummary(value: unknown) {
  return toolArgSummary(value);
}
function formatArgs(value: unknown) {
  try {
    return typeof value === 'string'
      ? JSON.stringify(JSON.parse(value), null, 2)
      : (JSON.stringify(value, null, 2) ?? '—');
  } catch {
    return String(value);
  }
}
</script>
<template>
  <div :class="['tool-group', { open: open || running, running, flat }]">
    <button
      v-if="grouped && !flat"
      class="tool-group-header"
      :aria-expanded="open || running"
      @click="open = !open"
    >
      <span class="tool-status" :class="{ pending: running, error: !running && failures > 0 }"
        ><span v-if="running" class="loader small"></span
        ><Icon v-else :name="failures ? 'info' : 'check'" :size="12"
      /></span>
      <span class="tool-group-title">{{ summary }}</span>
      <Icon name="chevron" :size="12" />
    </button>
    <div v-if="grouped || flat" v-show="flat || open || running" class="tool-group-calls">
      <details v-for="call in calls" :key="call.id" class="tool-call-row" :open="call.pending">
        <summary>
          <span class="tool-status" :class="{ pending: call.pending, error: call.isError }"
            ><span v-if="call.pending" class="loader small"></span
            ><Icon v-else :name="call.isError ? 'info' : 'check'" :size="12"
          /></span>
          <strong>{{ toolTitle(call.tool) }}</strong>
          <span class="tool-arg">{{ argSummary(call.arguments) }}</span>
          <span v-if="call.pending" class="tool-state">{{ waiting ? '等待确认' : '正在调用…' }}</span>
          <Icon v-else name="chevron" :size="12" />
        </summary>
        <div v-if="!call.pending" class="tool-call-details">
          <label>输入参数</label>
          <pre>{{ formatArgs(call.arguments) }}</pre>
          <label>执行结果</label>
          <pre>{{ call.result || '（无输出）' }}</pre>
        </div>
      </details>
    </div>
    <details v-else class="tool-call-row single" :open="running">
      <summary>
        <span class="tool-status" :class="{ pending: running, error: !running && failures > 0 }"
          ><span v-if="running" class="loader small"></span
          ><Icon v-else :name="failures ? 'info' : 'check'" :size="12"
        /></span>
        <strong>{{ summary }}</strong>
        <span class="tool-arg">{{ argSummary(calls[0]?.arguments) }}</span>
        <span v-if="running" class="tool-state">{{ waiting ? '等待确认' : '正在调用…' }}</span>
        <Icon v-else name="chevron" :size="12" />
      </summary>
      <div v-if="!running" class="tool-call-details">
        <label>输入参数</label>
        <pre>{{ formatArgs(calls[0]?.arguments) }}</pre>
        <label>执行结果</label>
        <pre>{{ calls[0]?.result || '（无输出）' }}</pre>
      </div>
    </details>
  </div>
</template>
