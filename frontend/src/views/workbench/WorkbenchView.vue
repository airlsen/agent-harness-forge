<script setup lang="ts">
import { nextTick, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useConversation } from '../../stores/conversation';
import ConversationStart from '../../components/composer/ConversationStart.vue';
import { animateComposerArrival, captureComposerOrigin } from '../../utils/composerTransition';

const router = useRouter();
const chat = useConversation();
// A home visit restores the new-task draft; it is not a request to discard work
// or interrupt an existing server-side run.
chat.prepareStart();
// Navigate on the accepted message, not on the later sessions-list refresh.
watch(
  () => (chat.messages.some((message) => message.role === 'user') ? chat.current?.id : null),
  async (id) => {
    if (!id) return;
    const origin = captureComposerOrigin();
    try {
      await router.push(`/agent/chat/${id}`);
      await nextTick();
      if (router.currentRoute.value.path === `/agent/chat/${id}` && chat.current?.id === id)
        animateComposerArrival(origin);
    } catch {
      // A failed or interrupted navigation must not affect the accepted turn.
    }
  },
);
</script>
<template>
  <main class="enterprise-page workbench-page">
    <div class="workbench-inner">
      <ConversationStart @submitted="(id) => router.push(`/agent/chat/${id}`)" />
    </div>
  </main>
</template>
