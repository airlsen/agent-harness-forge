<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { usePlatform } from '../../stores/platform';
import { useConversation } from '../../stores/conversation';
import { api, post, put, remove } from '../../api/client';
import type { Scenario, ScenarioPayload } from '../../types/platform';
import Icon from '../../components/ForgeIcon.vue';
const app = usePlatform(),
  chat = useConversation(),
  router = useRouter();
const query = ref(''),
  filter = ref('all'),
  drawer = ref(false),
  editing = ref<Scenario | null>(null),
  busy = ref(false),
  testing = ref<number | null>(null),
  toDelete = ref<Scenario | null>(null),
  versionHistory = ref<any[] | null>(null),
  historyTitle = ref('');
const blank = (): ScenarioPayload => ({
  name: '',
  description: '',
  icon: 'sparkles',
  prompt_template: '',
  capabilities: {
    plugin_names: ['forge-runtime'],
    builtin_tool_names: [],
    skill_ids: [],
    mcp_server_ids: [],
    project_ids: [],
  },
  model: 'default',
  execution_mode: 'standard',
});
const draft = reactive<ScenarioPayload>(blank());
const filtered = computed(() =>
  app.scenarios.filter(
    (s) =>
      (filter.value === 'all' || s.space === filter.value) &&
      (s.payload.name + s.payload.description).toLowerCase().includes(query.value.toLowerCase()),
  ),
);
function edit(scenario?: Scenario) {
  editing.value = scenario ?? null;
  Object.assign(draft, scenario ? JSON.parse(JSON.stringify(scenario.payload)) : blank());
  drawer.value = true;
}
function useScenario(scenario: Scenario) {
  chat.newConversation(scenario.id);
  chat.input = '';
  chat.draftAttachments = [];
  void router.push('/agent/chat');
}
async function save() {
  if (!draft.name.trim()) {
    app.toast('请填写场景名称', 'error');
    return;
  }
  busy.value = true;
  try {
    const payload = { ...draft, name: draft.name.trim() };
    if (editing.value) await put(`/agent-scenarios/${editing.value.id}`, payload);
    else await post('/agent-scenarios', payload);
    await app.refreshScenarios();
    drawer.value = false;
    app.toast('场景草稿已保存，已有会话不受影响');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}
async function copy(scenario: Scenario) {
  try {
    await post(`/agent-scenarios/${scenario.id}/copy`);
    await app.refreshScenarios();
    filter.value = 'personal';
    app.toast('已复制到我的场景，可继续编辑');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
}
async function discard() {
  if (!toDelete.value) return;
  try {
    await remove(`/agent-scenarios/${toDelete.value.id}`);
    await app.refreshScenarios();
    toDelete.value = null;
    app.toast('场景已删除，历史会话快照仍保留');
  } catch (e) {
    app.toast((e as Error).message, 'error');
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
  try {
    await post(`/agent-scenarios/${scenario.id}/publish`);
    await app.refreshScenarios();
    app.toast('当前版本已发布到本工作空间');
  } catch (e) {
    app.toast((e as Error).message, 'error');
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
  <main class="page-content">
    <div class="page-heading">
      <div>
        <div class="eyebrow">SCENARIOS</div>
        <h1>
          场景中心 <span class="heading-count">{{ app.scenarios.length }}</span>
        </h1>
        <p>把一次好的工作方式，沉淀为下一次可以直接使用的能力。</p>
      </div>
      <button class="button primary" @click="edit()"><Icon name="plus" :size="17" />新建场景</button>
    </div>
    <section class="scenario-feature">
      <div>
        <span class="tag warm">FROM IDEA TO ACTION</span>
        <h2>选好场景，<span>让 Agent 更懂你的工作。</span></h2>
        <p>每个场景都是提示词、工具和策略的组合。选择模板直接开始，或创建属于你的装配方案。</p>
        <RouterLink to="/agent/chat">回到工作台 <Icon name="arrow" :size="15" /></RouterLink>
      </div>
      <div class="scenario-feature-art">
        <span><Icon name="code" :size="24" /></span><span><Icon name="sparkles" :size="29" /></span
        ><span><Icon name="file" :size="24" /></span><i></i>
      </div>
    </section>
    <div class="collection-toolbar">
      <div class="collection-tabs">
        <button
          v-for="item in [
            { id: 'all', label: '全部场景' },
            { id: 'official', label: '官方模板' },
            { id: 'personal', label: '我的场景' },
          ]"
          :key="item.id"
          :class="{ selected: filter === item.id }"
          @click="filter = item.id"
        >
          {{ item.label
          }}<span>{{
            item.id === 'all' ? app.scenarios.length : app.scenarios.filter((s) => s.space === item.id).length
          }}</span>
        </button>
      </div>
      <label class="search-field"
        ><Icon name="search" :size="17" /><input
          v-model="query"
          placeholder="搜索场景名称或描述"
          aria-label="搜索场景"
      /></label>
    </div>
    <div v-if="!filtered.length" class="empty-state">
      <Icon name="grid" :size="34" />
      <h3>{{ query ? '没有找到匹配的场景' : '给你的工作，创建一个专属场景' }}</h3>
      <p>
        {{ query ? '试试其他关键词。' : '从名称、提示词和已授权工具开始，先保存草稿，再用真实模型试运行。' }}
      </p>
      <button v-if="!query" class="button secondary" @click="edit()">创建场景</button>
    </div>
    <div v-else class="scenario-grid">
      <article v-for="scenario in filtered" :key="scenario.id" class="scenario-card">
        <div class="scenario-card-top">
          <span :class="['scene-icon', scenario.payload.icon]"
            ><Icon :name="scenario.payload.icon" :size="24" /></span
          ><span
            :class="[
              'tag',
              scenario.space === 'official'
                ? 'soft'
                : scenario.status === 'published'
                  ? 'success'
                  : 'neutral',
            ]"
            >{{
              scenario.space === 'official' ? '官方模板' : scenario.status === 'published' ? '已发布' : '草稿'
            }}</span
          ><button
            v-if="scenario.space === 'personal'"
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
          <span v-if="!scenario.payload.capabilities.builtin_tool_names.length"
            ><Icon name="message" :size="12" />纯对话</span
          ><span v-for="name in scenario.payload.capabilities.builtin_tool_names.slice(0, 2)" :key="name"
            ><Icon :name="app.tools.find((t) => t.name === name)?.icon ?? 'box'" :size="12" />{{
              app.tools.find((t) => t.name === name)?.title ?? name
            }}</span
          ><span v-if="scenario.payload.capabilities.builtin_tool_names.length > 2"
            >+{{ scenario.payload.capabilities.builtin_tool_names.length - 2 }}</span
          >
        </div>
        <div class="scenario-card-meta">
          <button @click="versions(scenario)">
            版本 v{{ scenario.current_version }}<Icon name="chevron" :size="11" /></button
          ><span :class="{ 'verified-text': scenario.tested }"
            ><Icon :name="scenario.tested ? 'check' : 'circle'" :size="12" />{{
              scenario.tested ? '试运行通过' : '未试运行'
            }}</span
          >
        </div>
        <div class="scenario-card-actions">
          <button
            class="button secondary small"
            @click="scenario.space === 'official' ? copy(scenario) : edit(scenario)"
          >
            <Icon :name="scenario.space === 'official' ? 'copy' : 'edit'" :size="14" />{{
              scenario.space === 'official' ? '复制' : '编辑'
            }}</button
          ><button
            v-if="scenario.space === 'personal'"
            class="button text small"
            :disabled="testing !== null"
            @click="test(scenario)"
          >
            <span v-if="testing === scenario.id" class="loader small"></span
            ><Icon v-else name="play" :size="13" />试运行</button
          ><button
            v-if="scenario.space === 'personal' && scenario.status !== 'published' && scenario.tested"
            class="button text small"
            @click="publish(scenario)"
          >
            发布</button
          ><button class="scenario-use" @click="useScenario(scenario)">
            使用场景<Icon name="arrow" :size="15" />
          </button>
        </div>
      </article>
    </div>
    <div class="page-note">
      <Icon
        name="info"
        :size="14"
      />草稿可在个人工作空间使用；发布前必须通过当前版本的真实模型试运行。官方场景是预置模板，不代表已完成你的业务验证。
    </div>
    <div v-if="drawer" class="drawer-backdrop" @click.self="drawer = false">
      <section class="drawer scenario-editor" role="dialog" aria-modal="true" aria-label="场景编辑器">
        <header>
          <div>
            <span class="eyebrow">SCENARIO BUILDER</span>
            <h2>{{ editing ? '编辑场景' : '创建你的场景' }}</h2>
            <p>装配提示词与能力，执行时生成不可变快照。</p>
          </div>
          <button class="icon-button" aria-label="关闭编辑器" @click="drawer = false">
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
            placeholder="告诉使用者，这个场景能帮他完成什么。"
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
          <label for="scenario-prompt">角色、目标与工作方式</label
          ><textarea
            id="scenario-prompt"
            v-model="draft.prompt_template"
            class="prompt-editor"
            rows="8"
            placeholder="你是谁？需要完成什么任务？有哪些步骤、标准与注意事项？"
          ></textarea>
          <p class="field-hint">
            此内容作为场景级系统指令，不会自动替用户执行任务。AI Creative 生成尚未接入，本版使用手动装配。
          </p>
          <div class="form-section-title"><span>03</span>授权能力</div>
          <label v-for="tool in app.tools" :key="tool.name" class="tool-checkbox"
            ><input v-model="draft.capabilities.builtin_tool_names" type="checkbox" :value="tool.name" /><span
              class="tool-checkbox-icon"
              ><Icon :name="tool.icon" :size="18"
            /></span>
            <div>
              <strong>{{ tool.title }}</strong><small>{{ tool.description }}</small>
            </div>
            <Icon v-if="tool.permission === 'approval'" name="shield" :size="15"
          /></label>
          <div class="form-section-title"><span>04</span>运行配置</div>
          <div class="static-form-row">
            <span>模型路由</span
            ><strong
              >default <small>{{ app.connection?.model || '模型中心尚未配置' }}</small></strong
            >
          </div>
          <div class="static-form-row"><span>执行模式</span><strong>Standard</strong></div>
          <div class="editor-safety">
            <Icon name="shield" :size="17" />
            <p>平台安全策略会与此处的能力授权取交集。保存仅生成草稿，未试运行不能发布。</p>
          </div>
        </form>
        <footer>
          <button class="button secondary" @click="drawer = false">取消</button
          ><button type="submit" form="scenario-form" class="button primary" :disabled="busy">
            <span v-if="busy" class="loader small"></span><Icon v-else name="save" :size="16" />保存草稿
          </button>
        </footer>
      </section>
    </div>
    <div v-if="toDelete" class="modal-backdrop" @click.self="toDelete = null">
      <section class="modal confirm-modal" role="dialog" aria-modal="true" aria-label="删除场景确认">
        <span class="confirm-icon"><Icon name="trash" :size="25" /></span>
        <h2>删除「{{ toDelete.payload.name }}」？</h2>
        <p>该场景将不再出现在场景中心。已有会话的配置快照和审计记录不会删除。</p>
        <footer>
          <button class="button secondary" @click="toDelete = null">取消</button
          ><button class="button danger" @click="discard">确认删除</button>
        </footer>
      </section>
    </div>
    <div v-if="versionHistory" class="drawer-backdrop" @click.self="versionHistory = null">
      <section class="drawer" role="dialog" aria-modal="true" aria-label="场景版本历史">
        <header>
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
              ><span>{{ new Date(version.createdAt).toLocaleString('zh-CN') }}</span>
            </div>
            <p>{{ version.changeLog }}</p>
            <code>SHA256 {{ version.bundleHash.slice(0, 24) }}…</code>
            <details>
              <summary>查看此版本装配单</summary>
              <pre>{{ JSON.stringify(version.payload, null, 2) }}</pre>
            </details>
          </article>
        </div>
      </section>
    </div>
  </main>
</template>
