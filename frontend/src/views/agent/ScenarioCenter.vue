<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlatform } from '../../stores/platform';
import { MAX_SESSION_MCP, MAX_SESSION_SKILLS, useConversation } from '../../stores/conversation';
import { api, post, put, remove } from '../../api/client';
import { formatDate, isAvailableScenario, scenarioSource, scenarioState } from '../../utils/presentation';
import type { Scenario, ScenarioPayload } from '../../types/platform';
import type { PluginPackage } from '../../types/plugin';
import Icon from '../../components/ForgeIcon.vue';
import DialogShell from '../../components/DialogShell.vue';

const app = usePlatform();
const chat = useConversation();
const router = useRouter();
const route = useRoute();
const query = ref('');
const filter = ref('all');
const drawer = ref(false);
const editing = ref<Scenario | null>(null);
const detail = ref<Scenario | null>(null);
const busy = ref(false);
const testing = ref<number | null>(null);
const toDelete = ref<Scenario | null>(null);
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
const base = computed(() => (maintenance.value ? app.scenarios : app.availableScenarios));
const filters = computed(() => [
  { id: 'all', label: '全部场景', count: base.value.length },
  { id: 'template', label: '平台预置', count: base.value.filter((s) => s.status === 'template').length },
  { id: 'published', label: '已发布', count: base.value.filter((s) => s.status === 'published').length },
  ...(maintenance.value
    ? [{ id: 'draft', label: '维护草稿', count: base.value.filter((s) => s.status === 'draft').length }]
    : []),
]);
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
function useScenario(scenario: Scenario) {
  detail.value = null;
  if (chat.requestNewConversation(scenario.id)) void router.push('/agent/chat');
}
async function save() {
  if (!draft.name.trim()) {
    app.toast('请填写场景名称', 'error');
    return;
  }
  if (!draft.prompt_template.trim()) {
    app.toast('请填写场景提示词', 'error');
    return;
  }
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
    toDelete.value = null;
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
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
}
</script>
<template>
  <main class="page-content enterprise-page scenarios-page">
    <div class="enterprise-page-inner">
      <div class="page-heading">
        <div>
          <h1>
            企业场景<span class="heading-count">{{ app.availableScenarios.length }}</span>
          </h1>
          <p>把经过整理的工作方式，变成可以共同复用的起点。</p>
        </div>
        <div class="page-heading-actions">
          <button class="button secondary" :aria-pressed="maintenance" @click="toggleMaintenance">
            <Icon :name="maintenance ? 'grid' : 'settings'" :size="16" />{{
              maintenance ? '返回使用目录' : '维护场景'
            }}</button
          ><button v-if="maintenance" class="button primary" @click="edit()">
            <Icon name="plus" :size="17" />新建场景
          </button>
        </div>
      </div>
      <section v-if="!maintenance" class="enterprise-scenario-intro">
        <div>
          <span class="enterprise-shared-label"><Icon name="building" :size="14" />一份场景，共同复用</span>
          <h2>选择工作方式，<span>带着专业能力开始。</span></h2>
          <p>预先组合提示词、工具与执行边界。选好场景，直接描述这次要完成的目标。</p>
        </div>
        <div class="scenario-stack-art" aria-hidden="true">
          <span><Icon name="file" :size="23" /></span><span><Icon name="sparkles" :size="31" /></span
          ><span><Icon name="code" :size="23" /></span>
        </div>
      </section>
      <div v-else class="maintenance-notice">
        <Icon name="edit" :size="19" />
        <div>
          <strong>场景维护视图</strong>
          <p>预置模板只读；可复制为维护草稿。草稿通过当前模型与策略下的试运行后，才能发布到使用目录。</p>
        </div>
      </div>
      <div class="collection-toolbar enterprise-collection-toolbar">
        <div class="collection-tabs" aria-label="场景筛选">
          <button
            v-for="item in filters"
            :key="item.id"
            :class="{ selected: filter === item.id }"
            :aria-pressed="filter === item.id"
            @click="filter = item.id"
          >
            {{ item.label }}<span>{{ item.count }}</span>
          </button>
        </div>
        <label class="search-field"
          ><Icon name="search" :size="17" /><input
            v-model="query"
            placeholder="搜索场景名称或描述"
            aria-label="搜索场景"
        /></label>
      </div>
      <div v-if="app.loading" class="loading-inline" role="status">
        <span class="loader"></span>正在读取场景…
      </div>
      <div v-else-if="!filtered.length" class="enterprise-empty">
        <span class="enterprise-empty-symbol"><Icon :name="query ? 'search' : 'grid'" :size="29" /></span>
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
        <button
          v-if="query || filter !== 'all'"
          class="button secondary"
          @click="
            query = '';
            filter = 'all';
          "
        >
          查看全部场景</button
        ><button v-else-if="maintenance" class="button primary" @click="edit()">新建场景</button>
      </div>
      <div v-else class="scenario-grid enterprise-scenario-grid">
        <article
          v-for="scenario in filtered"
          :key="scenario.id"
          class="scenario-card enterprise-scenario-card"
        >
          <div class="scenario-card-top">
            <span :class="['scene-icon', scenario.payload.icon]"
              ><Icon :name="scenario.payload.icon" :size="24" /></span
            ><span :class="['tag', scenario.status === 'published' ? 'success' : 'neutral']">{{
              scenarioState(scenario)
            }}</span
            ><button
              v-if="maintenance && scenario.space !== 'official'"
              class="icon-button delete-scenario"
              :aria-label="`删除场景 ${scenario.payload.name}`"
              title="删除场景"
              @click="toDelete = scenario"
            >
              <Icon name="trash" :size="15" />
            </button>
          </div>
          <h2>{{ scenario.payload.name }}</h2>
          <p>{{ scenario.payload.description || '还没有添加场景描述。' }}</p>
          <div class="scenario-capabilities">
            <span v-if="!cardLabels(scenario.payload).length"
              ><Icon name="message" :size="12" />对话与文件</span
            ><span v-for="item in cardLabels(scenario.payload).slice(0, 2)" :key="item.key"
              ><Icon :name="item.icon" :size="12" />{{ item.label }}</span
            ><span v-if="cardLabels(scenario.payload).length > 2"
              >+{{ cardLabels(scenario.payload).length - 2 }}</span
            >
          </div>
          <div class="scenario-card-meta">
            <span>{{ scenarioSource(scenario) }}<i>·</i>v{{ scenario.current_version }}</span
            ><span v-if="maintenance" :class="{ 'verified-text': scenario.tested }"
              ><Icon :name="scenario.tested ? 'check' : 'circle'" :size="12" />{{
                scenario.tested ? '试运行通过' : '未试运行'
              }}</span
            >
          </div>
          <div class="scenario-card-actions">
            <button class="button text small" @click="detail = scenario">查看详情</button
            ><button class="scenario-use" @click="useScenario(scenario)">
              {{ isAvailableScenario(scenario) ? '开始会话' : '预览草稿' }}<Icon name="arrow" :size="15" />
            </button>
          </div>
          <div v-if="maintenance" class="scenario-maintenance-actions">
            <button
              class="button secondary small"
              :disabled="busy"
              @click="scenario.space === 'official' ? copy(scenario) : edit(scenario)"
            >
              <Icon :name="scenario.space === 'official' ? 'copy' : 'edit'" :size="13" />{{
                scenario.space === 'official' ? '复制为草稿' : '编辑'
              }}</button
            ><button class="button text small" @click="versions(scenario)">
              版本 v{{ scenario.current_version }}</button
            ><button
              v-if="scenario.space !== 'official'"
              class="button text small"
              :disabled="testing !== null"
              @click="test(scenario)"
            >
              <span v-if="testing === scenario.id" class="loader small"></span
              ><Icon v-else name="play" :size="13" />试运行</button
            ><button
              v-if="scenario.space !== 'official' && scenario.status !== 'published' && scenario.tested"
              class="button text small"
              :disabled="busy"
              @click="publish(scenario)"
            >
              发布
            </button>
          </div>
        </article>
      </div>
      <div class="page-note">
        <Icon name="info" :size="14" /><span
          >使用目录只展示预置模板与已发布场景；维护草稿不会出现在首页推荐中。预置模板不代表已通过你的业务验证，开始前仍需配置真实模型。</span
        >
      </div>
    </div>
    <DialogShell v-if="detail" label="场景详情" panel-class="scenario-detail" @close="detail = null"
      ><header>
        <div>
          <div class="eyebrow">SCENARIO OVERVIEW</div>
          <h2>{{ detail.payload.name }}</h2>
          <p>{{ scenarioSource(detail) }} · {{ scenarioState(detail) }} · v{{ detail.current_version }}</p>
        </div>
        <button class="icon-button" aria-label="关闭场景详情" @click="detail = null">
          <Icon name="close" :size="21" />
        </button>
      </header>
      <div class="drawer-body">
        <div class="detail-block">
          <h3>适合什么工作</h3>
          <p>{{ detail.payload.description || '维护者尚未填写场景说明。' }}</p>
        </div>
        <div class="detail-block">
          <h3>可用能力</h3>
          <p>平台基础能力（时间、会话文件读写）始终开启。</p>
          <p v-if="!extensionLabels(detail.payload).length">本场景未绑定 Skill、MCP 服务或联网搜索。</p>
          <RouterLink
            v-for="item in extensionLabels(detail.payload)"
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
        <div class="detail-block">
          <h3>工作规范</h3>
          <pre class="scenario-prompt-preview">{{ detail.payload.prompt_template }}</pre>
        </div>
        <div class="detail-block">
          <h3>版本信息</h3>
          <dl class="resource-metadata">
            <div>
              <dt>当前版本</dt>
              <dd>v{{ detail.current_version }}</dd>
            </div>
            <div>
              <dt>维护账号</dt>
              <dd>{{ detail.space === 'official' ? '平台预置' : detail.owner_id }}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{{ formatDate(detail.updatedAt, true) }}</dd>
            </div>
          </dl>
          <button
            class="text-link"
            @click="
              versions(detail);
              detail = null;
            "
          >
            查看版本记录 <Icon name="arrow" :size="14" />
          </button>
        </div>
        <div class="editor-safety">
          <Icon name="shield" :size="17" />
          <p>新会话会记录本次场景、模型与策略快照。维护场景不会静默改写已有会话。</p>
        </div>
      </div>
      <footer>
        <button class="button primary" @click="useScenario(detail)">
          {{ isAvailableScenario(detail) ? '使用此场景' : '预览此草稿' }}<Icon name="arrow" :size="16" />
        </button></footer
    ></DialogShell>
    <DialogShell
      v-if="drawer"
      label="场景编辑器"
      panel-class="scenario-editor"
      @close="!busy && (drawer = false)"
      ><header>
        <div>
          <span class="eyebrow">SCENARIO BUILDER</span>
          <h2>{{ editing ? '编辑场景' : '新建工作场景' }}</h2>
          <p>维护可复用的工作方式，保存后进入草稿。</p>
        </div>
        <button class="icon-button" :disabled="busy" aria-label="关闭编辑器" @click="drawer = false">
          <Icon name="close" :size="21" />
        </button>
      </header>
      <form id="scenario-form" class="drawer-body" @submit.prevent="save">
        <div class="form-section-title"><span>01</span>基本信息</div>
        <label for="scenario-name">场景名称 <span class="required">*</span></label
        ><input
          id="scenario-name"
          v-model="draft.name"
          maxlength="128"
          placeholder="例如：研发需求评审助手"
          required
        /><label for="scenario-description">一句话介绍</label
        ><textarea
          id="scenario-description"
          v-model="draft.description"
          rows="2"
          maxlength="512"
          placeholder="告诉使用者，这个场景适合什么工作。"
        ></textarea
        ><label>场景图标</label>
        <div class="icon-options">
          <button
            v-for="icon in ['sparkles', 'code', 'file', 'chart', 'book', 'shield']"
            :key="icon"
            type="button"
            :aria-label="`选择图标 ${icon}`"
            :class="{ selected: draft.icon === icon }"
            @click="draft.icon = icon"
          >
            <Icon :name="icon" :size="22" />
          </button>
        </div>
        <div class="form-section-title"><span>02</span>场景提示词</div>
        <label for="scenario-prompt">角色、目标与工作方式 <span class="required">*</span></label
        ><textarea
          id="scenario-prompt"
          v-model="draft.prompt_template"
          class="prompt-editor"
          rows="8"
          required
          placeholder="定义角色、目标、步骤与输出标准。"
        ></textarea>
        <p class="field-hint">作为场景级指令使用。不会自动开始任务，也不会扩大工具权限。</p>
        <div class="form-section-title"><span>03</span>授权能力</div>
        <p class="field-hint">平台基础能力（默认开启）：每个会话都可使用，范围以平台策略为上限。</p>
        <label v-for="tool in app.tools" :key="tool.name" class="tool-checkbox"
          ><input type="checkbox" checked disabled /><span class="tool-checkbox-icon"
            ><Icon :name="tool.icon" :size="18"
          /></span>
          <div>
            <strong>{{ tool.title }}</strong><small>{{ tool.description }}</small>
          </div>
          <Icon v-if="tool.permission !== 'read'" name="edit" :size="15"
        /></label>
        <section class="scenario-plugin-picker" aria-labelledby="scenario-skill-title">
          <header>
            <div>
              <h3 id="scenario-skill-title">Skill</h3>
              <p>
                绑定已发布的 Skill，发布场景时固定到当前修订。模型按需加载，用户也可在聊天中输入 /名称
                直接调用。最多 {{ MAX_SESSION_SKILLS }} 个。
              </p>
            </div>
            <span v-if="optionsLoading" class="loader small"></span>
          </header>
          <p v-if="!optionsLoading && !chat.capabilityOptions?.skills.length" class="field-hint">
            还没有已发布的 Skill。<RouterLink to="/agent/skills">前往 Skill 中心</RouterLink>
          </p>
          <label
            v-for="skill in chat.capabilityOptions?.skills ?? []"
            :key="skill.id"
            class="scenario-plugin-option"
            ><input
              type="checkbox"
              :checked="draft.capabilities.skill_ids.includes(skill.id)"
              @change="setSkill(skill.id, ($event.target as HTMLInputElement).checked)"
            /><span class="tool-checkbox-icon"><Icon name="book" :size="18" /></span>
            <div>
              <strong>{{ skill.title }}</strong><small
                >/{{ skill.name }}<template v-if="skill.version"> · v{{ skill.version }}</template
                ><template v-if="skill.description"> · {{ skill.description }}</template></small
              >
            </div></label
          >
          <label v-for="id in missingSkills" :key="`missing-skill-${id}`" class="scenario-plugin-option"
            ><input type="checkbox" checked @change="setSkill(id, false)" /><span class="tool-checkbox-icon"
              ><Icon name="book" :size="18"
            /></span>
            <div>
              <strong>Skill #{{ id }}</strong
              ><small>已取消发布或已删除，取消勾选后才能保存</small>
            </div>
            <span class="tag neutral">不可用</span></label
          >
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
          <label
            v-for="server in chat.capabilityOptions?.mcpServers ?? []"
            :key="server.id"
            class="scenario-plugin-option"
            ><input
              type="checkbox"
              :checked="draft.capabilities.mcp_server_ids.includes(server.id)"
              @change="setServer(server.id, ($event.target as HTMLInputElement).checked)"
            /><span class="tool-checkbox-icon"><Icon name="plug" :size="18" /></span>
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
            </div></label
          >
          <label v-for="id in missingServers" :key="`missing-mcp-${id}`" class="scenario-plugin-option"
            ><input type="checkbox" checked @change="setServer(id, false)" /><span class="tool-checkbox-icon"
              ><Icon name="plug" :size="18"
            /></span>
            <div>
              <strong>MCP #{{ id }}</strong
              ><small>已停用或连接异常，取消勾选后才能保存</small>
            </div>
            <span class="tag neutral">不可用</span></label
          >
        </section>
        <section class="scenario-plugin-picker" aria-labelledby="scenario-web-title">
          <header>
            <div>
              <h3 id="scenario-web-title">联网</h3>
              <p>开启后模型可搜索网络并读取公网网页，回答需注明来源。每次搜索按一次模型调用计费。</p>
            </div>
          </header>
          <label class="scenario-plugin-option"
            ><input
              v-model="draft.capabilities.web_search"
              type="checkbox"
              :disabled="!draft.capabilities.web_search && !chat.capabilityOptions?.web.available"
            /><span class="tool-checkbox-icon"><Icon name="globe" :size="18" /></span>
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
            <span v-if="chat.capabilityOptions && !chat.capabilityOptions.web.available" class="tag neutral"
              >未开启</span
            ></label
          >
        </section>
        <section class="scenario-plugin-picker" aria-labelledby="scenario-plugin-title">
          <header>
            <div>
              <h3 id="scenario-plugin-title">已批准插件</h3>
              <p>选择审核通过的插件及具体工具。插件工具会随场景版本固定，不能在会话中临时扩大权限。</p>
            </div>
            <span v-if="pluginsLoading" class="loader small"></span>
          </header>
          <p v-if="!pluginsLoading && !plugins.length" class="field-hint">当前没有可用于场景的已批准插件。</p>
          <label v-for="plugin in plugins" :key="plugin.package" class="scenario-plugin-option"
            ><input
              type="checkbox"
              :checked="pluginSelected(plugin)"
              :disabled="plugin.auditStatus !== 'approved' || !plugin.enabled"
              @change="setPluginSelected(plugin, ($event.target as HTMLInputElement).checked)"
            /><span class="tool-checkbox-icon"><Icon name="blocks" :size="18" /></span>
            <div>
              <strong>{{ plugin.displayName }}</strong><small
                >{{ plugin.description }} · v{{ plugin.version }}</small
              >
            </div>
            <span v-if="demoPlugin(plugin)" class="tag warm" title="仅返回模拟数据，不连接真实系统"
              >演示数据</span
            ><span
              :class="['tag', plugin.auditStatus === 'approved' && plugin.enabled ? 'success' : 'neutral']"
              >{{ plugin.auditStatus === 'approved' && plugin.enabled ? '已批准' : '不可用' }}</span
            ></label
          >
          <div
            v-for="plugin in plugins.filter(pluginSelected)"
            :key="`${plugin.package}-tools`"
            class="scenario-plugin-tools"
          >
            <strong>{{ plugin.displayName }} · 选择工具</strong
            ><label v-for="tool in plugin.tools" :key="tool.name" class="scenario-plugin-tool"
              ><input
                type="checkbox"
                :checked="pluginToolSelected(plugin, tool.name)"
                @change="setPluginTool(plugin, tool.name, ($event.target as HTMLInputElement).checked)"
              /><span
                ><b>{{ tool.title }}</b
                ><small>{{ tool.description }}</small></span
              ><span :class="['tag', tool.permission === 'approval' ? 'warm' : 'neutral']">{{
                tool.permission === 'approval' ? '需审批' : '只读'
              }}</span></label
            >
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
        <div class="editor-safety">
          <Icon name="shield" :size="17" />
          <p>
            实际工具范围取场景与平台策略交集；用户可在聊天中临时追加 Skill、MCP
            与联网，但不能取消场景绑定项。草稿须试运行通过后才能发布。
          </p>
        </div>
      </form>
      <footer>
        <button class="button secondary" :disabled="busy" @click="drawer = false">取消</button
        ><button type="submit" form="scenario-form" class="button primary" :disabled="busy">
          <span v-if="busy" class="loader small"></span><Icon v-else name="save" :size="16" />保存草稿
        </button>
      </footer>
    </DialogShell>
    <DialogShell
      v-if="toDelete"
      variant="modal"
      label="删除场景确认"
      panel-class="confirm-modal"
      @close="!deleting && (toDelete = null)"
      ><span class="confirm-icon"><Icon name="trash" :size="25" /></span>
      <h2>删除「{{ toDelete.payload.name }}」？</h2>
      <p>该场景将从目录移出，已有会话的配置快照和审计记录仍保留。</p>
      <footer>
        <button class="button secondary" :disabled="deleting" @click="toDelete = null">取消</button
        ><button class="button danger" :disabled="deleting" @click="discard">
          <span v-if="deleting" class="loader small"></span>确认删除
        </button>
      </footer></DialogShell
    >
    <DialogShell v-if="versionHistory" label="场景版本历史" @close="versionHistory = null"
      ><header>
        <div>
          <h2>{{ historyTitle }}</h2>
          <p>不可变版本记录</p>
        </div>
        <button class="icon-button" aria-label="关闭版本历史" @click="versionHistory = null">
          <Icon name="close" :size="20" />
        </button>
      </header>
      <div class="drawer-body">
        <article v-for="version in versionHistory" :key="version.version" class="version-entry">
          <div>
            <strong>v{{ version.version }}</strong
            ><span>{{ formatDate(version.createdAt, true) }}</span>
          </div>
          <p>{{ version.changeLog }}</p>
          <code>SHA256 {{ version.bundleHash.slice(0, 24) }}…</code>
          <details>
            <summary>查看此版本装配单</summary>
            <pre>{{ JSON.stringify({ payload: version.payload, bundle: version.bundle }, null, 2) }}</pre>
          </details>
        </article>
      </div></DialogShell
    >
  </main>
</template>
