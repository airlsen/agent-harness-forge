import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import ChatWorkspace from './views/agent/AgentChat.vue';
import ScenarioCenter from './views/agent/ScenarioCenter.vue';
import CapabilityCenter from './views/agent/CapabilityCenter.vue';
import ModelCenter from './views/agent/ModelCenter.vue';
import GovernanceCenter from './views/agent/GovernanceCenter.vue';
import AuditCenter from './views/agent/AuditCenter.vue';
import TrajectoryView from './views/agent/TrajectoryView.vue';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/agent/chat' },
    { path: '/agent/chat/:sessionId?', component: ChatWorkspace, meta: { title: 'Agent 工作台' } },
    { path: '/agent/scenarios', component: ScenarioCenter, meta: { title: '场景中心' } },
    { path: '/agent/capabilities', component: CapabilityCenter, meta: { title: '能力中心' } },
    { path: '/agent/models', component: ModelCenter, meta: { title: '模型中心' } },
    { path: '/agent/governance', component: GovernanceCenter, meta: { title: '治理与设置' } },
    { path: '/agent/audit', component: AuditCenter, meta: { title: '审计中心' } },
    { path: '/agent/trajectory/:sessionId', component: TrajectoryView, meta: { title: '执行轨迹' } },
    { path: '/:pathMatch(.*)*', redirect: '/agent/chat' },
  ],
});
createApp(App).use(createPinia()).use(router).mount('#app');
