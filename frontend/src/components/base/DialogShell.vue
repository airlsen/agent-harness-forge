<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { isolateModalBackground, trapTabKey } from '../../utils/common/focus';

withDefaults(defineProps<{ label: string; variant?: 'drawer' | 'modal'; panelClass?: string }>(), {
  variant: 'drawer',
  panelClass: '',
});
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;
let releaseBackground: (() => void) | null = null;
let mounted = true;
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
  }
  trapTabKey(event, panel.value);
}
onMounted(async () => {
  previousFocus = document.activeElement as HTMLElement;
  document.addEventListener('keydown', keyboard, true);
  await nextTick();
  if (!mounted) return;
  panel.value?.focus();
  releaseBackground = isolateModalBackground();
});
onBeforeUnmount(() => {
  mounted = false;
  document.removeEventListener('keydown', keyboard, true);
  releaseBackground?.();
  if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus();
});
</script>
<template>
  <Teleport to="body">
    <div :class="variant === 'drawer' ? 'drawer-backdrop' : 'modal-backdrop'" @click.self="emit('close')">
      <section
        ref="panel"
        :class="[variant === 'drawer' ? 'drawer' : 'modal', panelClass]"
        role="dialog"
        aria-modal="true"
        :aria-label="label"
        tabindex="-1"
      >
        <slot />
      </section>
    </div>
  </Teleport>
</template>
