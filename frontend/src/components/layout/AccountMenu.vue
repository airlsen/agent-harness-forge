<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import Icon from '../base/ForgeIcon.vue';

type ThemePreference = 'system' | 'light' | 'dark';
const themeOptions: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: '跟随系统', icon: 'panel' },
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
];
const props = withDefaults(defineProps<{ username: string; theme: ThemePreference; busy?: boolean }>(), {
  busy: false,
});
const emit = defineEmits<{ 'change-theme': [value: ThemePreference]; help: []; logout: [] }>();
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
  if (active && open.value) menuItems()[0]?.focus();
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
function selectTheme(value: ThemePreference) {
  close(true);
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
      :aria-label="`${username}，${busy ? '正在退出登录' : '账号菜单'}`"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="open ? 'enterprise-account-menu' : undefined"
      @click="toggle"
      @keydown.down.prevent="showWithFocus"
      @keydown.up.prevent="showWithFocus"
    >
      <span class="enterprise-avatar" aria-hidden="true">
        <span v-if="busy" class="loader small"></span><template v-else>{{ avatar }}</template>
      </span>
      <span class="enterprise-account-identity">
        <strong>{{ username }}</strong><small>当前管理员账号</small>
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
      <span class="enterprise-account-menu-label">外观</span>
      <div role="group" aria-label="外观">
        <button
          v-for="option in themeOptions"
          :key="option.value"
          type="button"
          role="menuitemradio"
          :aria-checked="theme === option.value"
          tabindex="-1"
          @click="selectTheme(option.value)"
        >
          <Icon :name="option.icon" :size="16" /><span>{{ option.label }}</span>
          <Icon v-if="theme === option.value" name="check" :size="16" class="enterprise-account-check" />
        </button>
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
