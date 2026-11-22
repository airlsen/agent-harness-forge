<script setup lang="ts">
import { computed, ref, type VNode } from 'vue';
import { usePlatform } from '../../stores/platform';
import type { ModelOption } from '../../types/platform';
import { tokenLabel } from '../../utils/modelContext';
import Icon from '../base/ForgeIcon.vue';

/**
 * 通用的模型选择（与工作台输入框的模型选择外观、选项一致），不绑定会话状态：
 * 由使用方决定选中值以及何时提交。Skill 编辑对话用它在两轮之间切换模型。
 */
const props = defineProps<{
  modelValue: number | null;
  disabled?: boolean;
  /** 当前对话原模型已停用或删除时的提示（显示在标题中，选择其他模型后从下一条消息起生效） */
  staleName?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [id: number]; opened: [] }>();
const app = usePlatform();
const SelectMenu = (menu: { node: VNode }) => menu.node;
const open = ref(false);

const selected = computed(() => app.modelOptions.find((option) => option.id === props.modelValue) ?? null);
const label = computed(() => {
  if (!app.modelOptions.length) return '未配置模型';
  return selected.value?.name ?? '选择模型';
});
const title = computed(() => {
  if (!app.modelOptions.length) return '尚无可用模型，请由管理员在「模型管理」启用';
  const current = selected.value
    ? `${selected.value.name} · ${selected.value.model}`
    : '选择本次对话使用的模型';
  return props.staleName ? `原模型「${props.staleName}」已停用，将从下一条消息起使用：${current}` : current;
});

function priceLabel(option: ModelOption) {
  if (option.inputPrice === null || option.outputPrice === null) return '';
  return `¥${option.inputPrice}/¥${option.outputPrice} 每百万 tokens`;
}
function statusLabel(option: ModelOption) {
  return option.status === 'failed' ? '连接异常' : option.status === 'untested' ? '未验证' : '';
}
function choose(value: unknown) {
  if (typeof value === 'number') emit('update:modelValue', value);
  open.value = false;
}
function visible(value: boolean) {
  open.value = value;
  if (value) emit('opened');
}
defineExpose({ close: () => (open.value = false) });
</script>

<template>
  <div class="model-select-wrap">
    <RouterLink v-if="!app.modelOptions.length" to="/agent/models" class="model-empty" :title="title">
      <Icon name="model" :size="15" /><span>{{ label }}</span>
    </RouterLink>
    <template v-else>
      <Icon class="model-select-icon" name="model" :size="15" />
      <a-select
        class="model-select-control"
        :class="{ 'is-stale': staleName }"
        :value="modelValue ?? undefined"
        :disabled="disabled"
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
              }}</small></strong
            >
            <span
              >{{ option.model }} · {{ tokenLabel(option.contextWindow) }} 上下文<template
                v-if="priceLabel(option)"
              >
                · {{ priceLabel(option) }}</template
              ></span
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
    </template>
  </div>
</template>

<style scoped>
.model-select-wrap {
  position: relative;
  min-width: 0;
}
.model-select-icon {
  position: absolute;
  z-index: 1;
  top: 10px;
  left: 9px;
  pointer-events: none;
  color: var(--text-secondary);
}
.model-select-control {
  width: 175px;
  min-width: 100px;
  max-width: 200px;
  height: 34px;
  font-size: 12px;
}
.model-select-control :deep(.ant-select-selector) {
  height: 34px !important;
  min-height: 34px;
  padding-left: 32px;
  border: 1px solid transparent !important;
  border-radius: 10px;
  background: transparent !important;
  box-shadow: none !important;
}
.model-select-control :deep(.ant-select-selection-item) {
  color: var(--text-secondary);
}
.model-select-control.is-stale :deep(.ant-select-selection-item) {
  color: var(--color-warning-text);
}
.model-select-control:not(.ant-select-disabled):hover :deep(.ant-select-selector),
.model-select-control.ant-select-open :deep(.ant-select-selector) {
  background: var(--surface-hover) !important;
}
.model-select-control.ant-select-focused :deep(.ant-select-selector),
.model-select-control.ant-select-open :deep(.ant-select-selector) {
  border-color: var(--accent-focus) !important;
  box-shadow: inset 0 0 0 1px var(--accent-focus) !important;
}
.model-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 6px 9px;
  border-radius: 10px;
  color: var(--color-warning-text);
  font-size: 12px;
  white-space: nowrap;
}
.model-empty:hover {
  background: var(--surface-hover);
}
</style>
