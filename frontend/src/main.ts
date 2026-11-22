import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Workbench from './views/workbench/WorkbenchView.vue';
import ChatWorkspace from './views/conversation/AgentChat.vue';
import ConversationCenter from './views/conversation/ConversationCenter.vue';
import ScenarioCenter from './views/scenario/ScenarioCenter.vue';
import CapabilityCenter from './views/capability/CapabilityCenter.vue';
import ModelCenter from './views/model/ModelCenter.vue';
import GovernanceCenter from './views/governance/GovernanceCenter.vue';
import RuntimeStatus from './views/monitor/RuntimeStatus.vue';
import AuditCenter from './views/monitor/AuditCenter.vue';
import SkillCenter from './views/skill/SkillCenter.vue';
import SkillEditor from './views/skill/SkillEditor.vue';
import PublishedSkillView from './views/capability/PublishedSkillView.vue';
import PluginDetailView from './views/capability/PluginDetailView.vue';
import TrajectoryView from './views/conversation/TrajectoryView.vue';
import SpaceCenter from './views/space/SpaceCenter.vue';
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
    { path: '/agent/capabilities/plugins/:id', component: PluginDetailView, meta: { title: '插件详情' } },
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
    { path: '/agent/spaces', component: SpaceCenter, meta: { title: '空间管理' } },
    { path: '/agent/trajectory/:sessionId', component: TrajectoryView, meta: { title: '执行过程' } },
    { path: '/:pathMatch(.*)*', redirect: '/agent/workbench' },
  ],
});
router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '企业平台')} · Forge`;
});
createApp(App).use(createPinia()).use(router).mount('#app');
