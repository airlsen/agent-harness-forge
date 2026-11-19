<script setup lang="ts">
import { watch } from 'vue';
import { useRouter } from 'vue-router';
import { useConversation } from '../../../stores/conversation';
import ConversationStart from '../../../components/ConversationStart.vue';

const router = useRouter();
const chat = useConversation();
// A home visit restores the new-task draft; it is not a request to discard work
// or interrupt an existing server-side run.
chat.prepareStart();
// Navigate on the accepted message, not on the later sessions-list refresh.
watch(
  () => (chat.messages.some((message) => message.role === 'user') ? chat.current?.id : null),
  (id) => {
    if (id) void router.push(`/agent/chat/${id}`);
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
