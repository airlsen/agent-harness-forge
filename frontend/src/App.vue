<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlatform } from './stores/platform';
import { useConversation } from './stores/conversation';
import { remove } from './api/client';
import Icon from './components/ForgeIcon.vue';
import LoginView from './views/LoginView.vue';
const app = usePlatform(),
  chat = useConversation(),
  route = useRoute(),
  router = useRouter();
const navigation = [
  { path: '/agent/chat', label: 'Agent 工作台', icon: 'message' },
  { path: '/agent/scenarios', label: '场景中心', icon: 'grid' },
  { path: '/agent/capabilities', label: '能力中心', icon: 'blocks' },
  { path: '/agent/models', label: '模型中心', icon: 'cpu' },
];
function newChat() {
  chat.newConversation();
  chat.input = '';
  chat.draftAttachments = [];
  void router.push('/agent/chat');
}
async function archive(id: number) {
  try {
    await remove(`/agent/sessions/${id}`);
    await app.refreshSessions();
    if (chat.current?.id === id) newChat();
    app.toast('会话已归档，消息与审计记录仍保留');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
}
async function logout() {
  try {
    chat.newConversation();
    chat.input = '';
    chat.draftAttachments = [];
    await app.logout();
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
}
const unauthorized = () => {
  app.authenticated = false;
  chat.disconnect();
};
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(async () => {
  window.addEventListener('forge:unauthorized', unauthorized);
  try {
    await app.checkAuth();
    if (app.authenticated) await app.initialize();
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
  timer = setInterval(() => {
    if (app.authenticated) void app.refreshRuntime().catch(() => {});
  }, 20000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  window.removeEventListener('forge:unauthorized', unauthorized);
  chat.disconnect();
});
</script>
<template>
  <div v-if="app.authLoading" class="app-boot">
    <span class="loader"></span><span>正在连接 Forge 工作空间…</span>
  </div>
  <LoginView v-else-if="!app.authenticated" />
  <div v-else class="app-shell">
    <aside class="app-sidebar">
      <RouterLink to="/agent/chat" class="brand"
        ><span class="forge-symbol"><i></i><i></i><i></i><i></i></span
        ><span>forge<span class="brand-period">.</span></span
        ><small>WORKSPACE</small></RouterLink
      >
      <div class="workspace-selector">
        <span class="workspace-avatar">F</span>
        <div><strong>Forge Workspace</strong><small>我的工作空间</small></div>
        <span class="workspace-label">DEV</span>
      </div>
      <button class="new-chat-button" @click="newChat">
        <Icon name="plus" :size="18" /><span>新建会话</span><span class="shortcut">＋</span>
      </button>
      <nav class="primary-navigation" aria-label="工作空间导航">
        <RouterLink
          v-for="item in navigation"
          :key="item.path"
          :to="item.path"
          :class="{ 'is-active': route.path.startsWith(item.path) }"
          :aria-label="item.label"
          ><Icon :name="item.icon" :size="19" /><span>{{ item.label }}</span
          ><span v-if="item.path === '/agent/scenarios' && app.scenarios.length" class="nav-count">{{
            app.scenarios.length
          }}</span></RouterLink
        >
      </nav>
      <div class="sidebar-section-title"><span>最近会话</span><Icon name="clock" :size="13" /></div>
      <div class="recent-conversations">
        <div v-if="!app.conversations.length" class="sidebar-empty">你的第一项任务，从这里开始。</div>
        <div
          v-for="item in app.conversations.slice(0, 10)"
          :key="item.id"
          :class="['recent-item', { selected: route.params.sessionId === String(item.id) }]"
        >
          <RouterLink :to="`/agent/chat/${item.id}`" :title="item.title"
            ><span v-if="item.status === 'running'" class="dot pulse"></span
            ><Icon v-else name="message" :size="14" /><span>{{ item.title }}</span></RouterLink
          ><button :aria-label="`归档会话 ${item.title}`" title="归档会话" @click="archive(item.id)">
            <Icon name="archive" :size="13" />
          </button>
        </div>
      </div>
      <div class="sidebar-bottom">
        <RouterLink
          to="/agent/audit"
          aria-label="审计中心"
          :class="{ selected: route.path === '/agent/audit' }"
          ><Icon name="activity" :size="17" /><span>审计中心</span></RouterLink
        ><RouterLink
          to="/agent/governance"
          aria-label="治理与设置"
          :class="{ selected: route.path === '/agent/governance' }"
          ><Icon name="settings" :size="17" /><span>治理与设置</span></RouterLink
        >
        <div class="profile-row">
          <span class="profile-avatar">{{ app.user?.name.slice(0, 1) }}</span>
          <div>
            <strong>{{ app.user?.name }}</strong><small>工作空间管理员</small>
          </div>
          <button aria-label="退出登录" title="退出登录" @click="logout">
            <Icon name="logout" :size="17" />
          </button>
        </div>
      </div>
    </aside>
    <div class="app-body">
      <header class="app-topbar">
        <div class="breadcrumbs">
          <span>工作空间</span><Icon name="chevron" :size="13" /><strong>{{ route.meta.title }}</strong>
        </div>
        <div class="topbar-actions">
          <span class="environment-label"><span class="dot neutral"></span>开发环境</span
          ><span :class="['runtime-indicator', { disconnected: app.runtime?.runner.status !== 'online' }]"
            ><span class="dot"></span
            >{{ app.runtime?.runner.status === 'online' ? '执行内核在线' : '执行内核离线' }}</span
          ><button
            class="icon-button"
            aria-label="模型设置"
            title="模型设置"
            @click="router.push('/agent/models')"
          >
            <Icon name="sliders" :size="18" /></button
          ><span class="topbar-avatar">D</span>
        </div>
      </header>
      <div v-if="app.loading" class="global-progress"></div>
      <RouterView />
    </div>
  </div>
  <Transition name="toast"
    ><div v-if="app.notice" :class="['toast-message', app.notice.type]" role="alert">
      <Icon
        :name="app.notice.type === 'error' ? 'info' : app.notice.type === 'success' ? 'check' : 'info'"
        :size="17"
      /><span>{{ app.notice.message }}</span
      ><button aria-label="关闭提示" @click="app.notice = null"><Icon name="close" :size="15" /></button></div
  ></Transition>
</template>
