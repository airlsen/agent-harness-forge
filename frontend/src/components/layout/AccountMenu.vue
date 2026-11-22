<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import Icon from '../base/ForgeIcon.vue';
import SpaceMark from '../space/SpaceMark.vue';
import { INLINE_SPACE_LIMIT, useSpace } from '../../stores/space';

type ThemePreference = 'system' | 'light' | 'dark';
const themeOptions: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: '跟随系统', icon: 'computer' },
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
];
const props = withDefaults(defineProps<{ username: string; theme: ThemePreference; busy?: boolean }>(), {
  busy: false,
});
const emit = defineEmits<{
  'change-theme': [value: ThemePreference];
  help: [];
  logout: [];
  /** 选择了另一个空间（由外层决定是否需要离开当前页面） */
  'switch-space': [id: number];
  'manage-spaces': [];
}>();
const space = useSpace();
// 空间较多时显示搜索框，列表区域限高滚动
const spaceQuery = ref('');
const searchable = computed(() => space.spaces.length > INLINE_SPACE_LIMIT);
const shownSpaces = computed(() => {
  const keyword = spaceQuery.value.trim().toLowerCase();
  const items = space.sorted;
  return keyword ? items.filter((item) => item.name.toLowerCase().includes(keyword)) : items;
});
function chooseSpace(id: number) {
  close(true);
  if (id !== space.currentId) emit('switch-space', id);
}
function manageSpaces() {
  close(false);
  emit('manage-spaces');
}
const route = useRoute();
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const pinned = ref(false);
const avatar = computed(() => props.username.slice(0, 1).toUpperCase() || 'A');
let enterTimer: ReturnType<typeof setTimeout> | null = null;
let leaveTimer: ReturnType<typeof setTimeout> | null = null;
let active = true;
function menuItems() {
  return Array.from(
    root.value?.querySelectorAll<HTMLButtonElement>('.enterprise-account-menu button[role^="menuitem"]') ??
      [],
  );
}

function cancelTimers() {
  if (enterTimer) clearTimeout(enterTimer);
  if (leaveTimer) clearTimeout(leaveTimer);
  enterTimer = leaveTimer = null;
}
function close(restoreFocus = false) {
  cancelTimers();
  spaceQuery.value = '';
  open.value = false;
  pinned.value = false;
  if (restoreFocus && !trigger.value?.closest('[inert]')) trigger.value?.focus();
}
async function showWithFocus() {
  if (props.busy) return;
  cancelTimers();
  open.value = true;
  pinned.value = true;
  await nextTick();
  if (!active || !open.value) return;
  // 焦点落在当前空间上，方向键可直接切换
  (
    root.value?.querySelector<HTMLButtonElement>('.enterprise-space-option[aria-checked="true"]') ??
    menuItems()[0]
  )?.focus();
}
function toggle() {
  // Clicking an already-hovered avatar pins its menu, rather than hiding it.
  if (open.value && pinned.value) close(true);
  else void showWithFocus();
}
function enter(event: PointerEvent) {
  if (
    props.busy ||
    event.pointerType !== 'mouse' ||
    !window.matchMedia('(hover: hover) and (pointer: fine)').matches
  )
    return;
  cancelTimers();
  enterTimer = setTimeout(() => {
    if (active && !props.busy) open.value = true;
    enterTimer = null;
  }, 120);
}
function leave() {
  if (enterTimer) clearTimeout(enterTimer);
  enterTimer = null;
  if (pinned.value || root.value?.contains(document.activeElement)) return;
  // A small grace period plus the CSS bridge keeps the upward popover reachable.
  leaveTimer = setTimeout(() => close(), 180);
}
function outside(event: Event) {
  if (!root.value?.contains(event.target as Node)) close();
  else if (event.type === 'focusin' && leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
}
function focusOut(event: FocusEvent) {
  if (!event.relatedTarget || !root.value?.contains(event.relatedTarget as Node)) close();
}
function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !open.value) return;
  const focused = document.activeElement;
  if (focused?.closest('[aria-modal="true"]') && !root.value?.contains(focused)) return;
  event.preventDefault();
  event.stopPropagation();
  close(Boolean(root.value?.contains(focused)));
}
function menuKeyboard(event: KeyboardEvent) {
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const items = menuItems().filter((item) => !item.disabled);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }
}
// 切换外观后菜单保持打开：主题立即生效，便于来回对比
function selectTheme(value: ThemePreference) {
  emit('change-theme', value);
}
function showHelp() {
  close(false);
  emit('help');
}
function signOut() {
  if (props.busy) return;
  close(true);
  emit('logout');
}
watch([() => route.fullPath, () => props.busy], () => close());
// 打开菜单时刷新空间列表（别人可能刚新建或删除了空间）；悬停频繁开合时 30 秒内只读一次
let spacesLoadedAt = 0;
watch(open, (value) => {
  if (!value || Date.now() - spacesLoadedAt < 30000) return;
  spacesLoadedAt = Date.now();
  void space.load().catch(() => {});
});
onMounted(() => {
  document.addEventListener('pointerdown', outside);
  document.addEventListener('focusin', outside);
  document.addEventListener('keydown', escape);
});
onBeforeUnmount(() => {
  active = false;
  cancelTimers();
  document.removeEventListener('pointerdown', outside);
  document.removeEventListener('focusin', outside);
  document.removeEventListener('keydown', escape);
});
</script>
<template>
  <div ref="root" class="enterprise-profile" @pointerenter="enter" @pointerleave="leave" @focusout="focusOut">
    <button
      ref="trigger"
      type="button"
      class="enterprise-account-trigger"
      :disabled="busy"
      :aria-label="`${username}，${busy ? '正在退出登录' : '账号菜单'}，当前空间：${space.current.name}`"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="open ? 'enterprise-account-menu' : undefined"
      @click="toggle"
      @keydown.up.prevent="showWithFocus"
    >
      <span class="enterprise-avatar" aria-hidden="true">
        <span v-if="busy" class="loader small"></span><template v-else>{{ avatar }}</template>
      </span>
      <span class="enterprise-account-identity">
        <strong>{{ username }}</strong><small
          class="enterprise-account-space"
          :title="`当前空间：${space.current.name}`"
          ><SpaceMark :space="space.current" :size="14" /><span>{{ space.current.name }}</span></small
        >
      </span>
    </button>
    <div
      v-if="open"
      id="enterprise-account-menu"
      class="enterprise-account-menu"
      role="menu"
      aria-label="账号操作"
      @keydown="menuKeyboard"
    >
      <!-- 空间：当前空间打勾；空间较多时出现搜索框，列表限高滚动 -->
      <div class="enterprise-space-heading">空间</div>
      <label v-if="searchable" class="enterprise-space-search">
        <Icon name="search" :size="14" />
        <input v-model="spaceQuery" type="search" placeholder="搜索空间" aria-label="搜索空间" />
      </label>
      <div :class="['enterprise-space-options', { scroll: searchable }]" role="group" aria-label="切换空间">
        <button
          v-for="item in shownSpaces"
          :key="item.id"
          type="button"
          role="menuitemradio"
          class="enterprise-space-option"
          :aria-checked="item.id === space.currentId"
          tabindex="-1"
          :title="item.description || item.name"
          @click="chooseSpace(item.id)"
        >
          <SpaceMark :space="item" :size="18" /><span>{{ item.name }}</span
          ><Icon v-if="item.id === space.currentId" name="check" :size="15" />
        </button>
        <p v-if="!shownSpaces.length" class="enterprise-space-empty">没有匹配的空间</p>
      </div>
      <button type="button" role="menuitem" tabindex="-1" @click="manageSpaces">
        <Icon name="settings" :size="16" /><span>管理空间</span>
      </button>
      <div class="enterprise-account-menu-divider"></div>
      <!-- 外观只占一行：左侧标题，右侧三段切换（跟随系统 / 浅色 / 深色） -->
      <div class="enterprise-account-theme" role="group" aria-label="外观">
        <Icon name="contrast" :size="16" /><span>外观</span>
        <div class="enterprise-theme-switch">
          <button
            v-for="option in themeOptions"
            :key="option.value"
            type="button"
            role="menuitemradio"
            :aria-checked="theme === option.value"
            :aria-label="option.label"
            :title="option.label"
            tabindex="-1"
            @click="selectTheme(option.value)"
          >
            <Icon :name="option.icon" :size="15" />
          </button>
        </div>
      </div>
      <div class="enterprise-account-menu-divider"></div>
      <button type="button" role="menuitem" tabindex="-1" @click="showHelp">
        <Icon name="book" :size="16" /><span>使用帮助</span>
      </button>
      <button type="button" role="menuitem" tabindex="-1" :disabled="busy" @click="signOut">
        <Icon name="logout" :size="16" /><span>退出登录</span>
      </button>
    </div>
  </div>
</template>
