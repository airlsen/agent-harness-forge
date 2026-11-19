<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Rule } from 'ant-design-vue/es/form';
import { usePlatform } from '../../../stores/platform';
import { MAX_SESSION_MCP, MAX_SESSION_SKILLS, useConversation } from '../../../stores/conversation';
import { api, post, put, remove } from '../../../api/client';
import { formatDate, isAvailableScenario, scenarioSource, scenarioState } from '../../../utils/presentation';
import type { Scenario, ScenarioPayload } from '../../../types/platform';
import type { PluginPackage } from '../../../types/plugin';
import Icon from '../../../components/ForgeIcon.vue';

const app = usePlatform();
const chat = useConversation();
const router = useRouter();
const route = useRoute();
const query = ref('');
const filter = ref('all');
const drawer = ref(false);
const editing = ref<Scenario | null>(null);
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
// a-segmented 选项：不传 label，交给 #label 插槽渲染「名称 + 数量」
const filterOptions = computed(() =>
  filters.value.map((item) => ({ value: item.id, title: item.label, payload: item })),
);
const filtered = computed(() =>
  base.value.filter(
    (s) =>
      (filter.value === 'all' || s.status === filter.value) &&
      `${s.payload.name} ${s.payload.description}`.toLowerCase().includes(query.value.trim().toLowerCase()),
  ),
);
watch(maintenance, () => {
  filter.value = 'all';
});
function toggleMaintenance() {
  filter.value = 'all';
  void router.replace({ query: maintenance.value ? {} : { view: 'maintain' } });
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
  return chat.capabilityOptions?.skills.find((skill) => skill.id === id)?.title ?? `Skill #${id}`;
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
/** 草稿中已绑定、但已取消发布或停用的项：保存会被拒绝，需先移除 */
const missingSkills = computed(() =>
  chat.capabilityOptions
    ? draft.capabilities.skill_ids.filter((id) => !chat.capabilityOptions?.skills.some((s) => s.id === id))
    : [],
);
const missingServers = computed(() =>
  chat.capabilityOptions
    ? draft.capabilities.mcp_server_ids.filter(
        (id) => !chat.capabilityOptions?.mcpServers.some((s) => s.id === id),
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
function edit(scenario?: Scenario) {
  editing.value = scenario ?? null;
  Object.assign(draft, normalizePayload(scenario));
  drawer.value = true;
  void loadPlugins();
  void loadCapabilityOptions();
}
function openDetail(scenario: Scenario) {
  detail.value = scenario;
  detailOpen.value = true;
}
function closeEditor() {
  if (!busy.value) drawer.value = false;
}
function askDelete(scenario: Scenario) {
  toDelete.value = scenario;
  deleteOpen.value = true;
}
function cancelDelete() {
  if (!deleting.value) deleteOpen.value = false;
}
function useScenario(scenario: Scenario) {
  detailOpen.value = false;
  if (chat.requestNewConversation(scenario.id)) void router.push('/agent/chat');
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  try {
    const payload = { ...draft, name: draft.name.trim() };
    if (editing.value) await put(`/agent-scenarios/${editing.value.id}`, payload);
    else await post('/agent-scenarios', payload);
    await app.refreshScenarios();
    drawer.value = false;
    filter.value = 'draft';
    app.toast('维护草稿已保存，已有会话不受影响');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}
async function copy(scenario: Scenario) {
  if (busy.value) return;
  busy.value = true;
  try {
    await post(`/agent-scenarios/${scenario.id}/copy`);
    await app.refreshScenarios();
    if (!maintenance.value) await router.replace({ query: { view: 'maintain' } });
    filter.value = 'draft';
    query.value = '';
    app.toast('已创建维护草稿，编辑并验证后可发布');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    busy.value = false;
  }
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
    app.toast('请先配置真实模型，试运行不会使用假模型', 'info');
    void router.push('/agent/models');
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
          <h1>企业场景</h1>
          <p v-if="!maintenance">按工作目标选择场景，进入对话直接开始。</p>
          <p v-else>编辑场景，试运行通过后发布。</p>
        </div>
        <div class="page-heading-actions">
          <!-- 使用目录：「维护场景」为主按钮；维护模式下让位给「新建场景」，避免两个主按钮并排 -->
          <a-button
            :type="maintenance ? 'default' : 'primary'"
            :aria-pressed="maintenance"
            @click="toggleMaintenance"
          >
            <template #icon><Icon :name="maintenance ? 'grid' : 'settings'" :size="16" /></template
            >{{ maintenance ? '返回使用目录' : '维护场景' }}
          </a-button>
          <a-button v-if="maintenance" type="primary" @click="edit()">
            <template #icon><Icon name="plus" :size="16" /></template>新建场景
          </a-button>
        </div>
      </div>
      <div class="collection-toolbar enterprise-collection-toolbar scenario-collection-toolbar">
        <a-segmented
          v-model:value="filter"
          class="scenario-filter"
          aria-label="场景筛选"
          :options="filterOptions"
        >
          <template #label="{ payload }">
            <span class="scenario-filter-label">{{ payload.label }}</span><span
              class="scenario-filter-count"
              >{{ payload.count }}</span
            >
          </template>
        </a-segmented>
        <a-input
          v-model:value="query"
          class="scenario-search"
          placeholder="搜索场景名称或描述"
          aria-label="搜索场景"
          allow-clear
        >
          <template #prefix><Icon name="search" :size="15" /></template>
        </a-input>
      </div>
      <div v-if="app.loading" class="loading-inline" role="status"><a-spin size="small" />正在读取场景…</div>
      <a-empty v-else-if="!filtered.length" class="enterprise-empty">
        <template #image
          ><span class="enterprise-empty-symbol"><Icon :name="query ? 'search' : 'grid'" :size="29" /></span
        ></template>
        <template #description>
          <h2>{{ query ? '没有找到匹配的场景' : '这个分类还没有场景' }}</h2>
          <p>
            {{
              query
                ? '试试其他关键词，或清除搜索。'
                : maintenance
                  ? '从预置模板创建草稿，或新建一个工作场景。'
                  : '新场景经过维护和发布后，会出现在这里。'
            }}
          </p>
        </template>
        <a-button
          v-if="query || filter !== 'all'"
          @click="
            query = '';
            filter = 'all';
          "
        >
          查看全部场景
        </a-button>
      </a-empty>
      <div v-else class="scenario-grid enterprise-scenario-grid">
        <article
          v-for="scenario in filtered"
          :key="scenario.id"
          class="scenario-card enterprise-scenario-card"
        >
          <div class="scenario-card-top">
            <span :class="['scene-icon', scenario.payload.icon]"
              ><Icon :name="scenario.payload.icon" :size="24" /></span
            ><a-tag
              :color="scenario.status === 'published' ? 'success' : undefined"
              class="scenario-status-tag"
              >{{ scenarioState(scenario) }}</a-tag
            ><a-button
              v-if="maintenance && scenario.space !== 'official'"
              type="text"
              class="icon-button delete-scenario"
              :aria-label="`删除场景 ${scenario.payload.name}`"
              title="删除场景"
              @click="askDelete(scenario)"
            >
              <template #icon><Icon name="trash" :size="15" /></template>
            </a-button>
          </div>
          <h2>{{ scenario.payload.name }}</h2>
          <p>{{ scenario.payload.description || '还没有添加场景描述。' }}</p>
          <div v-if="cardLabels(scenario.payload).length" class="scenario-capabilities">
            <a-tag v-for="item in cardLabels(scenario.payload).slice(0, 2)" :key="item.key"
              ><Icon :name="item.icon" :size="12" />{{ item.label }}</a-tag
            ><a-tag v-if="cardLabels(scenario.payload).length > 2"
              >+{{ cardLabels(scenario.payload).length - 2 }}</a-tag
            >
          </div>
          <div v-if="maintenance" class="scenario-card-meta">
            <span>{{ scenarioSource(scenario) }}<i>·</i>v{{ scenario.current_version }}</span
            ><span :class="{ 'verified-text': scenario.tested }"
              ><Icon :name="scenario.tested ? 'check' : 'circle'" :size="12" />{{
                scenario.tested ? '试运行通过' : '未试运行'
              }}</span
            >
          </div>
          <div class="scenario-card-actions">
            <a-button type="text" size="small" @click="openDetail(scenario)">详情</a-button
            ><a-button type="link" class="scenario-use" @click="useScenario(scenario)">
              {{ isAvailableScenario(scenario) ? '开始' : '预览草稿' }}<Icon name="arrow" :size="15" />
            </a-button>
          </div>
          <div v-if="maintenance" class="scenario-maintenance-actions">
            <a-button
              size="small"
              :disabled="busy"
              @click="scenario.space === 'official' ? copy(scenario) : edit(scenario)"
            >
              <template #icon
                ><Icon :name="scenario.space === 'official' ? 'copy' : 'edit'" :size="13" /></template
              >{{ scenario.space === 'official' ? '复制为草稿' : '编辑' }}
            </a-button>
            <a-button type="text" size="small" @click="versions(scenario)">
              版本 v{{ scenario.current_version }}
            </a-button>
            <a-button
              v-if="scenario.space !== 'official'"
              type="text"
              size="small"
              :disabled="testing !== null"
              :loading="testing === scenario.id"
              @click="test(scenario)"
            >
              <template #icon><Icon name="play" :size="13" /></template>试运行
            </a-button>
            <a-button
              v-if="scenario.space !== 'official' && scenario.status !== 'published' && scenario.tested"
              type="text"
              size="small"
              :disabled="busy"
              @click="publish(scenario)"
            >
              发布
            </a-button>
          </div>
        </article>
      </div>
    </div>
    <!-- class="drawer" 落在 .ant-drawer-content 上，复用全局 .drawer 下的正文排版（detail-block / version-entry 等） -->
    <a-drawer
      :open="detailOpen"
      :width="580"
      class="drawer scenario-detail"
      aria-label="场景详情"
      @close="detailOpen = false"
    >
      <template v-if="detail" #title>
        <div class="scenario-drawer-title">
          <h2>{{ detail.payload.name }}</h2>
          <p v-if="maintenance">
            {{ scenarioSource(detail) }} · {{ scenarioState(detail) }} · v{{ detail.current_version }}
          </p>
        </div>
      </template>
      <template v-if="detail">
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
          <a-button type="primary" @click="useScenario(detail)">
            {{ isAvailableScenario(detail) ? '开始' : '预览草稿' }}<Icon name="arrow" :size="16" />
          </a-button>
        </div>
      </template>
    </a-drawer>
    <!-- destroy-on-close：每次打开重建表单，避免沿用上一次的校验提示 -->
    <a-drawer
      :open="drawer"
      :width="640"
      class="drawer scenario-editor"
      aria-label="场景编辑器"
      :closable="!busy"
      :mask-closable="!busy"
      :keyboard="!busy"
      destroy-on-close
      @close="closeEditor"
    >
      <template #title>
        <div class="scenario-drawer-title">
          <span class="eyebrow">SCENARIO BUILDER</span>
          <h2>{{ editing ? '编辑场景' : '新建工作场景' }}</h2>
          <p>维护可复用的工作方式，保存后进入草稿。</p>
        </div>
      </template>
      <a-form id="scenario-form" :model="draft" :rules="rules" layout="vertical" @finish="save">
        <div class="form-section-title"><span>01</span>基本信息</div>
        <a-form-item label="场景名称" name="name">
          <a-input v-model:value="draft.name" :maxlength="128" placeholder="例如：研发需求评审助手" />
        </a-form-item>
        <a-form-item label="一句话介绍" name="description">
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
        <a-form-item label="角色、目标与工作方式" name="prompt_template">
          <a-textarea
            v-model:value="draft.prompt_template"
            class="prompt-editor"
            :rows="8"
            placeholder="定义角色、目标、步骤与输出标准。"
          />
        </a-form-item>
        <p class="field-hint">作为场景级指令使用。不会自动开始任务，也不会扩大工具权限。</p>
        <div class="form-section-title"><span>03</span>授权能力</div>
        <p class="field-hint">平台基础能力（默认开启）：每个会话都可使用，范围以平台策略为上限。</p>
        <a-checkbox v-for="tool in app.tools" :key="tool.name" class="tool-checkbox" checked disabled>
          <span class="tool-checkbox-icon"><Icon :name="tool.icon" :size="18" /></span>
          <div>
            <strong>{{ tool.title }}</strong><small>{{ tool.description }}</small>
          </div>
          <Icon v-if="tool.permission !== 'read'" name="edit" :size="15" />
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
          <p v-if="!optionsLoading && !chat.capabilityOptions?.skills.length" class="field-hint">
            还没有已发布的 Skill。<RouterLink to="/agent/skills">前往 Skill 中心</RouterLink>
          </p>
          <a-checkbox
            v-for="skill in chat.capabilityOptions?.skills ?? []"
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
              <strong>Skill #{{ id }}</strong
              ><small>已取消发布或已删除，取消勾选后才能保存</small>
            </div>
            <a-tag>不可用</a-tag>
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
          <p v-if="!optionsLoading && !chat.capabilityOptions?.mcpServers.length" class="field-hint">
            还没有可用的 MCP 服务。<RouterLink :to="{ path: '/agent/capabilities', query: { tab: 'mcp' } }"
              >前往能力中心接入</RouterLink
            >
          </p>
          <a-checkbox
            v-for="server in chat.capabilityOptions?.mcpServers ?? []"
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
            :disabled="!draft.capabilities.web_search && !chat.capabilityOptions?.web.available"
          >
            <span class="tool-checkbox-icon"><Icon name="globe" :size="18" /></span>
            <div>
              <strong>联网搜索</strong
              ><small>{{
                chat.capabilityOptions?.web.available
                  ? chat.capabilityOptions.web.fetchEnabled
                    ? '搜索 + 读取网页'
                    : '仅搜索'
                  : chat.capabilityOptions?.web.reason || '平台尚未开启联网搜索，请在治理中心配置'
              }}</small>
            </div>
            <a-tag v-if="chat.capabilityOptions && !chat.capabilityOptions.web.available">未开启</a-tag>
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
            v-for="plugin in plugins"
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
              >
            </div>
            <a-tag v-if="demoPlugin(plugin)" color="volcano" title="仅返回模拟数据，不连接真实系统"
              >演示数据</a-tag
            ><a-tag :color="plugin.auditStatus === 'approved' && plugin.enabled ? 'success' : undefined">{{
              plugin.auditStatus === 'approved' && plugin.enabled ? '已批准' : '不可用'
            }}</a-tag>
          </a-checkbox>
          <div
            v-for="plugin in plugins.filter(pluginSelected)"
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
          <a-button type="primary" html-type="submit" form="scenario-form" :loading="busy">
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
      class="drawer scenario-history"
      aria-label="场景版本历史"
      @close="historyOpen = false"
    >
      <template #title>
        <div class="scenario-drawer-title">
          <h2>{{ historyTitle }}</h2>
          <p>不可变版本记录</p>
        </div>
      </template>
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
  </main>
</template>

<style scoped>
/* ============ 页头动作按钮 ============ */
/* 尺寸、圆角、配色全部沿用 antd 默认；只补图标间距：
   icon 插槽里是 ForgeIcon 裸 <svg>，不是 .anticon，antd 不会给它和文字之间留空 */
.page-heading-actions :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.page-heading-actions :deep(.ant-btn > svg) {
  flex-shrink: 0;
}

/* ============ 场景筛选：antd Segmented ============ */
/* 浅灰底槽 + 白色浮起的选中项；只有选中文字用主题色，数量保持中性灰。
   选中 / 未选中的字重与数量盒子尺寸完全一致，切换时选项宽度不变，只有白色滑块平移。 */
.scenario-filter {
  flex: 0 1 auto;
  max-width: 100%;
  padding: 3px;
  overflow-x: auto;
  color: var(--btn-secondary-fg);
  background: var(--surface-muted);
  border-radius: 999px;
  scrollbar-width: none;
}
.scenario-filter::-webkit-scrollbar {
  display: none;
}
.scenario-filter :deep(.ant-segmented-item),
.scenario-filter :deep(.ant-segmented-thumb) {
  border-radius: 999px;
}
.scenario-filter :deep(.ant-segmented-item) {
  flex: 0 0 auto;
}
/* 未选中项悬停：不铺灰底，只加深文字，保持底槽干净 */
.scenario-filter :deep(.ant-segmented-item::after) {
  display: none;
}
.scenario-filter :deep(.ant-segmented-item:hover:not(.ant-segmented-item-selected)) {
  color: var(--color-text-primary);
}
.scenario-filter :deep(.ant-segmented-item-selected),
.scenario-filter :deep(.ant-segmented-thumb) {
  background: var(--surface-card);
  box-shadow: var(--shadow-sm);
}
.scenario-filter :deep(.ant-segmented-item-selected) {
  color: var(--color-brand);
}
.scenario-filter :deep(.ant-segmented-item-label) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  /* 26px 选项 + 上下 3px 底槽 = 32px，与 antd 默认按钮 / 输入框齐平 */
  min-height: 26px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 500;
  line-height: 26px;
  white-space: nowrap;
}
/* 鼠标点击不出现描边；只在键盘 Tab 聚焦时给出聚焦提示（无障碍需要） */
.scenario-filter :deep(.ant-segmented-item:has(.ant-segmented-item-input:focus-visible)) {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
/* 数量：两种状态共用同一个胶囊盒子，未选中时底色透明，选中时铺浅灰 */
.scenario-filter-count {
  display: inline-grid;
  min-width: 20px;
  height: 18px;
  place-items: center;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--color-text-secondary);
  background: transparent;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  line-height: 1;
  transition: background-color 150ms ease;
}
.scenario-filter :deep(.ant-segmented-item-selected) .scenario-filter-count {
  background: var(--surface-muted);
}

/* ============ 搜索框：antd 默认外观（圆角 / 边框 / 聚焦光圈），只定宽度 ============ */
.scenario-search {
  width: 240px;
  flex-shrink: 0;
}
.scenario-search :deep(.ant-input) {
  min-height: 0; /* 中和 style.css 全局 :where(input){min-height:41px}，否则输入框被撑高 */
}
.scenario-search :deep(.ant-input-prefix) {
  color: var(--color-text-tertiary);
}

/* ============ 卡片：状态 / 能力 / 动作 ============ */
/* 状态标签：发布=success，预置/草稿=中性 */
.scenario-card-top :deep(.ant-tag) {
  margin-left: auto;
  margin-inline-end: 0;
  border-radius: 999px;
  padding: 0 9px;
  font-size: 10px;
  font-weight: 600;
  line-height: 20px;
  color: var(--color-neutral-status-text);
  background: var(--color-neutral-status-bg);
  border-color: var(--color-neutral-status-border);
}
.scenario-card-top :deep(.ant-tag-success) {
  color: var(--color-success-text);
  background: var(--color-success-bg);
  border-color: var(--color-success-border);
}
/* 能力标签 */
.scenario-capabilities :deep(.ant-tag) {
  margin-inline-end: 0;
  padding: 4px 8px;
  border-radius: 8px;
  color: var(--color-text-secondary);
  background: var(--surface-subtle-bg);
  border-color: var(--border-light);
  font-size: 10px;
  line-height: 1.4;
}
/* 删除按钮（卡片右上，默认隐藏） */
.delete-scenario {
  width: 26px;
  height: 26px;
  padding: 0;
  margin-left: 0;
  color: var(--text-secondary);
  opacity: 0;
}
.scenario-card:hover .delete-scenario,
.scenario-card:focus-within .delete-scenario {
  opacity: 1;
}
/* 动作按钮（详情 / 开始） */
.scenario-card-actions :deep(.ant-btn) {
  height: auto;
  padding: 4px 6px;
  font-size: 11px;
}
.scenario-card-actions .scenario-use {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: auto;
  margin-left: auto;
  padding: 7px 12px;
  border-radius: 10px;
  color: var(--color-brand-active);
  background: var(--color-brand-muted);
  border: 1px solid var(--color-brand-border);
  font-size: 11px;
  font-weight: 650;
}
.scenario-card-actions .scenario-use:hover {
  color: var(--color-brand-active);
  background: var(--color-brand-subtle);
  border-color: var(--brand-300);
}
/* 维护动作条 */
.scenario-maintenance-actions :deep(.ant-btn) {
  height: auto;
  min-height: 29px;
  padding: 5px 9px;
  border-radius: 8px;
  font-size: 10px;
}

/* ============ 空态收敛 ============ */
.scenarios-page .enterprise-empty {
  min-height: 220px;
  padding: 40px 24px;
}
.enterprise-empty :deep(.ant-empty-image) {
  height: auto;
  margin-bottom: 14px;
}
.enterprise-empty-symbol {
  width: 56px;
  height: 56px;
  margin-bottom: 18px;
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
.scenario-drawer-title {
  min-width: 0;
}
.scenario-drawer-title .eyebrow {
  display: block;
  margin-bottom: 4px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 1.5px;
  color: var(--text-subtle);
}
.scenario-drawer-title h2 {
  margin: 0;
  color: var(--ink);
  font-size: 18px;
  font-weight: 550;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.scenario-drawer-title p {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.7;
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
