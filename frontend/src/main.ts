import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Workbench from './views/agent/WorkbenchView.vue';
import ChatWorkspace from './views/agent/AgentChat.vue';
import ConversationCenter from './views/agent/ConversationCenter.vue';
import ScenarioCenter from './views/agent/ScenarioCenter.vue';
import CapabilityCenter from './views/agent/CapabilityCenter.vue';
import ManagementHome from './views/agent/ManagementHome.vue';
import ModelCenter from './views/agent/ModelCenter.vue';
import GovernanceCenter from './views/agent/GovernanceCenter.vue';
import AuditCenter from './views/agent/AuditCenter.vue';
import TrajectoryView from './views/agent/TrajectoryView.vue';
import './style.css';
import './enterprise.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/agent/workbench' },
    { path: '/agent', redirect: '/agent/workbench' },
    { path: '/agent/workbench', component: Workbench, meta: { title: '工作台' } },
    { path: '/agent/chat/:sessionId?', component: ChatWorkspace, meta: { title: '会话' } },
    { path: '/agent/conversations', component: ConversationCenter, meta: { title: '我的会话' } },
    { path: '/agent/scenarios', component: ScenarioCenter, meta: { title: '企业场景' } },
    { path: '/agent/capabilities', component: CapabilityCenter, meta: { title: '企业能力中心' } },
    { path: '/agent/manage', component: ManagementHome, meta: { title: '平台管理' } },
    { path: '/agent/models', component: ModelCenter, meta: { title: '模型连接' } },
    { path: '/agent/governance', component: GovernanceCenter, meta: { title: '企业策略' } },
    { path: '/agent/audit', component: AuditCenter, meta: { title: '运行审计' } },
    { path: '/agent/trajectory/:sessionId', component: TrajectoryView, meta: { title: '执行过程' } },
    { path: '/:pathMatch(.*)*', redirect: '/agent/workbench' },
  ],
});
router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '企业平台')} · Forge`;
});
createApp(App).use(createPinia()).use(router).mount('#app');
