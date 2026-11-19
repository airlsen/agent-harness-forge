import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Workbench from './views/agent/WorkbenchView.vue';
import ChatWorkspace from './views/agent/AgentChat.vue';
import ConversationCenter from './views/agent/ConversationCenter.vue';
import ScenarioCenter from './views/agent/ScenarioCenter.vue';
import CapabilityCenter from './views/agent/CapabilityCenter.vue';
import ModelCenter from './views/agent/ModelCenter.vue';
import GovernanceCenter from './views/agent/GovernanceCenter.vue';
import RuntimeStatus from './views/agent/RuntimeStatus.vue';
import AuditCenter from './views/agent/AuditCenter.vue';
import SkillCenter from './views/agent/SkillCenter.vue';
import SkillCreate from './views/agent/SkillCreate.vue';
import SkillEditor from './views/agent/SkillEditor.vue';
import TrajectoryView from './views/agent/TrajectoryView.vue';
import './style.css';
import './enterprise.css';
import './styles/tokens.scss';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/agent/workbench' },
    { path: '/agent', redirect: '/agent/workbench' },
    { path: '/agent/workbench', component: Workbench, meta: { title: '工作台' } },
    { path: '/agent/chat/:sessionId?', component: ChatWorkspace, meta: { title: '会话' } },
    { path: '/agent/conversations', component: ConversationCenter, meta: { title: '我的会话' } },
    { path: '/agent/scenarios', component: ScenarioCenter, meta: { title: '企业场景' } },
    { path: '/agent/capabilities', component: CapabilityCenter, meta: { title: '能力管理' } },
    { path: '/agent/skills', component: SkillCenter, meta: { title: 'Skill 库' } },
    { path: '/agent/skills/new', component: SkillCreate, meta: { title: '新建 Skill' } },
    { path: '/agent/skills/:id', component: SkillEditor, meta: { title: 'Skill 工作台' } },
    // The former overview only duplicated navigation. Keep its URL as a stable entry point,
    // but take administrators straight to the first actionable settings page.
    { path: '/agent/manage', redirect: '/agent/models' },
    { path: '/agent/models', component: ModelCenter, meta: { title: '模型连接' } },
    { path: '/agent/governance', component: GovernanceCenter, meta: { title: '执行策略' } },
    { path: '/agent/runtime', component: RuntimeStatus, meta: { title: '运行状态' } },
    { path: '/agent/audit', component: AuditCenter, meta: { title: '运行审计' } },
    { path: '/agent/trajectory/:sessionId', component: TrajectoryView, meta: { title: '执行过程' } },
    { path: '/:pathMatch(.*)*', redirect: '/agent/workbench' },
  ],
});
router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '企业平台')} · Forge`;
});
createApp(App).use(createPinia()).use(router).mount('#app');
