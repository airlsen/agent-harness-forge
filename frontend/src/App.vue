<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlatform } from './stores/platform';
import { useConversation } from './stores/conversation';
import { sessionState } from './utils/presentation';
import { trapTabKey } from './utils/focus';
import Icon from './components/ForgeIcon.vue';
import DialogShell from './components/DialogShell.vue';
import LoginView from './views/LoginView.vue';

const app = usePlatform();
const chat = useConversation();
const route = useRoute();
const router = useRouter();
const mobileNavigation = ref(false);
const compactMedia = window.matchMedia('(max-width: 900px)');
const compact = ref(compactMedia.matches);
const sidebar = ref<HTMLElement | null>(null);
let previousNavigationFocus: HTMLElement | null = null;
function resizeNavigation() {
  compact.value = compactMedia.matches;
  if (!compact.value) mobileNavigation.value = false;
}
watch(mobileNavigation, async (open) => {
  if (open) {
    previousNavigationFocus = document.activeElement as HTMLElement;
    await nextTick();
    sidebar.value?.focus();
  } else {
    await nextTick();
    if (previousNavigationFocus?.isConnected) previousNavigationFocus.focus();
  }
});
const help = ref(false);
const adminRoutes = ['/agent/manage', '/agent/models', '/agent/governance', '/agent/audit'];
const isAdministration = computed(() => adminRoutes.includes(route.path));
const navigation = [
  { path: '/agent/workbench', label: '工作台', icon: 'home' },
  { path: '/agent/scenarios', label: '企业场景', icon: 'grid' },
  { path: '/agent/capabilities', label: '企业能力中心', icon: 'blocks' },
  { path: '/agent/conversations', label: '我的会话', icon: 'message' },
];
const management = [
  { path: '/agent/manage', label: '管理概览', icon: 'settings' },
  { path: '/agent/models', label: '模型连接', icon: 'cpu' },
  { path: '/agent/governance', label: '企业策略', icon: 'shield' },
  { path: '/agent/audit', label: '运行审计', icon: 'activity' },
];
const avatar = computed(() => app.user?.username?.slice(0, 1)?.toUpperCase() || 'A');
function newChat() {
  chat.newConversation();
  void router.push('/agent/chat');
  mobileNavigation.value = false;
}
async function logout() {
  try {
    chat.newConversation();
    await app.logout();
    mobileNavigation.value = false;
  } catch (error) {
    app.toast((error as Error).message, 'error');
  }
}
const unauthorized = () => {
  app.authenticated = false;
  chat.disconnect();
  mobileNavigation.value = false;
};
function keyboard(event: KeyboardEvent) {
  if (mobileNavigation.value) {
    if (event.key === 'Escape') mobileNavigation.value = false;
    trapTabKey(event, sidebar.value);
  }
}
watch(
  () => route.fullPath,
  () => {
    mobileNavigation.value = false;
  },
);
let timer: ReturnType<typeof setInterval> | null = null;
let sessionTimer: ReturnType<typeof setInterval> | null = null;
let sessionRefreshPending = false;
onMounted(async () => {
  window.addEventListener('forge:unauthorized', unauthorized);
  window.addEventListener('keydown', keyboard);
  compactMedia.addEventListener('change', resizeNavigation);
  try {
    await app.checkAuth();
    if (app.authenticated) await app.initialize();
  } catch (error) {
    app.toast((error as Error).message, 'error');
  }
  timer = setInterval(() => {
    if (app.authenticated) void app.refreshRuntime().catch(() => {});
  }, 20000);
  // Leaving the execution page closes its SSE reader, not the backend task.
  // Refresh only while known runs exist so lists/recents settle without a reload.
  sessionTimer = setInterval(() => {
    if (
      !app.authenticated ||
      sessionRefreshPending ||
      !app.regularConversations.some((item) => item.status === 'running')
    )
      return;
    sessionRefreshPending = true;
    void app
      .refreshSessions()
      .catch(() => {})
      .finally(() => {
        sessionRefreshPending = false;
      });
  }, 3000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  if (sessionTimer) clearInterval(sessionTimer);
  window.removeEventListener('forge:unauthorized', unauthorized);
  window.removeEventListener('keydown', keyboard);
  compactMedia.removeEventListener('change', resizeNavigation);
  chat.disconnect();
});
</script>
<template>
  <div v-if="app.authLoading" class="app-boot">
    <span class="loader"></span><span>正在连接企业平台…</span>
  </div>
  <LoginView v-else-if="!app.authenticated" />
  <div v-else class="app-shell enterprise-shell">
    <a href="#main-content" class="skip-link">跳至主要内容</a>
    <button
      v-if="mobileNavigation"
      class="mobile-navigation-backdrop"
      aria-label="关闭导航"
      @click="mobileNavigation = false"
    ></button>
    <aside
      id="enterprise-navigation"
      ref="sidebar"
      :inert="compact && !mobileNavigation"
      :role="compact && mobileNavigation ? 'dialog' : undefined"
      :aria-modal="compact && mobileNavigation ? true : undefined"
      tabindex="-1"
      :class="['enterprise-sidebar', { 'is-open': mobileNavigation }]"
      aria-label="企业平台导航"
    >
      <div class="enterprise-brand-row">
        <RouterLink to="/agent/workbench" class="enterprise-brand" aria-label="Forge 企业工作台">
          <span class="brand-mark"><Icon name="layers" :size="23" /></span>
          <span
            ><strong>forge<span>.</span></strong
            ><small>企业智能体平台</small></span
          >
        </RouterLink>
        <button class="icon-button mobile-nav-close" aria-label="收起导航" @click="mobileNavigation = false">
          <Icon name="close" :size="20" />
        </button>
      </div>
      <button class="enterprise-new-chat" @click="newChat">
        <Icon name="plus" :size="18" /><span>新建会话</span><Icon name="edit" :size="15" />
      </button>
      <nav class="primary-navigation enterprise-primary" aria-label="主导航">
        <RouterLink
          v-for="item in navigation"
          :key="item.path"
          :to="item.path"
          :aria-label="item.label"
          :class="{
            'is-active':
              route.path === item.path ||
              (item.path === '/agent/conversations' && route.path.startsWith('/agent/chat')),
          }"
        >
          <Icon :name="item.icon" :size="19" /><span>{{ item.label }}</span>
          <span v-if="item.path === '/agent/scenarios' && app.availableScenarios.length" class="nav-count">{{
            app.availableScenarios.length
          }}</span>
        </RouterLink>
      </nav>
      <div class="enterprise-recent-heading">
        <span>最近会话</span
        ><RouterLink to="/agent/conversations" aria-label="查看全部会话" title="查看全部会话"
          ><Icon name="arrow" :size="14"
        /></RouterLink>
      </div>
      <div class="enterprise-recents">
        <div v-if="!app.regularConversations.length" class="enterprise-recent-empty">
          <span></span>
          <p>还没有会话记录<br /><small>从一项具体工作开始。</small></p>
        </div>
        <div
          v-for="item in app.regularConversations.slice(0, 6)"
          :key="item.id"
          :class="[
            'recent-item',
            'enterprise-recent-item',
            { selected: route.params.sessionId === String(item.id) },
          ]"
        >
          <RouterLink
            :to="`/agent/chat/${item.id}`"
            :title="`${item.title} · ${sessionState(item.status).label}`"
            ><span v-if="item.status === 'running'" class="dot pulse"></span
            ><Icon v-else :name="sessionState(item.status).icon" :size="14" /><span>{{
              item.title
            }}</span></RouterLink
          >
        </div>
      </div>
      <div class="enterprise-sidebar-footer">
        <RouterLink
          to="/agent/manage"
          :class="['enterprise-management-link', { selected: isAdministration }]"
          aria-label="平台管理"
          ><Icon name="settings" :size="18" /><span>平台管理</span><Icon name="chevron" :size="14"
        /></RouterLink>
        <div class="enterprise-profile">
          <span class="enterprise-avatar">{{ avatar }}</span>
          <div>
            <strong>{{ app.user?.username }}</strong><small>当前管理员账号</small>
          </div>
          <button class="icon-button" aria-label="退出登录" title="退出登录" @click="logout">
            <Icon name="logout" :size="17" />
          </button>
        </div>
      </div>
    </aside>
    <div class="app-body enterprise-body" :inert="compact && mobileNavigation">
      <header class="enterprise-topbar">
        <div class="enterprise-breadcrumb">
          <button
            class="icon-button mobile-nav-toggle"
            aria-label="打开导航"
            :aria-expanded="mobileNavigation"
            aria-controls="enterprise-navigation"
            @click="mobileNavigation = !mobileNavigation"
          >
            <Icon name="menu" :size="21" /></button
          ><span class="enterprise-breadcrumb-root"><Icon name="building" :size="15" />企业平台</span
          ><Icon class="breadcrumb-chevron" name="chevron" :size="12" /><strong>{{
            route.meta.title
          }}</strong>
        </div>
        <div class="enterprise-topbar-actions">
          <button class="preview-mode-badge" aria-label="查看版本与能力说明" @click="help = true">
            <span></span>单管理员预览<Icon name="info" :size="13" /></button
          ><span class="topbar-divider"></span
          ><button class="enterprise-help" aria-label="使用指南" @click="help = true">
            <Icon name="book" :size="16" /><span>使用指南</span>
          </button>
        </div>
      </header>
      <nav v-if="isAdministration" class="enterprise-admin-tabs" aria-label="平台管理导航">
        <RouterLink
          v-for="item in management"
          :key="item.path"
          :to="item.path"
          :class="{ selected: route.path === item.path }"
          ><Icon :name="item.icon" :size="16" />{{ item.label }}</RouterLink
        >
      </nav>
      <div v-if="app.loading" class="global-progress"></div>
      <div id="main-content" class="enterprise-view" tabindex="-1"><RouterView /></div>
    </div>
    <DialogShell v-if="help" label="企业平台使用指南" panel-class="enterprise-guide" @close="help = false">
      <header>
        <div>
          <div class="eyebrow">GETTING STARTED</div>
          <h2>一套企业能力，各自推进工作。</h2>
          <p>企业版前端 · 第一批</p>
        </div>
        <button class="icon-button" aria-label="关闭使用指南" @click="help = false">
          <Icon name="close" :size="21" />
        </button>
      </header>
      <div class="drawer-body">
        <div class="guide-step">
          <span>01</span>
          <div>
            <h3>从企业场景开始</h3>
            <p>浏览预置或已发布的场景，将提示词和可用工具带入新会话，不必重复配置。</p>
            <RouterLink to="/agent/scenarios" class="text-link" @click="help = false"
              >查看企业场景 <Icon name="arrow" :size="14"
            /></RouterLink>
          </div>
        </div>
        <div class="guide-step">
          <span>02</span>
          <div>
            <h3>发现公共能力</h3>
            <p>在能力中心了解工具用途和使用范围。当前仅接入基础工具；Skills、MCP 与通用插件管理尚未接入。</p>
            <RouterLink to="/agent/capabilities" class="text-link" @click="help = false"
              >浏览能力中心 <Icon name="arrow" :size="14"
            /></RouterLink>
          </div>
        </div>
        <div class="guide-step">
          <span>03</span>
          <div>
            <h3>在会话中完成与回看</h3>
            <p>补充要求、确认敏感操作，按需打开结果和过程。轮次结束表示可以继续，不代表业务目标已经完成。</p>
          </div>
        </div>
        <div class="release-boundary">
          <Icon name="info" :size="19" />
          <div>
            <strong>当前仍是单管理员业务预览</strong>
            <p>
              本批交付的是企业版前端结构。尚未接入员工身份、企业权限和跨员工会话隔离，请勿将共用管理员账号作为全员使用方案。
            </p>
          </div>
        </div>
      </div>
      <footer><button class="button primary" @click="help = false">了解，开始使用</button></footer>
    </DialogShell>
  </div>
  <Transition name="toast"
    ><div v-if="app.notice" :class="['toast-message', app.notice.type]" role="alert">
      <Icon :name="app.notice.type === 'success' ? 'check' : 'info'" :size="17" /><span>{{
        app.notice.message
      }}</span
      ><button aria-label="关闭提示" @click="app.notice = null"><Icon name="close" :size="15" /></button></div
  ></Transition>
</template>
