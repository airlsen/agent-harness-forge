<script setup lang="ts">
import { computed, ref, watch, type VNode } from 'vue';
import { useConversation } from '../../stores/conversation';
import { usePlatform } from '../../stores/platform';
import type { ModelOption } from '../../types/platform';
import { contextPressure, tokenLabel } from '../../utils/conversation/modelContext';
import Icon from '../base/ForgeIcon.vue';

/**
 * 聊天输入框的模型选择。模型属于本次会话、与场景无关：
 * 选择会话使用的模型：选哪个，下一条消息就用哪个；已有回复保持原模型。
 */
const emit = defineEmits<{ selected: []; opened: [] }>();
const app = usePlatform();
const chat = useConversation();
const SelectMenu = (props: { node: VNode }) => props.node;
const open = ref(false);
watch(
  () => [app.modelOptions, app.defaultModelId, chat.current?.id, chat.current?.modelId] as const,
  () => chat.syncModel(),
  { immediate: true },
);

const inSession = computed(() => Boolean(chat.current));
const currentId = computed(() => chat.current?.modelId ?? null);
const selected = computed(
  () => app.modelOptions.find((option) => option.id === chat.selectedModelId) ?? null,
);
/** 会话当前模型已停用、删除或是未记录配置的旧会话：列表里单独列出，便于选回。 */
const currentUnlisted = computed(
  () =>
    inSession.value &&
    !app.modelOptions.some((option) => option.id !== null && option.id === currentId.value),
);
/** 选中的是会话原模型且它已不在可选列表中 */
const keepsUnlisted = computed(() => currentUnlisted.value && chat.selectedModelId === currentId.value);
const label = computed(() => {
  if (inSession.value && (keepsUnlisted.value || !selected.value))
    return chat.current?.modelName || chat.current?.model || '未记录模型';
  if (!app.modelOptions.length) return '未配置模型';
  return selected.value?.name ?? '选择模型';
});
const pickerValue = computed(() =>
  keepsUnlisted.value ? '__current__' : (chat.selectedModelId ?? undefined),
);
const title = computed(() => {
  if (inSession.value && (keepsUnlisted.value || !selected.value)) return chat.current?.model || '未记录模型';
  if (!app.modelOptions.length) return '尚无可用模型，请由管理员在「模型管理」启用';
  return selected.value ? `${selected.value.name} · ${selected.value.model}` : '选择本次会话使用的模型';
});

function contextLabel(tokens: number) {
  return `${tokenLabel(tokens)} 上下文`;
}
function priceLabel(option: ModelOption) {
  if (option.inputPrice === null || option.outputPrice === null) return '';
  return `¥${option.inputPrice}/¥${option.outputPrice} 每百万 tokens`;
}
function statusLabel(option: ModelOption) {
  return option.status === 'failed' ? '连接异常' : option.status === 'untested' ? '未验证' : '';
}
function tight(option: ModelOption) {
  return (
    inSession.value &&
    option.id !== currentId.value &&
    contextPressure(chat.current?.contextTokens, option.contextWindow)
  );
}
function choose(value: unknown) {
  if (typeof value !== 'number' && value !== '__current__') return;
  const id = value === '__current__' ? currentId.value : Number(value);
  if (chat.selectModel(id)) emit('selected');
  open.value = false;
}
function visible(value: boolean) {
  open.value = value;
  if (value) emit('opened');
}
defineExpose({ close: () => (open.value = false) });
</script>

<template>
  <div class="model-picker-wrap">
    <RouterLink
      v-if="!inSession && !app.modelOptions.length"
      to="/agent/models"
      class="model-trigger is-empty"
      :title="title"
    >
      <Icon name="model" :size="15" /><span>{{ label }}</span>
    </RouterLink>
    <Icon v-if="inSession || app.modelOptions.length" class="model-select-icon" name="model" :size="15" />
    <a-select
      v-if="inSession || app.modelOptions.length"
      class="model-select"
      :value="pickerValue"
      :disabled="chat.running || chat.loading"
      aria-label="选择模型"
      :title="title"
      :open="open"
      :show-search="false"
      option-label-prop="label"
      popup-class-name="task-select-popup model-select-popup"
      @dropdown-visible-change="visible"
      @change="choose"
    >
      <a-select-option
        v-if="currentUnlisted"
        value="__current__"
        :label="chat.current?.modelName || chat.current?.model || '未记录模型'"
      >
        <Icon name="model" :size="17" />
        <span class="task-select-option-copy">
          <strong
            >{{ chat.current?.modelName || chat.current?.model || '未记录模型'
            }}<small class="model-status-badge is-failed">{{
              currentId === null ? '未记录配置' : '已停用'
            }}</small></strong
          >
          <span>不在可选列表中，切换后无法再切回</span>
        </span>
      </a-select-option>
      <a-select-option
        v-for="option in app.modelOptions"
        :key="option.id"
        :value="option.id"
        :label="option.name"
      >
        <Icon name="model" :size="17" />
        <span class="task-select-option-copy">
          <strong
            >{{ option.name
            }}<small v-if="option.id === app.defaultModelId" class="model-default-badge">默认</small
            ><small v-if="statusLabel(option)" :class="['model-status-badge', `is-${option.status}`]">{{
              statusLabel(option)
            }}</small
            ><small v-if="tight(option)" class="model-status-badge is-failed">上下文偏紧</small></strong
          >
          <span
            >{{ option.model }} · {{ contextLabel(option.contextWindow)
            }}<template v-if="priceLabel(option)"> · {{ priceLabel(option) }}</template></span
          >
        </span>
      </a-select-option>
      <template #dropdownRender="{ menuNode }">
        <SelectMenu :node="menuNode" />
        <RouterLink class="task-select-footer" to="/agent/models" @click="open = false"
          >管理模型 <Icon name="arrow" :size="14"
        /></RouterLink>
      </template>
    </a-select>
  </div>
</template>
