<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

const props = withDefaults(defineProps<{ username: string; busy?: boolean }>(), { busy: false });
const emit = defineEmits<{ logout: [] }>();
const route = useRoute();
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const logoutItem = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const pinned = ref(false);
const avatar = computed(() => props.username.slice(0, 1).toUpperCase() || 'A');
let enterTimer: ReturnType<typeof setTimeout> | null = null;
let leaveTimer: ReturnType<typeof setTimeout> | null = null;
let tabTimer: ReturnType<typeof setTimeout> | null = null;
let active = true;

function cancelTimers() {
  if (enterTimer) clearTimeout(enterTimer);
  if (leaveTimer) clearTimeout(leaveTimer);
  if (tabTimer) clearTimeout(tabTimer);
  enterTimer = leaveTimer = tabTimer = null;
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
  if (active && open.value) logoutItem.value?.focus();
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
    logoutItem.value?.focus();
  } else if (event.key === 'Tab') {
    // Keep native Tab movement; this is a menu, not a modal or a keyboard trap.
    tabTimer = setTimeout(() => close(), 0);
  }
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
      :title="username"
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
      <button ref="logoutItem" type="button" role="menuitem" tabindex="-1" :disabled="busy" @click="signOut">
        退出登录
      </button>
    </div>
  </div>
</template>
