<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useConversation } from '../stores/conversation';
import { usePlatform } from '../stores/platform';
import type { ModelOption } from '../types/platform';
import Icon from './ForgeIcon.vue';

/**
 * 聊天输入框的模型选择。模型属于本次会话、与场景无关：
 * 新会话可选；已创建的会话在创建时锁定模型（会话内切换属于第二期）。
 */
const emit = defineEmits<{ selected: []; opened: [] }>();
const app = usePlatform();
const chat = useConversation();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
watch(
  () => [app.modelOptions, app.defaultModelId, chat.current?.id] as const,
  () => chat.syncModel(),
  { immediate: true },
);

const locked = computed(() => Boolean(chat.current));
const selected = computed(
  () => app.modelOptions.find((option) => option.id === chat.selectedModelId) ?? null,
);
const label = computed(() => {
  if (chat.current) return chat.current.modelName || chat.current.model || '未记录模型';
  if (!app.modelOptions.length) return '未配置模型';
  return selected.value?.name ?? '选择模型';
});
const title = computed(() => {
  if (chat.current) return `本会话使用的模型：${chat.current.model || '未记录'}（创建时锁定）`;
  if (!app.modelOptions.length) return '尚无可用模型，请由管理员在「模型管理」启用';
  return selected.value ? `${selected.value.name} · ${selected.value.model}` : '选择本次会话使用的模型';
});

function contextLabel(tokens: number) {
  return tokens >= 1000000
    ? `${+(tokens / 1000000).toFixed(1)}M 上下文`
    : `${Math.round(tokens / 1000)}K 上下文`;
}
function priceLabel(option: ModelOption) {
  if (option.inputPrice === null || option.outputPrice === null) return '';
  return `¥${option.inputPrice}/¥${option.outputPrice} 每百万 tokens`;
}
function statusLabel(option: ModelOption) {
  return option.status === 'failed' ? '连接异常' : option.status === 'untested' ? '未验证' : '';
}
function choose(option: ModelOption) {
  if (chat.selectModel(option.id)) emit('selected');
  open.value = false;
}
function toggle() {
  if (locked.value || !app.modelOptions.length) return;
  open.value = !open.value;
  if (open.value) emit('opened');
}
function outside(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
defineExpose({ close: () => (open.value = false) });
</script>

<template>
  <div ref="root" class="model-picker-wrap">
    <RouterLink
      v-if="!locked && !app.modelOptions.length"
      to="/agent/models"
      class="model-trigger is-empty"
      :title="title"
    >
      <Icon name="cpu" :size="15" /><span>{{ label }}</span>
    </RouterLink>
    <button
      v-else
      type="button"
      class="model-trigger"
      :disabled="locked || chat.running || chat.loading"
      :aria-expanded="open"
      aria-label="选择模型"
      aria-controls="model-options"
      :title="title"
      @click="toggle"
      @keydown.esc.stop="open = false"
    >
      <Icon name="cpu" :size="15" />
      <span>{{ label }}</span>
      <Icon v-if="!locked" name="chevronDown" :size="13" />
      <Icon v-else name="lock" :size="12" />
    </button>
    <div
      v-if="open"
      id="model-options"
      class="scenario-popover model-popover"
      @keydown.esc.stop="open = false"
    >
      <div class="popover-label">本次会话使用的模型 · 与场景无关</div>
      <button
        v-for="option in app.modelOptions"
        :key="option.id"
        type="button"
        :class="{ selected: option.id === chat.selectedModelId }"
        @click="choose(option)"
      >
        <Icon name="cpu" :size="17" />
        <div>
          <strong
            >{{ option.name
            }}<small v-if="option.id === app.defaultModelId" class="model-default-badge">默认</small
            ><small v-if="statusLabel(option)" :class="['model-status-badge', `is-${option.status}`]">{{
              statusLabel(option)
            }}</small></strong
          >
          <span
            >{{ option.model }} · {{ contextLabel(option.contextWindow)
            }}<template v-if="priceLabel(option)"> · {{ priceLabel(option) }}</template></span
          >
        </div>
        <Icon v-if="option.id === chat.selectedModelId" name="check" :size="15" />
      </button>
      <RouterLink to="/agent/models">管理模型 <Icon name="arrow" :size="14" /></RouterLink>
    </div>
  </div>
</template>
