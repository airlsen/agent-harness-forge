<script setup lang="ts">
/**
 * 一轮的执行过程：所有思考、工具调用与中间说明合成一个块。
 * 运行中只显示一个头部（正在思考 / 正在调用某工具）和当前活动；结束后收起成一行摘要，点开查看完整时间线。
 * 运行中的调用明细只在本轮有多个工具调用时显示（含已完成的，可点开）；
 * 单个调用与头部摘要重复，不渲染——一个动作只转一个圈。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { usePlatform } from '../stores/platform';
import { useConversation } from '../stores/conversation';
import { processStats, processSummary, type TurnStep } from '../utils/turns';
import { builtinToolTitle } from '../utils/files';
import Icon from './ForgeIcon.vue';
import Markdown from './MarkdownContent.vue';
import ToolCallGroup from './ToolCallGroup.vue';

const props = defineProps<{ steps: TurnStep[]; active: boolean }>();
const app = usePlatform();
const chat = useConversation();
const open = ref(false);
const current = ref<HTMLElement | null>(null);
const stats = computed(() => processStats(props.steps));
const liveThinking = computed(() => {
  const last = props.steps.at(-1);
  return last?.kind === 'thinking' && last.live ? last.text : '';
});
const allCalls = computed(() => props.steps.flatMap((step) => (step.kind === 'tools' ? step.calls : [])));
/** 运行中是否显示调用明细：本轮有多个工具调用时才显示，单个在跑时留空，圈只留在头部 */
const showLiveCalls = computed(
  () => !liveThinking.value && stats.value.pending.length > 0 && allCalls.value.length > 1,
);
const label = computed(() => {
  if (!props.active) return processSummary(stats.value);
  const call = stats.value.pending.at(-1);
  if (!call) return '正在思考';
  return `${chat.approvals.length ? '等待你的确认' : '正在调用'}：${toolTitle(call.tool)}`;
});
function toolTitle(name: string) {
  return app.tools.find((tool) => tool.name === name)?.title ?? builtinToolTitle(name);
}
// 流式思考保持显示最新内容
watch(liveThinking, async () => {
  await nextTick();
  if (current.value) current.value.scrollTop = current.value.scrollHeight;
});
</script>
<template>
  <section :class="['process-block', { active, open }]">
    <button class="process-header" type="button" :aria-expanded="open" @click="open = !open">
      <span v-if="active && stats.pending.length && !showLiveCalls" class="loader small"></span
      ><Icon v-else :name="!active && stats.failures ? 'info' : 'think'" :size="13" /><span
        class="process-label"
        >{{ label }}</span
      ><span v-if="active && !stats.pending.length" class="thinking-dots"><i></i><i></i><i></i></span
      ><Icon name="chevron" :size="12" class="step-chevron" />
    </button>
    <div v-if="open" class="process-timeline">
      <template v-for="(step, index) in steps" :key="index">
        <div v-if="step.kind === 'thinking'" class="step-thinking-text">{{ step.text }}</div>
        <ToolCallGroup v-else-if="step.kind === 'tools'" :calls="step.calls" flat />
        <div v-else class="process-note"><Markdown :text="step.text" :live="step.live" /></div>
      </template>
    </div>
    <template v-else-if="active">
      <div
        v-if="liveThinking"
        ref="current"
        class="step-thinking-text process-current"
        v-text="liveThinking"
      ></div>
      <ToolCallGroup v-else-if="showLiveCalls" :calls="allCalls" flat />
    </template>
  </section>
</template>
