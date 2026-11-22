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
// 发送即进入对话页：消息先显示（「正在准备…」），会话受理后对话页再把地址换成会话编号。
watch(
  () => Boolean(chat.outgoing && !chat.outgoing.failed && !chat.current),
  async (sending) => {
    if (!sending) return;
    const origin = captureComposerOrigin();
    try {
      await router.push('/agent/chat');
      await nextTick();
      if (router.currentRoute.value.path === '/agent/chat') animateComposerArrival(origin);
    } catch {
      // 跳转失败不影响正在提交的消息；受理后下面的监听仍会进入会话。
    }
  },
);
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
