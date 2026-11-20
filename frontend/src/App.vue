<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlatform } from './stores/platform';
import { useConversation } from './stores/conversation';
import { sessionState } from './utils/presentation';
import Icon from './components/ForgeIcon.vue';
import DialogShell from './components/DialogShell.vue';
import AccountMenu from './components/AccountMenu.vue';
import AppFeedbackBridge from './components/AppFeedbackBridge.vue';
import LoginView from './views/LoginView.vue';
import { App as AntApp, ConfigProvider } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import { forgeDarkTheme, forgeLightTheme } from './theme/antd';

const app = usePlatform();
const chat = useConversation();
const route = useRoute();
const router = useRouter();
const help = ref(false);
const loggingOut = ref(false);
const managementOpen = ref(false);
const managementMenu = ref<HTMLElement | null>(null);
const adminRoutes = ['/agent/models', '/agent/governance', '/agent/runtime', '/agent/audit'];
// 主题外观：跟随系统 / 浅色 / 深色，三态循环，持久化到本地存储。
type ThemePreference = 'system' | 'light' | 'dark';
const THEME_STORAGE_KEY = 'forge-theme';
const themeOrder: ThemePreference[] = ['system', 'light', 'dark'];
const theme = ref<ThemePreference>(readStoredTheme());
function readStoredTheme(): ThemePreference {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}
function applyTheme() {
  if (theme.value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme.value;
  localStorage.setItem(THEME_STORAGE_KEY, theme.value);
}
const themeLabel = computed(() => ({ system: '跟随系统', light: '浅色', dark: '深色' })[theme.value]);
const themeIcon = computed(() => ({ system: 'panel', light: 'sun', dark: 'moon' })[theme.value]);
function cycleTheme() {
  const index = themeOrder.indexOf(theme.value);
  theme.value = themeOrder[(index + 1) % themeOrder.length];
  applyTheme();
}
applyTheme(); // 首帧渲染前落地，避免浅色闪烁。
// antd 组件主题跟随 Forge 明暗；'system' 时跟随操作系统偏好，并监听其变化。
const systemDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches);
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const syncSystemDark = (event: MediaQueryListEvent) => {
  systemDark.value = event.matches;
};
const isDark = computed(() => {
  if (theme.value === 'dark') return true;
  if (theme.value === 'light') return false;
  return systemDark.value;
});
const antdThemeConfig = computed(() => (isDark.value ? forgeDarkTheme : forgeLightTheme));
const isAdministration = computed(() => adminRoutes.includes(route.path));
const navigation = [
  { path: '/agent/workbench', label: '工作台', icon: 'home' },
  { path: '/agent/scenarios', label: '企业场景', icon: 'grid' },
  { path: '/agent/capabilities', label: '技能管理', icon: 'blocks' },
  { path: '/agent/conversations', label: '我的会话', icon: 'message' },
];
const management = [
  { path: '/agent/models', label: '模型连接', icon: 'cpu' },
  { path: '/agent/governance', label: '执行策略', icon: 'shield' },
  { path: '/agent/runtime', label: '运行状态', icon: 'server' },
  { path: '/agent/audit', label: '运行审计', icon: 'activity' },
];
function closeManagementMenu() {
  managementOpen.value = false;
}
function toggleManagementMenu() {
  managementOpen.value = !managementOpen.value;
}
function dismissManagementMenu(event: PointerEvent) {
  if (!managementOpen.value || !(event.target instanceof Node)) return;
  if (!managementMenu.value?.contains(event.target)) closeManagementMenu();
}
function handleNavigationKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeManagementMenu();
}
watch(
  () => route.path,
  () => closeManagementMenu(),
);
function newChat() {
  if (chat.requestNewConversation()) void router.push('/agent/chat');
}
function discardAndStart() {
  const pending = chat.pendingNewConversation;
  if (!pending) return;
  chat.newConversation(pending.scenarioId);
  void router.push('/agent/chat');
}
function returnToDraft() {
  chat.pendingNewConversation = null;
  chat.prepareStart();
  void router.push('/agent/workbench');
}
async function logout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    help.value = false;
    chat.clear();
    await app.logout();
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    loggingOut.value = false;
  }
}
function protectDrafts(event: BeforeUnloadEvent) {
  if (!app.authenticated || !chat.hasUnsentDrafts) return;
  // Drafts deliberately stay in tab memory. Let the browser warn before a refresh
  // or a cross-site navigation discards them; no business text enters storage.
  event.preventDefault();
  event.returnValue = '';
}
const unauthorized = () => {
  help.value = false;
  app.authenticated = false;
  chat.clear();
};
let timer: ReturnType<typeof setInterval> | null = null;
let sessionTimer: ReturnType<typeof setInterval> | null = null;
let sessionRefreshPending = false;
onMounted(async () => {
  window.addEventListener('forge:unauthorized', unauthorized);
  window.addEventListener('beforeunload', protectDrafts);
  window.addEventListener('pointerdown', dismissManagementMenu);
  window.addEventListener('keydown', handleNavigationKeydown);
  darkQuery.addEventListener('change', syncSystemDark);
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
  window.removeEventListener('beforeunload', protectDrafts);
  window.removeEventListener('pointerdown', dismissManagementMenu);
  window.removeEventListener('keydown', handleNavigationKeydown);
  darkQuery.removeEventListener('change', syncSystemDark);
  chat.disconnect();
});
</script>
<template>
  <ConfigProvider :theme="antdThemeConfig" :locale="zhCN">
    <AntApp>
      <AppFeedbackBridge />
      <div v-if="app.authLoading" class="app-boot">
        <span class="loader"></span><span>正在连接企业平台…</span>
      </div>
      <LoginView v-else-if="!app.authenticated" />
      <div v-else class="app-shell enterprise-shell">
        <a href="#main-content" class="skip-link">跳至主要内容</a>
        <aside id="enterprise-navigation" class="enterprise-sidebar" aria-label="企业平台导航">
          <div class="enterprise-brand-row">
            <RouterLink to="/agent/workbench" class="enterprise-brand" aria-label="Forge 企业工作台">
              <span class="brand-mark"><Icon name="layers" :size="23" /></span>
              <span
                ><strong>forge<span>.</span></strong
                ><small>企业智能体平台</small></span
              >
            </RouterLink>
          </div>
          <button class="enterprise-new-chat" @click="newChat">
            <Icon name="plus" :size="18" /><span>新建会话</span><Icon name="edit" :size="15" />
          </button>
          <div class="enterprise-sidebar-content">
            <nav class="primary-navigation enterprise-primary" aria-label="主导航">
              <RouterLink
                v-for="item in navigation"
                :key="item.path"
                :to="item.path"
                :aria-label="item.label"
                :class="{
                  'is-active':
                    route.path === item.path ||
                    (item.path === '/agent/conversations' && route.path.startsWith('/agent/chat')) ||
                    (item.path === '/agent/capabilities' &&
                      route.path.startsWith('/agent/capabilities/')),
                }"
              >
                <Icon :name="item.icon" :size="19" /><span>{{ item.label }}</span>
                <span
                  v-if="item.path === '/agent/scenarios' && app.availableScenarios.length"
                  class="nav-count"
                  >{{ app.availableScenarios.length }}</span
                >
              </RouterLink>
            </nav>
            <div class="enterprise-recent-heading">最近会话</div>
            <div class="enterprise-recents">
              <div v-if="!app.regularConversations.length" class="enterprise-recent-empty">
                <p>开始对话，记录会留在这里。</p>
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
          </div>
          <div class="enterprise-sidebar-footer">
            <section ref="managementMenu" class="enterprise-management-nav" aria-label="平台管理">
              <button
                type="button"
                :class="['enterprise-management-link', { selected: isAdministration }]"
                :aria-expanded="managementOpen"
                aria-controls="platform-management-menu"
                aria-haspopup="true"
                @click="toggleManagementMenu"
              >
                <Icon name="settings" :size="18" /><span>平台管理</span
                ><Icon name="chevronDown" :size="14" class="management-chevron" />
              </button>
              <Transition name="management-menu">
                <nav
                  v-if="managementOpen"
                  id="platform-management-menu"
                  class="enterprise-management-popover"
                  aria-label="平台管理页面"
                >
                  <span class="enterprise-management-popover-title">平台管理</span>
                  <RouterLink
                    v-for="item in management"
                    :key="item.path"
                    :to="item.path"
                    :class="{ selected: route.path === item.path }"
                    @click="closeManagementMenu"
                  >
                    <Icon :name="item.icon" :size="16" /><span>{{ item.label }}</span>
                  </RouterLink>
                </nav>
              </Transition>
            </section>
            <button
              class="enterprise-theme-link"
              type="button"
              aria-label="切换主题"
              :title="`主题：${themeLabel}`"
              @click="cycleTheme"
            >
              <Icon :name="themeIcon" :size="18" /><span>主题</span
              ><span class="theme-state">{{ themeLabel }}</span>
            </button>
            <button
              class="enterprise-help-link"
              aria-label="使用帮助"
              aria-haspopup="dialog"
              :aria-expanded="help"
              @click="help = true"
            >
              <Icon name="book" :size="18" /><span>帮助</span>
            </button>
            <AccountMenu :username="app.user?.username ?? ''" :busy="loggingOut" @logout="logout" />
          </div>
        </aside>
        <div class="app-body enterprise-body">
          <div v-if="app.loading" class="global-progress"></div>
          <div id="main-content" class="enterprise-view" tabindex="-1"><RouterView /></div>
        </div>
        <DialogShell
          v-if="chat.pendingNewConversation"
          label="新建会话确认"
          variant="modal"
          panel-class="confirm-modal draft-replacement-dialog"
          @close="chat.pendingNewConversation = null"
        >
          <h2>还有一份未发送的工作草稿</h2>
          <p>新建会话会清空这份起始草稿和附件。你也可以返回草稿继续编辑；已有会话中的回复草稿不受影响。</p>
          <p v-if="chat.sending">已经被服务端接收的请求，不会因新建会话而中止。</p>
          <footer>
            <button class="button secondary" @click="chat.pendingNewConversation = null">取消</button>
            <button class="button secondary" @click="returnToDraft">返回草稿</button>
            <button class="button primary" @click="discardAndStart">放弃草稿并新建</button>
          </footer>
        </DialogShell>
        <DialogShell v-if="help" label="使用帮助" panel-class="enterprise-guide" @close="help = false">
          <header>
            <div>
              <h2>使用帮助</h2>
              <p>从提交任务到查看结果，按需了解操作。</p>
            </div>
            <button class="icon-button" aria-label="关闭帮助面板" @click="help = false">
              <Icon name="close" :size="21" />
            </button>
          </header>
          <div class="drawer-body">
            <div class="guide-step">
              <span>01</span>
              <div>
                <h3>提交一项工作</h3>
                <p>
                  在工作台描述目标、已有信息和期望结果；需要时附上文本资料。模型未连接时，先由管理员完成连接配置。
                </p>
                <div class="guide-links">
                  <RouterLink to="/agent/workbench" class="text-link" @click="help = false"
                    >前往工作台 <Icon name="arrow" :size="14"
                  /></RouterLink>
                  <RouterLink to="/agent/models" class="text-link" @click="help = false"
                    >配置模型连接 <Icon name="arrow" :size="14"
                  /></RouterLink>
                </div>
              </div>
            </div>
            <div class="guide-step">
              <span>02</span>
              <div>
                <h3>引用场景与公共能力</h3>
                <p>
                  选择已发布或预置场景，复用工作规范和授权工具。公共能力无需重复安装，具体可用状态以能力中心为准。
                </p>
                <div class="guide-links">
                  <RouterLink to="/agent/scenarios" class="text-link" @click="help = false"
                    >查看企业场景 <Icon name="arrow" :size="14"
                  /></RouterLink>
                  <RouterLink to="/agent/capabilities" class="text-link" @click="help = false"
                    >浏览能力中心 <Icon name="arrow" :size="14"
                  /></RouterLink>
                </div>
              </div>
            </div>
            <div class="guide-step">
              <span>03</span>
              <div>
                <h3>查看结果与文件</h3>
                <p>
                  生成的文件直接保存到会话目录；插件的写操作仍会请你确认。通过会话工具栏打开结果、文件和执行过程；轮次结束不等于业务目标已完成。
                </p>
              </div>
            </div>
            <div class="guide-step">
              <span>04</span>
              <div>
                <h3>找回并继续会话</h3>
                <p>在我的会话中搜索记录、补充要求，或回看已有回复和文件。归档只收起记录，不删除审计证据。</p>
                <RouterLink to="/agent/conversations" class="text-link" @click="help = false"
                  >查看我的会话 <Icon name="arrow" :size="14"
                /></RouterLink>
              </div>
            </div>
            <div class="guide-administration">
              <Icon name="info" :size="17" />
              <div>
                <p>模型连接、执行策略及当前部署限制，统一在平台管理中查看。</p>
                <RouterLink to="/agent/models" class="text-link" @click="help = false"
                  >打开模型连接 <Icon name="arrow" :size="14"
                /></RouterLink>
              </div>
            </div>
          </div>
          <footer><button class="button primary" @click="help = false">关闭帮助</button></footer>
        </DialogShell>
      </div>
    </AntApp>
  </ConfigProvider>
</template>
