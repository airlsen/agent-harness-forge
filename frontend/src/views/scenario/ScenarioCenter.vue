<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import type { Rule } from 'ant-design-vue/es/form';
import type { MenuInfo } from 'ant-design-vue/es/menu/src/interface';
import { usePlatform } from '../../stores/platform';
import { MAX_SESSION_MCP, MAX_SESSION_SKILLS, useConversation } from '../../stores/conversation';
import { api, post, put, remove } from '../../api/client';
import { formatDate } from '../../utils/common/format';
import { isAvailableScenario, scenarioSource, scenarioState } from '../../utils/conversation/sessionState';
import { catalogDate, orderScenarios, scenarioPublished } from '../../utils/common/catalogOrdering';
import type {
  CapabilityOptions,
  Scenario,
  ScenarioGenerateField,
  ScenarioGenerateResult,
  ScenarioPayload,
} from '../../types/platform';
import type { PluginPackage } from '../../types/plugin';
import Icon from '../../components/base/ForgeIcon.vue';
import { drawerA11y } from '../../utils/common/overlay';
import CatalogCard from '../../components/catalog/CatalogCard.vue';
import { missingSkillInfo } from '../../utils/skill/lifecycle';
import CatalogEmpty from '../../components/catalog/CatalogEmpty.vue';
import CatalogFilter from '../../components/catalog/CatalogFilter.vue';
import CatalogGrid from '../../components/catalog/CatalogGrid.vue';
import CatalogSearch from '../../components/catalog/CatalogSearch.vue';
import SpaceTag from '../../components/space/SpaceTag.vue';
import SpaceMark from '../../components/space/SpaceMark.vue';
import MoveSpaceDialog from '../../components/space/MoveSpaceDialog.vue';
import { PUBLIC_SPACE_ID, useSpace } from '../../stores/space';
import { confirm } from '../../utils/common/feedback';

const app = usePlatform();
const chat = useConversation();
const space = useSpace();
const router = useRouter();
const route = useRoute();
const query = ref('');
const filter = ref('all');
const drawer = ref(false);
const editing = ref<Scenario | null>(null);
const basedOn = ref('');
// 弹层的开合状态与内容数据分开：关闭时只收起 antd 抽屉/对话框，内容保留到退场动画结束，避免闪空。
const detail = ref<Scenario | null>(null);
const detailOpen = ref(false);
const busy = ref(false);
const testing = ref<number | null>(null);
const toDelete = ref<Scenario | null>(null);
const deleteOpen = ref(false);
const deleting = ref(false);
const plugins = ref<PluginPackage[]>([]);
const pluginsLoading = ref(false);
const versionHistory = ref<
  | {
      version: number;
      createdAt: string;
      changeLog: string;
      bundleHash: string;
      payload: unknown;
      bundle?: unknown;
    }[]
  | null
>(null);
const historyTitle = ref('');
const historyOpen = ref(false);
const maintenance = computed(() => route.query.view === 'maintain');
const blank = (): ScenarioPayload => ({
  name: '',
  description: '',
  icon: 'sparkles',
  prompt_template: '',
  capabilities: {
    plugin_names: ['forge-runtime'],
    plugin_tools: {},
    builtin_tool_names: [],
    skill_ids: [],
    mcp_server_ids: [],
    project_ids: [],
    web_search: false,
  },
  model: 'default',
  execution_mode: 'standard',
});
const draft = reactive<ScenarioPayload>(blank());
const initialDraft = ref('');
const editorChanged = computed(
  () => JSON.stringify(draft) !== initialDraft.value || Boolean(aiRequirement.value.trim()),
);

// antd 表单校验规则：场景名称与提示词必填，描述选填。
const rules: Record<string, Rule[]> = {
  name: [
    { required: true, whitespace: true, message: '请填写场景名称' },
    { max: 128, message: '场景名称不能超过 128 个字符' },
  ],
  description: [{ max: 512, message: '一句话介绍不能超过 512 个字符' }],
  prompt_template: [{ required: true, whitespace: true, message: '请填写场景提示词' }],
};
const base = computed(() => (maintenance.value ? app.scenarios : app.availableScenarios));
const filters = computed(() => [
  { id: 'all', label: '全部', count: base.value.length },
  { id: 'template', label: '平台预置', count: base.value.filter((s) => s.status === 'template').length },
  { id: 'published', label: '已发布', count: base.value.filter((s) => s.status === 'published').length },
  ...(maintenance.value
    ? [{ id: 'draft', label: '维护草稿', count: base.value.filter((s) => s.status === 'draft').length }]
    : []),
]);
const filterOptions = computed(() =>
  filters.value.map((item) => ({ value: item.id, label: item.label, count: item.count })),
);
const filtered = computed(() =>
  orderScenarios(
    base.value.filter(
      (s) =>
        (filter.value === 'all' || s.status === filter.value) &&
        `${s.payload.name} ${s.payload.description}`.toLowerCase().includes(query.value.trim().toLowerCase()),
    ),
  ),
);
watch(maintenance, () => {
  filter.value = 'all';
});
function enterMaintenance() {
  filter.value = 'all';
  void router.replace({ query: { view: 'maintain' } });
}
async function loadPlugins() {
  if (pluginsLoading.value) return;
  pluginsLoading.value = true;
  try {
    plugins.value = (await api<{ items: PluginPackage[] }>('/registry/plugins')).items;
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    pluginsLoading.value = false;
  }
}
function normalizePayload(scenario?: Scenario): ScenarioPayload {
  if (!scenario) return blank();
  const source = JSON.parse(JSON.stringify(scenario.payload)) as Partial<ScenarioPayload>;
  return {
    ...blank(),
    ...source,
    capabilities: {
      ...blank().capabilities,
      ...source.capabilities,
      plugin_names: source.capabilities?.plugin_names ?? ['forge-runtime'],
      plugin_tools: source.capabilities?.plugin_tools ?? {},
    },
  };
}
/** 演示插件（如演示 CRM）只返回模拟数据，需在选择时明确标出 */
function demoPlugin(plugin: PluginPackage) {
  return plugin.source.includes('demo');
}

// Skill / MCP / 联网选项与聊天中的「扩展能力」同源：已发布 Skill、可运行的 MCP 服务、平台联网状态
const optionsLoading = ref(false);
async function loadCapabilityOptions() {
  if (optionsLoading.value) return;
  optionsLoading.value = true;
  try {
    await chat.loadCapabilityOptions();
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    optionsLoading.value = false;
  }
}
onMounted(() => void chat.loadCapabilityOptions().catch(() => {}));
function skillTitle(id: number) {
  const option = chat.capabilityOptions?.skills.find((skill) => skill.id === id);
  if (option || !chat.capabilityOptions) return option?.title ?? `Skill #${id}`;
  // 已下线或已删除：标签上写明，提醒在场景中移除
  const missing = missingSkillInfo(chat.capabilityOptions, id);
  return `${missing.title}（${missing.reason}）`;
}
function serverTitle(id: number) {
  return chat.capabilityOptions?.mcpServers.find((server) => server.id === id)?.name ?? `MCP #${id}`;
}
/** 场景卡片与详情中的扩展能力标签 */
function extensionLabels(payload: ScenarioPayload) {
  const caps = payload.capabilities;
  return [
    ...(caps.skill_ids ?? []).map((id) => ({ key: `skill-${id}`, icon: 'book', label: skillTitle(id) })),
    ...(caps.mcp_server_ids ?? []).map((id) => ({ key: `mcp-${id}`, icon: 'plug', label: serverTitle(id) })),
    ...(caps.web_search ? [{ key: 'web', icon: 'globe', label: '联网搜索' }] : []),
  ];
}
function cardLabels(payload: ScenarioPayload) {
  const plugins = payload.capabilities.plugin_names.filter((name) => name !== 'forge-runtime');
  return [
    ...extensionLabels(payload),
    ...plugins.map((name) => ({ key: `plugin-${name}`, icon: 'blocks', label: name })),
  ];
}
/** 草稿中已绑定、但已下线、删除或停用的项：保存会被拒绝，需先移除 */
// 场景只能使用所在空间和公共空间的 Skill / MCP / 插件：新建时为当前空间，编辑时为场景所在空间
const editorSpaceId = computed(() => editing.value?.spaceId ?? space.currentId);
const editorSpace = computed(() => space.byId(editorSpaceId.value));
function inEditorSpace(spaceId?: number) {
  return !spaceId || spaceId === PUBLIC_SPACE_ID || spaceId === editorSpaceId.value;
}
const editorOptions = computed<CapabilityOptions | null>(() =>
  chat.capabilityOptions
    ? {
        ...chat.capabilityOptions,
        skills: chat.capabilityOptions.skills.filter((item) => inEditorSpace(item.spaceId)),
        mcpServers: chat.capabilityOptions.mcpServers.filter((item) => inEditorSpace(item.spaceId)),
      }
    : null,
);
const editorPlugins = computed(() => plugins.value.filter((item) => inEditorSpace(item.spaceId)));
/** 已绑定但用不了的 Skill：已下线 / 已删除 / 不在场景所在空间 */
function missingSkill(id: number): { title: string; reason: string } {
  const elsewhere = chat.capabilityOptions?.skills.find((item) => item.id === id);
  if (elsewhere) return { title: elsewhere.title, reason: '不在本空间' };
  return missingSkillInfo(chat.capabilityOptions, id);
}
const missingSkills = computed(() =>
  editorOptions.value
    ? draft.capabilities.skill_ids.filter((id) => !editorOptions.value?.skills.some((s) => s.id === id))
    : [],
);
const missingServers = computed(() =>
  editorOptions.value
    ? draft.capabilities.mcp_server_ids.filter(
        (id) => !editorOptions.value?.mcpServers.some((s) => s.id === id),
      )
    : [],
);
function toggleId(list: number[], id: number, enabled: boolean, limit: number, label: string) {
  const next = list.filter((item) => item !== id);
  if (enabled) {
    if (next.length >= limit) {
      app.toast(`一个场景最多绑定 ${limit} 个${label}`, 'error');
      return list;
    }
    next.push(id);
  }
  return next;
}
function setSkill(id: number, enabled: boolean) {
  draft.capabilities.skill_ids = toggleId(
    draft.capabilities.skill_ids,
    id,
    enabled,
    MAX_SESSION_SKILLS,
    ' Skill',
  );
}
function setServer(id: number, enabled: boolean) {
  draft.capabilities.mcp_server_ids = toggleId(
    draft.capabilities.mcp_server_ids,
    id,
    enabled,
    MAX_SESSION_MCP,
    ' MCP 服务',
  );
}
function pluginSelected(plugin: PluginPackage) {
  return draft.capabilities.plugin_names.includes(plugin.package);
}
function setPluginSelected(plugin: PluginPackage, enabled: boolean) {
  const selected = new Set(draft.capabilities.plugin_names);
  if (enabled) selected.add(plugin.package);
  else {
    selected.delete(plugin.package);
    delete draft.capabilities.plugin_tools[plugin.package];
  }
  selected.add('forge-runtime');
  draft.capabilities.plugin_names = [...selected];
}
function setPluginTool(plugin: PluginPackage, toolName: string, enabled: boolean) {
  const selected = new Set(draft.capabilities.plugin_tools[plugin.package] ?? []);
  if (enabled) selected.add(toolName);
  else selected.delete(toolName);
  draft.capabilities.plugin_tools[plugin.package] = [...selected];
}
function pluginToolSelected(plugin: PluginPackage, toolName: string) {
  return (draft.capabilities.plugin_tools[plugin.package] ?? []).includes(toolName);
}
function edit(scenario?: Scenario, sourceName = '') {
  editing.value = scenario ?? null;
  basedOn.value = sourceName;
  Object.assign(draft, normalizePayload(scenario));
  resetAi();
  initialDraft.value = JSON.stringify(draft);
  drawer.value = true;
  void loadPlugins();
  void loadCapabilityOptions();
}

// —— AI 生成：新建时按一句话需求生成整套配置；编辑时可整体优化，或在各项旁单独重新生成 ——
// 推荐的能力直接勾选到草稿中，保存前可随时调整或撤销；不会自动保存。
const aiRequirement = ref('');
const generating = ref<'all' | ScenarioGenerateField | null>(null);
const aiResult = ref<ScenarioGenerateResult | null>(null);
/** 最近一次 AI 修改前的草稿，用于「撤销 AI 修改」 */
const aiUndo = ref<ScenarioPayload | null>(null);
// 打开新的编辑器后，上一次尚未返回的生成结果作废
let aiRun = 0;
function resetAi() {
  aiRun += 1;
  aiRequirement.value = '';
  generating.value = null;
  aiResult.value = null;
  aiUndo.value = null;
}
const AI_FIELD_LABELS: Record<ScenarioGenerateField, string> = {
  name: '名称',
  description: '介绍',
  icon: '图标',
  prompt: '提示词',
  capabilities: '能力',
};
async function generate(fields: ScenarioGenerateField[] | null) {
  if (generating.value || busy.value) return;
  const run = aiRun;
  generating.value = fields?.length === 1 ? fields[0] : 'all';
  const snapshot = JSON.parse(JSON.stringify(draft)) as ScenarioPayload;
  try {
    const result = await post<ScenarioGenerateResult>('/agent-scenarios/generate', {
      requirement: aiRequirement.value.trim(),
      draft: snapshot,
      fields,
      scenarioId: editing.value?.id ?? null,
    });
    if (run !== aiRun) return;
    const next = result.draft;
    const applied = new Set(result.applied);
    if (applied.has('name')) draft.name = next.name;
    if (applied.has('description')) draft.description = next.description;
    if (applied.has('icon')) draft.icon = next.icon;
    if (applied.has('prompt')) draft.prompt_template = next.prompt_template;
    if (applied.has('capabilities')) draft.capabilities = { ...draft.capabilities, ...next.capabilities };
    aiUndo.value = snapshot;
    // 只重新生成了文字时，保留上一次的能力推荐理由与建议
    aiResult.value =
      applied.has('capabilities') || !aiResult.value
        ? result
        : { ...result, reasons: aiResult.value.reasons, missing: aiResult.value.missing };
    const parts = result.applied.map((field) => AI_FIELD_LABELS[field]).join('、');
    app.toast(
      applied.has('capabilities')
        ? `AI 已生成${parts}，推荐的能力已自动勾选，请检查后保存`
        : `AI 已更新${parts}，请检查后保存`,
    );
  } catch (error) {
    if (run === aiRun) app.toast((error as Error).message, 'error');
  } finally {
    if (run === aiRun) generating.value = null;
  }
}
function undoGenerate() {
  if (!aiUndo.value || generating.value) return;
  Object.assign(draft, aiUndo.value);
  aiUndo.value = null;
  aiResult.value = null;
  app.toast('已撤销 AI 修改');
}
/** 已勾选项的 AI 推荐理由（取消勾选后不再显示） */
function aiReason(key: string, selected: boolean) {
  return selected ? (aiResult.value?.reasons[key] ?? '') : '';
}
function openDetail(scenario: Scenario) {
  detail.value = scenario;
  detailOpen.value = true;
}
function editDetail() {
  if (!detail.value) return;
  if (detail.value.space === 'official') createFromTemplate(detail.value);
  else {
    const scenario = detail.value;
    detailOpen.value = false;
    edit(scenario);
  }
}
function hasPendingDraft(scenario: Scenario) {
  return scenario.published_version > 0 && scenario.current_version > scenario.published_version;
}
/** 自建场景试运行通过、有待发布内容时，卡片主操作是「发布」 */
function canPublish(scenario: Scenario) {
  return (
    scenario.space !== 'official' &&
    (!scenario.published_version || hasPendingDraft(scenario)) &&
    scenario.tested
  );
}
async function closeEditor() {
  if (busy.value || !drawer.value) return;
  if (
    editorChanged.value &&
    !(await confirm({
      title: '放弃未保存的场景修改？',
      content: '当前编辑的内容尚未保存。',
      okText: '放弃修改',
      cancelText: '继续编辑',
      danger: true,
    }))
  )
    return;
  // 关闭后尚未返回的 AI 结果不再写入
  aiRun += 1;
  generating.value = null;
  drawer.value = false;
}
onBeforeRouteLeave(async () => {
  if (!drawer.value) return true;
  if (busy.value) return false;
  if (!editorChanged.value) return true;
  return confirm({
    title: '离开并放弃场景修改？',
    content: '当前编辑的内容尚未保存。',
    okText: '放弃修改',
    cancelText: '继续编辑',
    danger: true,
  });
});
function askDelete(scenario: Scenario) {
  toDelete.value = scenario;
  deleteOpen.value = true;
}
/** 卡片「更多」下拉：查看、重新试运行、版本记录与删除 */
// 移动到其他空间
const moving = ref<Scenario | null>(null);
async function moved() {
  moving.value = null;
  await app.refreshScenarios();
}
function moreAction(key: string, scenario: Scenario) {
  if (key === 'move') moving.value = scenario;
  else if (key === 'detail') openDetail(scenario);
  else if (key === 'test') void test(scenario);
  else if (key === 'versions') void versions(scenario);
  else if (key === 'delete') askDelete(scenario);
}
function cancelDelete() {
  if (!deleting.value) deleteOpen.value = false;
}
function useScenario(scenario: Scenario) {
  detailOpen.value = false;
  if (chat.requestNewConversation(scenario.id)) void router.push('/agent/chat');
}
async function save() {
  if (busy.value || generating.value) return;
  busy.value = true;
  try {
    const payload = { ...draft, name: draft.name.trim() };
    if (editing.value) await put(`/agent-scenarios/${editing.value.id}`, payload);
    else await post('/agent-scenarios', payload);
    await app.refreshScenarios();
    drawer.value = false;
    filter.value = editing.value?.published_version ? 'published' : 'draft';
    app.toast(
      editing.value?.published_version
        ? '新修订已保存，线上仍使用已发布版本'
        : '维护草稿已保存，已有会话不受影响',
    );
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}
function createFromTemplate(scenario: Scenario) {
  if (busy.value) return;
  detailOpen.value = false;
  edit(undefined, scenario.payload.name);
  Object.assign(draft, normalizePayload(scenario), { name: `${scenario.payload.name} · 副本` });
  initialDraft.value = JSON.stringify(draft);
}
async function discard() {
  if (!toDelete.value || deleting.value) return;
  deleting.value = true;
  try {
    await remove(`/agent-scenarios/${toDelete.value.id}`);
    await app.refreshScenarios();
    deleteOpen.value = false;
    app.toast('场景已删除，历史会话快照仍保留');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    deleting.value = false;
  }
}
async function test(scenario: Scenario) {
  if (!app.connection?.configured) {
    app.toast('尚无可用模型，请先在「模型连接」完成配置；当前页面已保留', 'info');
    return;
  }
  testing.value = scenario.id;
  try {
    const result = await post(`/agent-scenarios/${scenario.id}/run-test`);
    await app.refreshScenarios();
    app.toast(result.summary, result.ok ? 'success' : 'error');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    testing.value = null;
  }
}
async function publish(scenario: Scenario) {
  if (busy.value) return;
  busy.value = true;
  try {
    await post(`/agent-scenarios/${scenario.id}/publish`);
    await app.refreshScenarios();
    filter.value = 'published';
    app.toast('当前版本已发布，已进入场景目录');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}
async function versions(scenario: Scenario) {
  try {
    historyTitle.value = scenario.payload.name;
    versionHistory.value = await api(`/agent-scenarios/${scenario.id}/versions`);
    historyOpen.value = true;
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
}
</script>
<template>
  <main class="page-content enterprise-page scenarios-page">
    <div class="enterprise-page-inner">
      <div class="page-heading catalog-page-heading scenario-page-heading">
        <div class="catalog-heading-copy">
          <span class="catalog-kicker"
            ><span class="catalog-kicker-mark"><Icon name="layers" :size="12" /></span>SCENARIO LIBRARY</span
          >
          <h1>
            <!-- 维护模式：返回按钮放在标题左侧，与「我的技能」页一致 -->
            <RouterLink
              v-if="maintenance"
              class="catalog-back"
              to="/agent/scenarios"
              aria-label="返回使用目录"
              title="返回使用目录"
            >
              <Icon name="ri-arrow-go-back-fill" :size="20" />
            </RouterLink>
            企业场景
          </h1>
          <p v-if="!maintenance">按工作目标选择场景，进入对话直接开始。</p>
          <p v-else>编辑场景，试运行通过后发布。</p>
        </div>
      </div>
      <a-alert
        v-if="maintenance && !app.loading && !app.connection?.configured"
        type="info"
        show-icon
        message="试运行需要可用模型"
        description="场景可以继续编辑和保存；配置模型后再试运行。"
      >
        <template #action><RouterLink to="/agent/models">前往模型连接</RouterLink></template>
      </a-alert>
      <div class="collection-toolbar enterprise-collection-toolbar scenario-collection-toolbar">
        <CatalogFilter v-model:value="filter" aria-label="场景筛选" :options="filterOptions" />
        <!-- 搜索与维护操作同在右侧，和能力管理页一致：维护场景/新建场景紧贴搜索框右边 -->
        <div class="scenario-toolbar-actions">
          <CatalogSearch v-model:value="query" placeholder="搜索场景名称或描述" aria-label="搜索场景" />
          <!-- 使用目录：「维护场景」；维护模式：「新建场景」（返回在标题左侧） -->
          <a-button v-if="!maintenance" type="primary" @click="enterMaintenance">
            <template #icon><Icon name="settings" :size="16" /></template>维护场景
          </a-button>
          <a-button v-else type="primary" @click="edit()">
            <template #icon><Icon name="plus" :size="16" /></template>新建场景
          </a-button>
        </div>
      </div>
      <div v-if="app.loading" class="loading-inline" role="status"><a-spin size="small" />正在读取场景…</div>
      <CatalogEmpty
        v-else-if="!filtered.length"
        :icon="query ? 'search' : 'grid'"
        :title="query ? '没有找到匹配的场景' : '这个分类还没有场景'"
        :description="
          query
            ? '试试其他关键词，或清除搜索。'
            : maintenance
              ? '从预置模板创建草稿，或新建一个工作场景。'
              : '新场景经过维护和发布后，会出现在这里。'
        "
      >
        <a-button
          v-if="query || filter !== 'all'"
          @click="
            query = '';
            filter = 'all';
          "
        >
          查看全部场景
        </a-button>
      </CatalogEmpty>
      <CatalogGrid v-else>
        <CatalogCard
          v-for="scenario in filtered"
          :key="scenario.id"
          class="scenario-card"
          :title="scenario.payload.name"
          :icon="scenario.payload.icon"
          :tone="scenario.payload.icon"
          :description="scenario.payload.description"
          placeholder="还没有添加场景描述。"
          :status="maintenance && hasPendingDraft(scenario) ? '待发布修订' : scenarioState(scenario)"
          :status-color="
            maintenance && hasPendingDraft(scenario)
              ? 'warning'
              : scenario.status === 'published'
                ? 'success'
                : undefined
          "
        >
          <template #badge><SpaceTag :space-id="scenario.spaceId" /></template>
          <template #sub>
            <template v-if="maintenance">
              <span>{{ scenarioSource(scenario) }}</span><span>v{{ scenario.current_version }}</span
              ><span v-if="hasPendingDraft(scenario)">已发布 v{{ scenario.published_version }}</span
              ><span :class="['scenario-card-test', { 'is-passed': scenario.tested }]"
                ><Icon :name="scenario.tested ? 'check' : 'circle'" :size="12" />{{
                  scenario.tested ? '试运行通过' : '未试运行'
                }}</span
              >
            </template>
            <span v-if="!maintenance && scenarioPublished(scenario)">v{{ scenario.published_version }}</span>
            <span v-if="scenario.space !== 'official'">{{
              scenarioPublished(scenario)
                ? catalogDate('发布', scenario.publishedAt)
                : catalogDate('创建', scenario.createdAt)
            }}</span>
            <span v-if="maintenance && hasPendingDraft(scenario)">{{
              catalogDate('草稿更新', scenario.updatedAt)
            }}</span>
            <span v-if="!maintenance && scenario.space === 'official'">平台预置</span>
          </template>
          <template v-if="cardLabels(scenario.payload).length" #tags>
            <a-tag v-for="item in cardLabels(scenario.payload).slice(0, 2)" :key="item.key" :bordered="false"
              ><Icon :name="item.icon" :size="12" /><span>{{ item.label }}</span></a-tag
            ><a-tag v-if="cardLabels(scenario.payload).length > 2" :bordered="false"
              >+{{ cardLabels(scenario.payload).length - 2 }}</a-tag
            >
          </template>
          <!-- 使用目录：详情（文字按钮）+ 开始（主题色主按钮，图标在左） -->
          <template v-if="!maintenance" #footer>
            <a-button type="text" size="small" @click="openDetail(scenario)">
              <template #icon><Icon name="information-line" :size="14" /></template>详情
            </a-button>
            <a-button type="primary" size="small" @click="useScenario(scenario)">
              <template #icon
                ><Icon :name="isAvailableScenario(scenario) ? 'play' : 'eye'" :size="14"
              /></template>
              {{ isAvailableScenario(scenario) ? '开始' : '预览草稿' }}
            </a-button>
          </template>
          <!-- 维护模式：编辑 + 当前阶段操作；其他操作收进「更多」以保持单行。
               每张卡片一个主题色主操作：可发布时为「发布」，否则为「编辑 / 基于模板创建」。 -->
          <template v-if="maintenance" #ops>
            <a-button
              :type="canPublish(scenario) ? 'default' : 'primary'"
              size="small"
              :disabled="busy"
              @click="scenario.space === 'official' ? createFromTemplate(scenario) : edit(scenario)"
            >
              <template #icon
                ><Icon :name="scenario.space === 'official' ? 'copy' : 'edit'" :size="14"
              /></template>
              {{ scenario.space === 'official' ? '基于模板创建' : '编辑' }}
            </a-button>
            <a-button
              v-if="
                scenario.space !== 'official' &&
                (!scenario.published_version || hasPendingDraft(scenario)) &&
                !scenario.tested
              "
              type="text"
              size="small"
              :disabled="testing !== null"
              :loading="testing === scenario.id"
              @click="test(scenario)"
            >
              <template #icon><Icon name="play" :size="14" /></template>试运行
            </a-button>
            <a-button
              v-if="canPublish(scenario)"
              type="primary"
              size="small"
              :disabled="busy"
              @click="publish(scenario)"
            >
              <template #icon><Icon name="check" :size="14" /></template>发布
            </a-button>
          </template>
          <template v-if="maintenance" #footer>
            <a-dropdown :trigger="['click']" placement="bottomRight">
              <a-button
                type="text"
                size="small"
                class="scenario-card-more"
                :aria-label="`更多操作 ${scenario.payload.name}`"
                title="更多操作"
              >
                <template #icon><Icon name="more" :size="16" /></template>
              </a-button>
              <template #overlay>
                <a-menu @click="(info: MenuInfo) => moreAction(String(info.key), scenario)">
                  <a-menu-item key="detail">详情</a-menu-item>
                  <a-menu-item
                    v-if="scenario.space !== 'official' && scenario.tested"
                    key="test"
                    :disabled="testing !== null"
                    >重新试运行</a-menu-item
                  >
                  <a-menu-item
                    v-if="
                      scenario.space !== 'official' &&
                      scenario.published_version &&
                      !hasPendingDraft(scenario) &&
                      !scenario.tested
                    "
                    key="test"
                    :disabled="testing !== null"
                    >试运行</a-menu-item
                  >
                  <a-menu-item key="versions">版本记录 v{{ scenario.current_version }}</a-menu-item>
                  <a-menu-item v-if="scenario.space !== 'official'" key="move">移动到其他空间</a-menu-item>
                  <a-menu-item v-if="scenario.space !== 'official'" key="delete" danger>删除场景</a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
          </template>
        </CatalogCard>
      </CatalogGrid>
    </div>
    <!-- class="drawer" 落在 .ant-drawer-content 上，复用全局 .drawer 下的正文排版（detail-block / version-entry 等） -->
    <a-drawer
      :open="detailOpen"
      :width="580"
      :title="detail?.payload.name ?? '场景详情'"
      class="drawer scenario-detail"
      v-bind="drawerA11y('场景详情', detailOpen)"
      @close="detailOpen = false"
    >
      <template v-if="detail">
        <p v-if="maintenance" class="scenario-drawer-meta">
          {{ scenarioSource(detail) }} · {{ scenarioState(detail) }} · v{{ detail.current_version }}
        </p>
        <div class="detail-block">
          <h3>用途</h3>
          <p>{{ detail.payload.description || '尚未添加用途说明。' }}</p>
        </div>
        <div class="detail-block">
          <h3>可用能力</h3>
          <p v-if="!cardLabels(detail.payload).length">使用平台基础工具。</p>
          <RouterLink
            v-for="item in cardLabels(detail.payload)"
            :key="item.key"
            :to="{
              path: '/agent/capabilities',
              query: {
                tab: item.key.startsWith('skill') ? 'skills' : item.key.startsWith('mcp') ? 'mcp' : 'tools',
              },
            }"
            class="scenario-detail-tool"
            ><Icon :name="item.icon" :size="18" /><span>{{ item.label }}</span
            ><Icon name="arrow" :size="14"
          /></RouterLink>
        </div>
        <div v-if="maintenance" class="detail-block">
          <h3>工作规范</h3>
          <pre class="scenario-prompt-preview">{{ detail.payload.prompt_template }}</pre>
        </div>
        <div v-if="maintenance" class="detail-block">
          <h3>版本信息</h3>
          <a-descriptions :column="1" size="small">
            <a-descriptions-item label="当前版本">v{{ detail.current_version }}</a-descriptions-item>
            <a-descriptions-item label="维护账号">{{
              detail.space === 'official' ? '平台预置' : detail.owner_id
            }}</a-descriptions-item>
            <a-descriptions-item label="更新时间">{{
              formatDate(detail.updatedAt, true)
            }}</a-descriptions-item>
          </a-descriptions>
          <a-button
            type="link"
            @click="
              versions(detail);
              detailOpen = false;
            "
          >
            查看版本记录 <Icon name="arrow" :size="14" />
          </a-button>
        </div>
        <a-alert
          v-if="!maintenance && detail.space === 'official'"
          type="info"
          show-icon
          message="预置场景供参考，正式使用前请按业务要求确认。"
        />
        <a-alert
          v-else-if="maintenance"
          type="warning"
          show-icon
          message="新会话会记录场景、模型与策略快照；维护场景不会改写已有会话。"
        />
      </template>
      <template v-if="detail" #footer>
        <div class="scenario-drawer-footer">
          <a-button v-if="maintenance" :disabled="busy" @click="editDetail">
            {{ detail.space === 'official' ? '基于模板创建' : '编辑' }}
          </a-button>
          <a-button type="primary" @click="useScenario(detail)">
            {{ hasPendingDraft(detail) ? '使用已发布版' : isAvailableScenario(detail) ? '开始' : '预览草稿'
            }}<Icon name="arrow" :size="16" />
          </a-button>
        </div>
      </template>
    </a-drawer>
    <!-- destroy-on-close：每次打开重建表单，避免沿用上一次的校验提示 -->
    <a-drawer
      :open="drawer"
      :width="640"
      :title="editing ? '编辑场景' : '新建工作场景'"
      class="drawer scenario-editor"
      v-bind="drawerA11y('场景编辑器', drawer)"
      :closable="!busy"
      :mask-closable="!busy"
      :keyboard="!busy"
      destroy-on-close
      @close="closeEditor"
    >
      <a-form id="scenario-form" :model="draft" :rules="rules" layout="vertical" @finish="save">
        <p v-if="basedOn || editing?.published_version" class="scenario-drawer-meta">
          {{ basedOn ? `基于「${basedOn}」创建草稿` : '保存为新修订，已发布版本继续可用。' }}
        </p>
        <p v-if="editorSpace" class="scenario-drawer-space">
          <SpaceMark :space="editorSpace" :size="16" />
          <span v-if="!editing"
            >保存到「{{ editorSpace.name }}」{{
              editorSpace.isPublic
                ? '：所有空间都能看到和使用'
                : '：只能使用本空间和公共空间的 Skill、MCP 和插件'
            }}</span
          >
          <span v-else-if="editorSpaceId !== space.currentId"
            >这个场景在「{{ editorSpace.name }}」：只能使用{{
              editorSpace.isPublic ? '公共空间' : '该空间和公共空间'
            }}的 Skill、MCP 和插件</span
          >
          <span v-else>所在空间：{{ editorSpace.name }}</span>
        </p>
        <section class="scenario-ai" aria-labelledby="scenario-ai-title">
          <header>
            <span class="scenario-ai-mark"><Icon name="sparkles" :size="16" /></span>
            <div>
              <h3 id="scenario-ai-title">{{ editing ? 'AI 帮我优化' : 'AI 生成场景' }}</h3>
              <p>
                {{
                  editing
                    ? '说说想怎么调整，或留空让 AI 按当前内容补全；也可以点各项旁的「AI 生成」单独更新。'
                    : '用一句话描述工作目标，AI 会填好名称、介绍和提示词，并自动勾选合适的能力。'
                }}
              </p>
            </div>
          </header>
          <a-textarea
            v-model:value="aiRequirement"
            :auto-size="{ minRows: 2, maxRows: 5 }"
            :maxlength="2000"
            :disabled="!!generating"
            :placeholder="
              editing
                ? '例如：输出改成表格，并增加风险等级（可留空）'
                : '例如：帮财务审核报销单，检查发票是否合规，输出问题清单'
            "
            aria-label="描述想要的场景"
          />
          <div class="scenario-ai-actions">
            <span v-if="generating" class="scenario-ai-status" role="status"
              >AI 正在生成{{ generating === 'all' ? '' : AI_FIELD_LABELS[generating] }}，通常需要 10–30
              秒…</span
            >
            <a-button v-else-if="aiUndo" type="link" size="small" @click="undoGenerate"
              >撤销 AI 修改</a-button
            >
            <a-button
              type="primary"
              :loading="generating === 'all'"
              :disabled="!!generating && generating !== 'all'"
              @click="generate(null)"
            >
              <template #icon><Icon name="sparkles" :size="15" /></template
              >{{ editing ? 'AI 优化全部' : 'AI 生成' }}
            </a-button>
          </div>
          <div
            v-if="aiResult && (aiResult.notices.length || aiResult.missing.length)"
            class="scenario-ai-result"
          >
            <p v-for="notice in aiResult.notices" :key="notice">
              <Icon name="info" :size="14" />{{ notice }}
            </p>
            <template v-if="aiResult.missing.length">
              <strong>建议补充的能力（平台里还没有）</strong>
              <ul>
                <li v-for="item in aiResult.missing" :key="item.name">
                  <b>{{ item.name }}</b><small v-if="item.reason">{{ item.reason }}</small>
                </li>
              </ul>
              <RouterLink :to="{ path: '/agent/capabilities' }">前往技能管理添加</RouterLink>
            </template>
          </div>
        </section>
        <div class="form-section-title"><span>01</span>基本信息</div>
        <a-form-item name="name">
          <template #label
            >场景名称<button
              type="button"
              class="scenario-ai-inline"
              :disabled="!!generating"
              title="让 AI 根据需求和当前内容生成名称"
              @click.prevent="generate(['name'])"
            >
              <span v-if="generating === 'name'" class="loader small"></span
              ><Icon v-else name="sparkles" :size="13" />AI 生成
            </button></template
          >
          <a-input v-model:value="draft.name" :maxlength="128" placeholder="例如：研发需求评审助手" />
        </a-form-item>
        <a-form-item name="description">
          <template #label
            >一句话介绍<button
              type="button"
              class="scenario-ai-inline"
              :disabled="!!generating"
              title="让 AI 根据需求和当前内容生成介绍"
              @click.prevent="generate(['description'])"
            >
              <span v-if="generating === 'description'" class="loader small"></span
              ><Icon v-else name="sparkles" :size="13" />AI 生成
            </button></template
          >
          <a-textarea
            v-model:value="draft.description"
            :rows="2"
            :maxlength="512"
            placeholder="告诉使用者，这个场景适合什么工作。"
          />
        </a-form-item>
        <a-form-item label="场景图标">
          <div class="icon-options">
            <a-button
              v-for="icon in ['sparkles', 'code', 'file', 'chart', 'book', 'shield']"
              :key="icon"
              :aria-label="`选择图标 ${icon}`"
              :class="{ selected: draft.icon === icon }"
              @click="draft.icon = icon"
            >
              <template #icon><Icon :name="icon" :size="22" /></template>
            </a-button>
          </div>
        </a-form-item>
        <div class="form-section-title"><span>02</span>场景提示词</div>
        <a-form-item name="prompt_template">
          <template #label
            >角色、目标与工作方式<button
              type="button"
              class="scenario-ai-inline"
              :disabled="!!generating"
              :title="draft.prompt_template.trim() ? '让 AI 优化当前提示词' : '让 AI 生成提示词'"
              @click.prevent="generate(['prompt'])"
            >
              <span v-if="generating === 'prompt'" class="loader small"></span
              ><Icon v-else name="sparkles" :size="13" />{{
                draft.prompt_template.trim() ? 'AI 优化' : 'AI 生成'
              }}
            </button></template
          >
          <a-textarea
            v-model:value="draft.prompt_template"
            class="prompt-editor"
            :rows="8"
            placeholder="定义角色、目标、步骤与输出标准。"
          />
        </a-form-item>
        <p class="field-hint">作为场景级指令使用。不会自动开始任务，也不会扩大工具权限。</p>
        <div class="form-section-title">
          <span>03</span>授权能力<button
            type="button"
            class="scenario-ai-inline"
            :disabled="!!generating"
            title="让 AI 从当前可用的 Skill、MCP、插件和联网中重新推荐，并自动勾选"
            @click="generate(['capabilities'])"
          >
            <span v-if="generating === 'capabilities'" class="loader small"></span
            ><Icon v-else name="sparkles" :size="13" />AI 推荐
          </button>
        </div>
        <p class="field-hint">
          平台基础能力（默认开启）：每个会话都可使用，范围以平台策略和当前空间的工具开关为上限。
        </p>
        <a-checkbox
          v-for="tool in app.tools"
          :key="tool.name"
          class="tool-checkbox"
          :checked="tool.available !== false"
          disabled
        >
          <span class="tool-checkbox-icon"><Icon :name="tool.icon" :size="18" /></span>
          <div>
            <strong>{{ tool.title }}</strong><small>{{ tool.description }}</small>
          </div>
          <a-tag v-if="tool.policyAllowed === false" :bordered="false">策略未允许</a-tag>
          <a-tag v-else-if="tool.spaceEnabled === false" :bordered="false">本空间已关闭</a-tag>
          <Icon v-else-if="tool.permission !== 'read'" name="edit" :size="15" />
        </a-checkbox>
        <section class="scenario-plugin-picker" aria-labelledby="scenario-skill-title">
          <header>
            <div>
              <h3 id="scenario-skill-title">Skill</h3>
              <p>
                绑定已发布的 Skill，发布场景时固定到当前修订。模型按需加载，用户也可在聊天中输入 /名称
                直接调用。最多 {{ MAX_SESSION_SKILLS }} 个。
              </p>
            </div>
            <a-spin v-if="optionsLoading" size="small" />
          </header>
          <p v-if="!optionsLoading && !editorOptions?.skills.length" class="field-hint">
            还没有已发布的 Skill。<RouterLink to="/agent/skills">前往 Skill 中心</RouterLink>
          </p>
          <a-checkbox
            v-for="skill in editorOptions?.skills ?? []"
            :key="skill.id"
            class="scenario-plugin-option"
            :checked="draft.capabilities.skill_ids.includes(skill.id)"
            @change="setSkill(skill.id, ($event.target as HTMLInputElement).checked)"
          >
            <span class="tool-checkbox-icon"><Icon name="book" :size="18" /></span>
            <div>
              <strong>{{ skill.title }}</strong><small
                >/{{ skill.name }}<template v-if="skill.version"> · v{{ skill.version }}</template
                ><template v-if="skill.description"> · {{ skill.description }}</template></small
              ><em
                v-if="aiReason(`skill:${skill.id}`, draft.capabilities.skill_ids.includes(skill.id))"
                class="scenario-ai-reason"
                ><Icon name="sparkles" :size="12" />AI 推荐：{{
                  aiReason(`skill:${skill.id}`, draft.capabilities.skill_ids.includes(skill.id))
                }}</em
              >
            </div>
          </a-checkbox>
          <a-checkbox
            v-for="id in missingSkills"
            :key="`missing-skill-${id}`"
            class="scenario-plugin-option"
            checked
            @change="setSkill(id, false)"
          >
            <span class="tool-checkbox-icon"><Icon name="book" :size="18" /></span>
            <div>
              <strong>{{ missingSkill(id).title }}</strong><small
                >{{ missingSkill(id).reason }}，场景已不再使用它；取消勾选后才能保存</small
              >
            </div>
            <a-tag>{{ missingSkill(id).reason }}</a-tag>
          </a-checkbox>
        </section>
        <section class="scenario-plugin-picker" aria-labelledby="scenario-mcp-title">
          <header>
            <div>
              <h3 id="scenario-mcp-title">MCP 服务</h3>
              <p>
                仅列出管理员已启用且连接测试通过的服务。未标注只读的工具每次调用前需用户确认；凭据与工具清单按最新配置每轮装配。最多
                {{ MAX_SESSION_MCP }} 个。
              </p>
            </div>
          </header>
          <p v-if="!optionsLoading && !editorOptions?.mcpServers.length" class="field-hint">
            还没有可用的 MCP 服务。<RouterLink :to="{ path: '/agent/capabilities', query: { tab: 'mcp' } }"
              >前往能力中心接入</RouterLink
            >
          </p>
          <a-checkbox
            v-for="server in editorOptions?.mcpServers ?? []"
            :key="server.id"
            class="scenario-plugin-option"
            :checked="draft.capabilities.mcp_server_ids.includes(server.id)"
            @change="setServer(server.id, ($event.target as HTMLInputElement).checked)"
          >
            <span class="tool-checkbox-icon"><Icon name="plug" :size="18" /></span>
            <div>
              <strong>{{ server.name }}</strong><small
                >{{ server.transport === 'stdio' ? '本地进程' : 'HTTP' }} ·
                {{ server.tools.length }} 个工具<template
                  v-if="server.tools.some((tool) => tool.permission === 'approval')"
                >
                  ·
                  {{ server.tools.filter((tool) => tool.permission === 'approval').length }}
                  个需确认</template
                ><template v-if="server.description"> · {{ server.description }}</template></small
              ><em
                v-if="aiReason(`mcp:${server.id}`, draft.capabilities.mcp_server_ids.includes(server.id))"
                class="scenario-ai-reason"
                ><Icon name="sparkles" :size="12" />AI 推荐：{{
                  aiReason(`mcp:${server.id}`, draft.capabilities.mcp_server_ids.includes(server.id))
                }}</em
              >
            </div>
          </a-checkbox>
          <a-checkbox
            v-for="id in missingServers"
            :key="`missing-mcp-${id}`"
            class="scenario-plugin-option"
            checked
            @change="setServer(id, false)"
          >
            <span class="tool-checkbox-icon"><Icon name="plug" :size="18" /></span>
            <div>
              <strong>MCP #{{ id }}</strong
              ><small>已停用或连接异常，取消勾选后才能保存</small>
            </div>
            <a-tag>不可用</a-tag>
          </a-checkbox>
        </section>
        <section class="scenario-plugin-picker" aria-labelledby="scenario-web-title">
          <header>
            <div>
              <h3 id="scenario-web-title">联网</h3>
              <p>开启后模型可搜索网络并读取公网网页，回答需注明来源。每次搜索按一次模型调用计费。</p>
            </div>
          </header>
          <a-checkbox
            class="scenario-plugin-option"
            v-model:checked="draft.capabilities.web_search"
            :disabled="!draft.capabilities.web_search && !editorOptions?.web.available"
          >
            <span class="tool-checkbox-icon"><Icon name="globe" :size="18" /></span>
            <div>
              <strong>联网搜索</strong
              ><small>{{
                editorOptions?.web.available
                  ? editorOptions.web.fetchEnabled
                    ? '搜索 + 读取网页'
                    : '仅搜索'
                  : editorOptions?.web.reason || '平台尚未开启联网搜索，请在治理中心配置'
              }}</small
              ><em v-if="aiReason('web', !!draft.capabilities.web_search)" class="scenario-ai-reason"
                ><Icon name="sparkles" :size="12" />AI 推荐：{{
                  aiReason('web', !!draft.capabilities.web_search)
                }}</em
              >
            </div>
            <a-tag v-if="editorOptions && !editorOptions.web.available">未开启</a-tag>
          </a-checkbox>
        </section>
        <section class="scenario-plugin-picker" aria-labelledby="scenario-plugin-title">
          <header>
            <div>
              <h3 id="scenario-plugin-title">已批准插件</h3>
              <p>选择审核通过的插件及具体工具。插件工具会随场景版本固定，不能在会话中临时扩大权限。</p>
            </div>
            <a-spin v-if="pluginsLoading" size="small" />
          </header>
          <p v-if="!pluginsLoading && !plugins.length" class="field-hint">当前没有可用于场景的已批准插件。</p>
          <a-checkbox
            v-for="plugin in editorPlugins"
            :key="plugin.package"
            class="scenario-plugin-option"
            :checked="pluginSelected(plugin)"
            :disabled="plugin.auditStatus !== 'approved' || !plugin.enabled"
            @change="setPluginSelected(plugin, ($event.target as HTMLInputElement).checked)"
          >
            <span class="tool-checkbox-icon"><Icon name="blocks" :size="18" /></span>
            <div>
              <strong>{{ plugin.displayName }}</strong><small
                >{{ plugin.description }} · v{{ plugin.version }}</small
              ><em
                v-if="aiReason(`plugin:${plugin.package}`, pluginSelected(plugin))"
                class="scenario-ai-reason"
                ><Icon name="sparkles" :size="12" />AI 推荐：{{
                  aiReason(`plugin:${plugin.package}`, pluginSelected(plugin))
                }}</em
              >
            </div>
            <a-tag v-if="demoPlugin(plugin)" color="volcano" title="仅返回模拟数据，不连接真实系统"
              >演示数据</a-tag
            ><a-tag :color="plugin.auditStatus === 'approved' && plugin.enabled ? 'success' : undefined">{{
              plugin.auditStatus === 'approved' && plugin.enabled ? '已批准' : '不可用'
            }}</a-tag>
          </a-checkbox>
          <div
            v-for="plugin in editorPlugins.filter(pluginSelected)"
            :key="`${plugin.package}-tools`"
            class="scenario-plugin-tools"
          >
            <strong>{{ plugin.displayName }} · 选择工具</strong
            ><a-checkbox
              v-for="tool in plugin.tools"
              :key="tool.name"
              class="scenario-plugin-tool"
              :checked="pluginToolSelected(plugin, tool.name)"
              @change="setPluginTool(plugin, tool.name, ($event.target as HTMLInputElement).checked)"
            >
              <span
                ><b>{{ tool.title }}</b
                ><small>{{ tool.description }}</small></span
              ><a-tag :color="tool.permission === 'approval' ? 'volcano' : undefined">{{
                tool.permission === 'approval' ? '需审批' : '只读'
              }}</a-tag>
            </a-checkbox>
          </div>
          <p class="field-hint">
            只装配审核通过的受管插件，不会安装或执行任意 npm、GitHub 插件。关联代码改为在聊天中按会话选择。
          </p>
        </section>
        <div class="form-section-title"><span>04</span>运行配置</div>
        <div class="static-form-row">
          <span>模型路由</span
          ><strong
            >与场景无关，由会话选择<small
              >试运行使用平台默认模型 · {{ app.connection?.model || '尚未配置模型' }}</small
            ></strong
          >
        </div>
        <div class="static-form-row"><span>执行方式</span><strong>标准会话</strong></div>
        <a-alert
          type="warning"
          show-icon
          message="实际工具范围取场景与平台策略交集；用户可在聊天中临时追加 Skill、MCP 与联网，但不能取消场景绑定项。草稿须试运行通过后才能发布。"
        />
      </a-form>
      <template #footer>
        <div class="scenario-drawer-footer">
          <a-button :disabled="busy" @click="closeEditor">取消</a-button>
          <a-button
            type="primary"
            html-type="submit"
            form="scenario-form"
            :loading="busy"
            :disabled="!!generating"
            :title="generating ? 'AI 生成中，完成后再保存' : undefined"
          >
            <template #icon><Icon name="save" :size="16" /></template>保存草稿
          </a-button>
        </div>
      </template>
    </a-drawer>
    <a-modal
      :open="deleteOpen"
      :width="430"
      centered
      wrap-class-name="scenario-delete-modal"
      aria-label="删除场景确认"
      ok-text="确认删除"
      cancel-text="取消"
      :ok-button-props="{ danger: true }"
      :cancel-button-props="{ disabled: deleting }"
      :confirm-loading="deleting"
      :closable="!deleting"
      :mask-closable="!deleting"
      :keyboard="!deleting"
      @ok="discard"
      @cancel="cancelDelete"
    >
      <template #title>
        <span class="scenario-delete-title"
          ><span class="confirm-icon"><Icon name="trash" :size="18" /></span>删除「{{
            toDelete?.payload.name
          }}」？</span
        >
      </template>
      <p class="scenario-delete-text">该场景将从目录移出，已有会话的配置快照和审计记录仍保留。</p>
    </a-modal>
    <a-drawer
      :open="historyOpen"
      :width="580"
      :title="historyTitle"
      class="drawer scenario-history"
      v-bind="drawerA11y('场景版本历史', historyOpen)"
      @close="historyOpen = false"
    >
      <a-timeline v-if="versionHistory">
        <a-timeline-item v-for="version in versionHistory" :key="version.version">
          <div class="version-entry">
            <div>
              <strong>v{{ version.version }}</strong
              ><span>{{ formatDate(version.createdAt, true) }}</span>
            </div>
            <p>{{ version.changeLog }}</p>
            <a-typography-text code>SHA256 {{ version.bundleHash.slice(0, 24) }}…</a-typography-text>
            <a-collapse ghost>
              <a-collapse-panel key="bundle" header="查看此版本装配单">
                <pre>{{ JSON.stringify({ payload: version.payload, bundle: version.bundle }, null, 2) }}</pre>
              </a-collapse-panel>
            </a-collapse>
          </div>
        </a-timeline-item>
      </a-timeline>
    </a-drawer>
    <MoveSpaceDialog
      :open="Boolean(moving)"
      kind="scenario"
      :resource-id="moving?.id ?? null"
      :name="moving?.payload.name ?? ''"
      :space-id="moving?.spaceId"
      @close="moving = null"
      @moved="moved"
    />
  </main>
</template>

<style scoped>
.scenario-drawer-space {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 14px;
  color: var(--color-text-secondary);
  font-size: 12px;
}
/* ============ 页面节奏：页头 / 筛选栏 / 内容统一间距 ============ */
.scenarios-page .scenario-page-heading {
  gap: 16px;
  margin-bottom: 24px;
}
.scenarios-page .enterprise-collection-toolbar.scenario-collection-toolbar {
  min-height: 32px;
  margin-bottom: 24px;
}
.scenario-toolbar-actions {
  gap: 8px;
}

/* ============ 工具栏操作按钮 ============ */
/* 尺寸、圆角、配色全部沿用 antd 默认；只补图标间距：
   icon 插槽里是 ForgeIcon 裸 <svg>，不是 .anticon，antd 不会给它和文字之间留空 */
.scenario-toolbar-actions :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.scenario-toolbar-actions :deep(.ant-btn > svg) {
  flex-shrink: 0;
}

/* 卡片沿用目录组件；维护操作固定单行，避免「发布」被挤到下一行。 */
.scenario-card :deep(.catalog-card-ops) {
  flex-wrap: nowrap;
}
.scenario-card :deep(.catalog-card-footer .ant-btn) {
  flex-shrink: 0;
  white-space: nowrap;
}
.scenario-card-test {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.scenario-card-test.is-passed {
  color: var(--color-success-text);
}

@media (max-width: 700px) {
  .scenario-toolbar-actions {
    flex-wrap: wrap;
  }
}

/* ============ AI 生成：顶部输入区、各项旁的「AI 生成」按钮、推荐理由 ============ */
.scenario-ai {
  display: grid;
  gap: 10px;
  margin-bottom: 22px;
  padding: 14px 16px;
  border: 1px solid var(--scenario-selection-border, var(--line));
  border-radius: 10px;
  background: var(--accent-wash);
}
.scenario-ai > header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.scenario-ai-mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--surface);
  color: var(--color-brand);
}
.scenario-ai h3 {
  margin: 0;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}
.scenario-ai header p {
  margin: 3px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.scenario-ai-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.scenario-ai-status {
  margin-right: auto;
  color: var(--text-secondary);
  font-size: 12px;
}
.scenario-ai-actions :deep(.ant-btn-link) {
  margin-right: auto;
  padding-inline: 0;
}
.scenario-ai-result {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.scenario-ai-result p {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
}
.scenario-ai-result p > svg {
  flex: none;
  margin-top: 3px;
}
.scenario-ai-result strong {
  color: var(--ink);
  font-weight: 600;
}
.scenario-ai-result ul {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
}
.scenario-ai-result li b {
  color: var(--ink);
  font-weight: 500;
}
.scenario-ai-result li small {
  margin-left: 6px;
  font-size: 12px;
}
.scenario-ai-inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  padding: 1px 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--color-brand);
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
  cursor: pointer;
}
.scenario-ai-inline:hover:not(:disabled) {
  background: var(--accent-wash);
}
.scenario-ai-inline:disabled {
  color: var(--color-text-tertiary);
  cursor: not-allowed;
}
.scenario-ai-inline:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: 1px;
}
.scenario-ai-inline .loader.small {
  width: 12px;
  height: 12px;
}
.form-section-title .scenario-ai-inline {
  margin-left: auto;
}
.scenario-ai-reason {
  display: inline-flex;
  align-items: flex-start;
  gap: 4px;
  color: var(--accent-ink);
  font-size: 12px;
  font-style: normal;
  line-height: 1.5;
}
.scenario-ai-reason > svg {
  flex: none;
  margin-top: 2px;
}

/* ============ 编辑器内 antd 细节（保持不变的功能性修正）============ */
.icon-options :deep(.ant-btn) {
  padding: 0;
}
.tool-checkbox,
.scenario-plugin-option,
.scenario-plugin-tool {
  display: flex;
  align-items: center;
}
.scenario-plugin-option :deep(.ant-tag),
.scenario-plugin-tool :deep(.ant-tag) {
  margin-left: auto;
  white-space: nowrap;
}
.version-entry :deep(.ant-collapse) {
  margin-top: 17px;
}

/* ============ antd 抽屉 / 对话框插槽内容 ============ */
/* 插槽内容在本组件内编译，scoped 样式随 Teleport 一并生效 */
.scenario-drawer-meta {
  margin: 0 0 20px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.6;
}
.scenario-drawer-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.scenario-drawer-footer :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.scenario-delete-title {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow-wrap: anywhere;
}
.scenario-delete-title .confirm-icon {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  margin: 0;
  border-radius: 9px;
  color: var(--color-danger-text);
  background: var(--color-danger-bg);
}
.scenario-delete-text {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.9;
}
</style>
