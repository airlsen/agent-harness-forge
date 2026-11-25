<script setup lang="ts">
/**
 * 模型向用户提问的卡片（ask_user_question）：选项单选/多选 + 自由文本「其他」。
 * 提问内容是模型生成的纯文本，直接渲染、不做 Markdown；已结束的提问置灰展示状态。
 */
import { computed, reactive } from 'vue';
import type { PendingQuestion, QuestionAnswerPayload } from '../../types/platform';

const props = defineProps<{
  question: PendingQuestion;
  busy: boolean;
}>();
const emit = defineEmits<{
  resolve: [ticketId: number, payload: QuestionAnswerPayload];
}>();

/** 每个问题的本地作答：选中的选项 label + 「其他」自由文本 */
const selections = reactive<Record<string, string[]>>({});
const customs = reactive<Record<string, string>>({});

const pending = computed(() => props.question.status === 'pending');
const STATUS_TEXT: Record<string, string> = {
  answered: '已回答',
  cancelled: '已跳过，模型会自行继续',
  timeout: '已超时，模型会自行继续',
};
const statusText = computed(() => STATUS_TEXT[props.question.status] ?? '已结束');
const busyThis = computed(() => props.busy && pending.value);

function toggle(questionId: string, label: string, multiSelect: boolean | undefined) {
  if (!pending.value || props.busy) return;
  const current = selections[questionId] ?? [];
  if (multiSelect) {
    selections[questionId] = current.includes(label)
      ? current.filter((item) => item !== label)
      : [...current, label];
  } else {
    selections[questionId] = current.includes(label) ? [] : [label];
  }
}
/** 每个问题都给出内容（选中项或自由文本）才允许提交 */
const complete = computed(() =>
  props.question.questions.every((item) => {
    const selected = selections[item.id] ?? [];
    return selected.length > 0 || Boolean(customs[item.id]?.trim());
  }),
);

function submit() {
  if (!pending.value || props.busy || !complete.value) return;
  emit('resolve', props.question.ticketId, {
    answers: props.question.questions.map((item) => ({
      id: item.id,
      selected: [...(selections[item.id] ?? [])],
      ...(customs[item.id]?.trim() ? { custom: customs[item.id].trim() } : {}),
    })),
  });
}
function dismiss() {
  if (!pending.value || props.busy) return;
  emit('resolve', props.question.ticketId, { action: 'cancel' });
}
</script>

<template>
  <div
    class="approval-card question-card"
    role="region"
    :aria-label="pending ? '模型提问' : '模型提问（已结束）'"
    :class="{ settled: !pending }"
  >
    <div class="approval-heading">
      <span class="approval-symbol"><Icon name="question" :size="20" /></span>
      <div>
        <strong>执行中需要你的回答</strong>
        <p>模型遇到不明确的地方，回答后会继续执行</p>
      </div>
      <span v-if="pending" class="tag warning">待回答</span>
      <span v-else class="tag">{{ statusText }}</span>
    </div>
    <div v-for="item in question.questions" :key="item.id" class="question-item">
      <p class="question-title">
        <span v-if="item.header" class="question-header">{{ item.header }}</span>
        {{ item.question }}
      </p>
      <p v-if="item.detail" class="question-detail">{{ item.detail }}</p>
      <div v-if="item.options?.length" class="question-options">
        <label
          v-for="option in item.options"
          :key="option.label"
          class="question-option"
          :class="{ selected: (selections[item.id] ?? []).includes(option.label) }"
        >
          <input
            type="checkbox"
            :checked="(selections[item.id] ?? []).includes(option.label)"
            :disabled="!pending || busy"
            @change="toggle(item.id, option.label, item.multiSelect)"
          />
          <span class="question-option-body">
            <span>{{ option.label }}</span>
            <small v-if="option.description">{{ option.description }}</small>
          </span>
        </label>
      </div>
      <input
        v-model="customs[item.id]"
        class="question-custom"
        type="text"
        :disabled="!pending || busy"
        :placeholder="item.options?.length ? '其他：填写自定义回答' : '输入你的回答'"
        @keydown.enter.prevent="submit"
      />
    </div>
    <div v-if="pending" class="approval-actions">
      <small>不回答时模型会按自己的判断继续；超过限时同样如此。</small
      ><button class="button secondary" :disabled="busy" @click="dismiss">忽略</button
      ><button class="button primary" :disabled="!complete || busy" @click="submit">
        <span v-if="busyThis" class="loader small"></span><Icon v-else name="check" :size="14" />提交回答
      </button>
    </div>
  </div>
</template>
