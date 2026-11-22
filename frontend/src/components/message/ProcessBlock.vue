<script setup lang="ts">
/**
 * 一轮的执行过程：所有思考、工具调用与中间说明合成一个块。
 * 运行中固定为「头部 + 一块固定高度的当前动态」，高度不随步骤切换伸缩：
 * - 头部：正在思考 / 正在调用某工具 / 等待确认 / 正在回复，并带已调用的工具数；只在这里转一个圈；
 * - 当前动态：思考时显示最新思考文字，调工具时显示当前这一个调用与参数；
 *   两步之间（思考已结算、下一个调用还没开始等）保留上一条动态，不清空。
 * 已完成的调用不在运行中列出，点头部展开完整时间线；结束后收起成一行摘要。
 * 不依赖具体会话：工作台与 Skill 编写助手共用；waiting 表示进行中的调用正在等待用户确认，
 * writing 表示过程之后的回答正在流式输出。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { usePlatform } from '../../stores/platform';
import {
  processStats,
  processSummary,
  toolArgSummary,
  type ToolCallView,
  type TurnStep,
} from '../../utils/turns';
import { builtinToolTitle } from '../../utils/files';
import Icon from '../base/ForgeIcon.vue';
import Markdown from '../markdown/MarkdownContent.vue';
import ToolCallGroup from './ToolCallGroup.vue';

const props = defineProps<{ steps: TurnStep[]; active: boolean; waiting?: boolean; writing?: boolean }>();
type Activity = { kind: 'thinking'; text: string } | { kind: 'tool'; id: string };

const app = usePlatform();
const open = ref(false);
const thinkingBox = ref<HTMLElement | null>(null);
const stats = computed(() => processStats(props.steps));
const allCalls = computed(() => props.steps.flatMap((step) => (step.kind === 'tools' ? step.calls : [])));
const pendingCall = computed(() => stats.value.pending.at(-1));
const liveThinking = computed(() => {
  const last = props.steps.at(-1);
  return last?.kind === 'thinking' && last.live ? last.text : '';
});
/** 此刻正在发生的动态；两步之间为空 */
const activity = computed<Activity | null>(() => {
  if (liveThinking.value) return { kind: 'thinking', text: liveThinking.value };
  if (pendingCall.value) return { kind: 'tool', id: pendingCall.value.id };
  return null;
});
/** 最近一条动态：两步之间继续显示它，避免显示区清空再出现 */
const lastActivity = ref<Activity | null>(null);
watch(
  activity,
  (value) => {
    if (value) lastActivity.value = value;
  },
  { immediate: true },
);
const shown = computed(() => (props.active && !open.value ? lastActivity.value : null));
/** 当前动态里的调用以最新状态显示（保留期间可能已返回结果） */
const shownCall = computed<ToolCallView | undefined>(() => {
  const value = shown.value;
  return value?.kind === 'tool' ? allCalls.value.find((call) => call.id === value.id) : undefined;
});
const shownState = computed(() => {
  const call = shownCall.value;
  if (!call) return '';
  if (call.pending) return props.waiting ? '等待确认' : '正在调用…';
  return call.isError ? '失败' : '已完成';
});

const label = computed(() => {
  if (!props.active) return processSummary(stats.value);
  const call = pendingCall.value;
  const total = stats.value.calls;
  if (call) {
    const position = allCalls.value.findIndex((item) => item.id === call.id) + 1;
    const action = props.waiting ? '等待你的确认' : '正在调用';
    return `${action}：${toolTitle(call.tool)}${total > 1 ? ` · 第 ${position} 个工具` : ''}`;
  }
  const action = props.writing ? '正在回复' : '正在思考';
  return total ? `${action} · 已调用 ${total} 个工具` : action;
});
function toolTitle(name: string) {
  return app.tools.find((tool) => tool.name === name)?.title ?? builtinToolTitle(name);
}
// 流式思考保持显示最新内容
watch(
  () => (shown.value?.kind === 'thinking' ? shown.value.text : ''),
  async () => {
    await nextTick();
    if (thinkingBox.value) thinkingBox.value.scrollTop = thinkingBox.value.scrollHeight;
  },
);
</script>
<template>
  <section :class="['process-block', { active, open }]">
    <button class="process-header" type="button" :aria-expanded="open" @click="open = !open">
      <span v-if="active" class="loader small"></span
      ><Icon v-else :name="stats.failures ? 'info' : 'think'" :size="13" /><span class="process-label">{{
        label
      }}</span
      ><Icon name="chevron" :size="12" class="step-chevron" />
    </button>
    <div v-if="open" class="process-timeline">
      <template v-for="(step, index) in steps" :key="index">
        <div v-if="step.kind === 'thinking'" class="step-thinking-text">{{ step.text }}</div>
        <ToolCallGroup v-else-if="step.kind === 'tools'" :calls="step.calls" :waiting="waiting" flat />
        <div v-else class="process-note"><Markdown :text="step.text" :live="step.live" /></div>
      </template>
    </div>
    <div v-else-if="shown" class="process-live" aria-live="off">
      <div
        v-if="shown.kind === 'thinking'"
        ref="thinkingBox"
        class="process-live-thinking"
        v-text="shown.text"
      ></div>
      <div v-else-if="shownCall" class="process-live-tool">
        <div class="process-live-tool-head">
          <strong>{{ toolTitle(shownCall.tool) }}</strong><span
            :class="['process-live-state', { error: !shownCall.pending && shownCall.isError }]"
            >{{ shownState }}</span
          >
        </div>
        <code v-if="toolArgSummary(shownCall.arguments, 240)" class="process-live-args">{{
          toolArgSummary(shownCall.arguments, 240)
        }}</code>
      </div>
    </div>
  </section>
</template>
