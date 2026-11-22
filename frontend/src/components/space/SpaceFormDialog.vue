<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import Icon from '../base/ForgeIcon.vue';
import SpaceMark from './SpaceMark.vue';
import { MAX_SPACE_DESCRIPTION, MAX_SPACE_NAME, SPACE_COLORS, useSpace } from '../../stores/space';
import type { Space, SpaceColor } from '../../types/platform';
import { notify } from '../../utils/feedback';

/** 新建 / 编辑空间。公共空间只能改说明。 */
const props = defineProps<{ open: boolean; space?: Space | null }>();
const emit = defineEmits<{ close: []; saved: [space: Space, created: boolean] }>();
const store = useSpace();
const form = reactive({ name: '', color: '' as SpaceColor | '', description: '' });
const saving = ref(false);
const error = ref('');
const editing = computed(() => Boolean(props.space));
const isPublic = computed(() => Boolean(props.space?.isPublic));
// 新建时预览自动挑选的颜色：第一个还没被用过的
const autoColor = computed<SpaceColor>(() => {
  const used = new Set(store.spaces.map((item) => item.color));
  return SPACE_COLORS.find((item) => !used.has(item.value))?.value ?? SPACE_COLORS[0].value;
});
const preview = computed(() => ({
  name: form.name.trim() || '新',
  color: (form.color || autoColor.value) as SpaceColor,
  isPublic: isPublic.value,
}));
const nameError = computed(() => {
  const name = form.name.trim();
  if (isPublic.value) return '';
  if (Array.from(name).length > MAX_SPACE_NAME) return `最多 ${MAX_SPACE_NAME} 个字`;
  if (
    name &&
    store.spaces.some((item) => item.id !== props.space?.id && item.name.toLowerCase() === name.toLowerCase())
  )
    return '已有同名空间';
  return '';
});
const canSave = computed(
  () =>
    !saving.value &&
    !nameError.value &&
    (isPublic.value || Boolean(form.name.trim())) &&
    Array.from(form.description).length <= MAX_SPACE_DESCRIPTION,
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.name = props.space?.name ?? '';
    form.color = props.space?.color ?? '';
    form.description = props.space?.description ?? '';
    error.value = '';
  },
  { immediate: true },
);

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = '';
  try {
    const input = { name: form.name.trim(), color: form.color, description: form.description.trim() };
    const saved = props.space ? await store.update(props.space.id, input) : await store.create(input);
    if (props.space) notify('success', '空间已保存');
    emit('saved', saved, !props.space);
    emit('close');
  } catch (reason) {
    error.value = (reason as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <a-modal
    :open="open"
    :width="480"
    centered
    :title="editing ? (isPublic ? '编辑公共空间' : '编辑空间') : '新建空间'"
    :mask-closable="!saving"
    @cancel="!saving && emit('close')"
  >
    <form class="space-form" @submit.prevent="save">
      <div class="space-form-head">
        <SpaceMark :space="preview" :size="40" />
        <p v-if="isPublic">公共空间内置、不能删除或改名。这里的内容所有空间都能看到和使用。</p>
        <p v-else-if="editing">名称和颜色只用于区分空间，修改后不影响其中的内容。</p>
        <p v-else>按团队或业务划分场景、Skill、MCP 和插件，切换空间后只显示本空间和公共的内容。</p>
      </div>
      <label class="space-form-field">
        <span>空间名称</span>
        <a-input
          v-model:value="form.name"
          :disabled="isPublic"
          :maxlength="MAX_SPACE_NAME + 10"
          placeholder="例如：财务部、研发中心"
          :status="nameError ? 'error' : undefined"
          autofocus
        />
        <small v-if="nameError" class="space-form-error">{{ nameError }}</small>
      </label>
      <div v-if="!isPublic" class="space-form-field">
        <span>颜色</span>
        <div class="space-color-options" role="radiogroup" aria-label="空间颜色">
          <button
            v-for="item in SPACE_COLORS"
            :key="item.value"
            type="button"
            role="radio"
            :aria-checked="(form.color || autoColor) === item.value"
            :aria-label="item.label"
            :title="item.label"
            :class="['space-color-option', { selected: (form.color || autoColor) === item.value }]"
            @click="form.color = item.value"
          >
            <SpaceMark :space="{ name: ' ', color: item.value, isPublic: false }" :size="22" />
            <Icon v-if="(form.color || autoColor) === item.value" name="check" :size="13" />
          </button>
        </div>
        <small v-if="!editing && !form.color">已自动选择一个还没用过的颜色，也可以手动换</small>
      </div>
      <label class="space-form-field">
        <span>说明<em>（可选）</em></span>
        <a-textarea
          v-model:value="form.description"
          :rows="2"
          :maxlength="MAX_SPACE_DESCRIPTION"
          show-count
          placeholder="这个空间给谁用、放哪些内容"
        />
      </label>
      <a-alert v-if="!editing" type="info" show-icon class="space-form-hint">
        <template #message>新空间是空的</template>
        <template #description>
          公共空间的内容在这里都能用；在这个空间里新建的场景、Skill、MCP
          和插件会放进这个空间。基础工具默认全部开启，可在空间管理中按需关闭。已有内容可以通过「移动到其他空间」放进来。
        </template>
      </a-alert>
      <a-alert v-if="error" type="error" show-icon :message="error" />
      <button type="submit" hidden></button>
    </form>
    <template #footer>
      <a-button :disabled="saving" @click="emit('close')">取消</a-button>
      <a-button type="primary" :disabled="!canSave" :loading="saving" @click="save">
        {{ editing ? '保存' : '创建空间' }}
      </a-button>
    </template>
  </a-modal>
</template>
<style scoped>
.space-form {
  display: grid;
  gap: 14px;
}
.space-form-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.space-form-head p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}
.space-form-field {
  display: grid;
  gap: 6px;
}
.space-form-field > span {
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 550;
}
.space-form-field > span em {
  color: var(--color-text-tertiary);
  font-style: normal;
  font-weight: 400;
}
.space-form-field > small {
  color: var(--color-text-tertiary);
  font-size: 12px;
}
.space-form-field > small.space-form-error {
  color: var(--color-danger-text);
}
.space-color-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.space-color-option {
  position: relative;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 8px;
}
.space-color-option.selected {
  border-color: var(--color-text-primary);
}
.space-color-option:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
.space-color-option > svg {
  position: absolute;
  color: var(--neutral-0);
}
.space-form-hint :deep(.ant-alert-description) {
  font-size: 12px;
}
</style>
