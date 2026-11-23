<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from '../base/ForgeIcon.vue';
import SpaceMark from './SpaceMark.vue';
import { PUBLIC_SPACE_ID, useSpace } from '../../stores/space';
import type { MoveCheck, SpaceResourceKind } from '../../types/platform';
import { notify } from '../../utils/common/feedback';

/**
 * 把场景 / Skill / MCP / 插件移到另一个空间。
 * 选中目标后先做检查：被其他空间的场景使用、场景依赖在目标空间不可用、Skill 重名时不能移动。
 */
const props = defineProps<{
  open: boolean;
  kind: SpaceResourceKind;
  /** 场景 / Skill / MCP 为数字编号，插件为 plugin_id */
  resourceId: number | string | null;
  name: string;
  /** 内容当前所在空间 */
  spaceId?: number | null;
}>();
const emit = defineEmits<{ close: []; moved: [targetSpaceId: number] }>();
const space = useSpace();
const target = ref<number | null>(null);
const check = ref<MoveCheck | null>(null);
const checking = ref(false);
const checkError = ref('');
const moving = ref(false);
let generation = 0;

const KIND_LABELS: Record<SpaceResourceKind, string> = {
  scenario: '场景',
  skill: 'Skill',
  mcp: 'MCP 服务',
  plugin: '插件',
};
const BLOCKER_LABELS: Record<string, string> = {
  skill: 'Skill',
  mcp: 'MCP',
  plugin: '插件',
  scenario: '场景',
};
const kindLabel = computed(() => KIND_LABELS[props.kind]);
const source = computed(() => space.byId(props.spaceId ?? PUBLIC_SPACE_ID));
const options = computed(() => space.sorted.filter((item) => item.id !== (props.spaceId ?? PUBLIC_SPACE_ID)));
const targetInfo = computed(() => space.byId(target.value));
const ready = computed(
  () =>
    Boolean(target.value && check.value && !checking.value && !checkError.value) &&
    !check.value?.blockers.length &&
    !check.value?.conflicts.length,
);
const consequence = computed(() => {
  const to = targetInfo.value;
  if (!to) return '';
  if (props.kind === 'scenario')
    return `已有会话留在原空间；之后新建的会话在「${to.name}」。场景用到的基础工具以目标空间的开关为准。`;
  const versions = props.kind === 'plugin' ? '插件的全部版本一起移动。' : '';
  if (to.isPublic) return `${versions}移到公共后，所有空间都能看到和使用。`;
  return `${versions}移动后，只有「${to.name}」和公共空间的场景能使用它。`;
});

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    target.value = null;
    check.value = null;
    checkError.value = '';
    if (!space.loaded) await space.load().catch(() => {});
  },
  { immediate: true },
);

async function choose(id: number) {
  if (moving.value || props.resourceId === null) return;
  target.value = id;
  check.value = null;
  checkError.value = '';
  checking.value = true;
  const current = ++generation;
  try {
    const result = await space.moveCheck(props.kind, props.resourceId, id);
    if (current === generation) check.value = result;
  } catch (error) {
    if (current === generation) checkError.value = (error as Error).message;
  } finally {
    if (current === generation) checking.value = false;
  }
}

async function confirmMove() {
  if (!ready.value || !target.value || props.resourceId === null) return;
  moving.value = true;
  try {
    await space.move(props.kind, props.resourceId, target.value);
    const to = targetInfo.value;
    const hidden = to && !to.isPublic && to.id !== space.currentId;
    notify(
      'success',
      hidden ? `已移到「${to.name}」，切换到该空间即可查看` : `已移到「${to?.name ?? '目标空间'}」`,
    );
    emit('moved', target.value);
    emit('close');
  } catch (error) {
    notify('error', (error as Error).message);
    // 检查之后情况可能变了（例如别人刚建了引用它的场景）：重新检查
    if (target.value) void choose(target.value);
  } finally {
    moving.value = false;
  }
}
</script>
<template>
  <a-modal
    :open="open"
    :width="520"
    centered
    :mask-closable="!moving"
    :closable="!moving"
    :title="`移动${kindLabel}到其他空间`"
    @cancel="!moving && emit('close')"
  >
    <div class="move-space">
      <p class="move-space-source">
        「{{ name }}」目前在
        <span v-if="source" class="move-space-inline"
          ><SpaceMark :space="source" :size="16" />{{ source.name }}</span
        >。
      </p>
      <div class="move-space-options" role="radiogroup" :aria-label="`选择目标空间`">
        <button
          v-for="item in options"
          :key="item.id"
          type="button"
          role="radio"
          :aria-checked="target === item.id"
          :class="['move-space-option', { selected: target === item.id }]"
          :disabled="moving"
          @click="choose(item.id)"
        >
          <SpaceMark :space="item" :size="24" />
          <span class="move-space-option-text">
            <strong>{{ item.name }}</strong>
            <small>{{ item.isPublic ? '所有空间都能看到和使用' : item.description || '暂无说明' }}</small>
          </span>
          <Icon v-if="target === item.id" name="check" :size="16" class="move-space-check" />
        </button>
        <p v-if="!options.length" class="move-space-empty">
          还没有其他空间。<RouterLink to="/agent/spaces" @click="emit('close')">去创建空间</RouterLink>
        </p>
      </div>
      <div v-if="checking" class="move-space-status" role="status">
        <a-spin size="small" />正在检查能否移动…
      </div>
      <a-alert v-else-if="checkError" type="error" show-icon :message="checkError" />
      <template v-else-if="check">
        <a-alert
          v-if="check.blockers.length"
          type="error"
          show-icon
          :message="
            kind === 'scenario'
              ? '这个场景用到的以下内容在目标空间里用不到'
              : '其他空间的以下场景仍在使用它，移走后将无法使用'
          "
        >
          <template #description>
            <ul class="move-space-list">
              <li v-for="item in check.blockers" :key="`${item.kind}-${item.id}`">
                {{ BLOCKER_LABELS[item.kind] ?? item.kind }}「{{ item.name }}」<span v-if="item.spaceName">
                  · {{ item.spaceName }}</span
                >
              </li>
            </ul>
            <p class="move-space-tip">
              {{
                kind === 'scenario'
                  ? '可以先把这些内容移到目标空间或公共空间，再移动场景。'
                  : '可以移到公共空间（所有空间都能用），或先调整这些场景。'
              }}
            </p>
          </template>
        </a-alert>
        <a-alert v-if="check.conflicts.length" type="error" show-icon message="目标空间能看到同名 Skill">
          <template #description>
            <ul class="move-space-list">
              <li v-for="item in check.conflicts" :key="item.id">
                「{{ item.name }}」与「{{ item.conflictSpace }}」空间的 Skill 重名，请先改名
              </li>
            </ul>
          </template>
        </a-alert>
        <p v-if="ready" class="move-space-consequence"><Icon name="info" :size="14" />{{ consequence }}</p>
      </template>
    </div>
    <template #footer>
      <a-button :disabled="moving" @click="emit('close')">取消</a-button>
      <a-button type="primary" :disabled="!ready" :loading="moving" @click="confirmMove">
        移动到{{ targetInfo ? `「${targetInfo.name}」` : '…' }}
      </a-button>
    </template>
  </a-modal>
</template>
<style scoped>
.move-space {
  display: grid;
  gap: 12px;
}
.move-space-source {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}
.move-space-inline {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--color-text-primary);
  font-weight: 600;
  vertical-align: -3px;
}
.move-space-options {
  display: grid;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
}
.move-space-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--surface-card);
  text-align: left;
  transition: border-color 0.15s ease;
}
.move-space-option:not(:disabled):hover {
  border-color: var(--border-strong);
}
.move-space-option.selected {
  border-color: var(--color-brand);
  background: var(--surface-selected);
}
.move-space-option:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
.move-space-option-text {
  display: grid;
  flex: 1;
  min-width: 0;
}
.move-space-option-text strong {
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
}
.move-space-option-text small {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.move-space-check {
  color: var(--color-brand);
}
.move-space-empty {
  margin: 0;
  color: var(--color-text-tertiary);
  font-size: 13px;
}
.move-space-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-secondary);
  font-size: 13px;
}
.move-space-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
.move-space-tip {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
}
.move-space-consequence {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}
.move-space-consequence svg {
  flex-shrink: 0;
  margin-top: 3px;
}
</style>
