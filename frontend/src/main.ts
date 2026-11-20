import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Workbench from './views/agent/session/WorkbenchView.vue';
import ChatWorkspace from './views/agent/session/AgentChat.vue';
import ConversationCenter from './views/agent/session/ConversationCenter.vue';
import ScenarioCenter from './views/agent/scenario/ScenarioCenter.vue';
import CapabilityCenter from './views/agent/capability/CapabilityCenter.vue';
import ModelCenter from './views/agent/admin/ModelCenter.vue';
import GovernanceCenter from './views/agent/admin/GovernanceCenter.vue';
import RuntimeStatus from './views/agent/admin/RuntimeStatus.vue';
import AuditCenter from './views/agent/admin/AuditCenter.vue';
import SkillCenter from './views/agent/capability/SkillCenter.vue';
import SkillEditor from './views/agent/capability/SkillEditor.vue';
import PublishedSkillView from './views/agent/capability/PublishedSkillView.vue';
import TrajectoryView from './views/agent/session/TrajectoryView.vue';
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
    { path: '/agent/capabilities', component: CapabilityCenter, meta: { title: '技能管理' } },
    { path: '/agent/capabilities/skills/:id', component: PublishedSkillView, meta: { title: '已发布技能' } },
    { path: '/agent/skills', component: SkillCenter, meta: { title: '我的技能' } },
    { path: '/agent/skills/new', component: SkillEditor, meta: { title: '新建 Skill' } },
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
