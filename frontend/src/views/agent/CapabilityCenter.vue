<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../../api/client';
import { usePlatform } from '../../stores/platform';
import { useConversation } from '../../stores/conversation';
import type { Scenario, Tool } from '../../types/platform';
import Icon from '../../components/ForgeIcon.vue';
import DialogShell from '../../components/DialogShell.vue';

type RuntimeComponent = {
  name: string;
  package: string;
  description: string;
  version: string;
  type: string;
  extensionPoints: string[];
  permissions: string[];
};
type McpServer = {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  status: string;
  lastError: string;
  tools: { name: string; description: string }[];
  serverInfo: Record<string, unknown>;
  hasCredentials: boolean;
};
type Availability = { items: unknown[]; available: boolean; reason: string };
const app = usePlatform();
const chat = useConversation();
const route = useRoute();
const router = useRouter();
const query = ref('');
const loading = ref(true);
const loadError = ref('');
const components = ref<RuntimeComponent[]>([]);
const skills = ref<Availability | null>(null);
const mcp = ref<{ items: McpServer[]; available: boolean; reason: string } | null>(null);
const mcpJson = ref('');
const mcpBusy = ref(false);
const mcpMessage = ref('');
const mcpEditorOpen = ref(false);
const detail = ref<Tool | null>(null);
const componentDetail = ref<RuntimeComponent | null>(null);
const tab = computed(() =>
  ['tools', 'skills', 'mcp'].includes(String(route.query.tab)) ? String(route.query.tab) : 'tools',
);
const tabs = computed(() => [
  { id: 'tools', label: '插件与工具', icon: 'wrench', count: app.tools.length },
  { id: 'skills', label: 'Skills 技能', icon: 'book', count: skills.value?.items.length },
  { id: 'mcp', label: 'MCP 服务', icon: 'plug', count: mcp.value?.items.length },
]);
const visibleTools = computed(() =>
  app.tools.filter((tool) =>
    `${tool.name} ${tool.title} ${tool.description}`.toLowerCase().includes(query.value.trim().toLowerCase()),
  ),
);
const related = computed(() =>
  app.availableScenarios.filter(
    (s) => detail.value && s.payload.capabilities.builtin_tool_names.includes(detail.value.name),
  ),
);
const guidance: Record<string, { example: string; boundary: string }> = {
  current_time: {
    example: '请告诉我当前日期和时间，作为报告的时间依据。',
    boundary: '读取执行环境的当前时间，不访问外部业务系统。',
  },
  workspace_list: {
    example: '请列出本次会话已经生成的文件。',
    boundary: '只查看当前会话工作目录，不会列出其他会话文件。',
  },
  workspace_read: {
    example: '请阅读当前会话中的报告文件，并提炼关键结论。',
    boundary: '只能读取当前会话工作目录内的文本文件，不读取服务器任意路径。',
  },
  workspace_write: {
    example: '请把分析结果整理成 Markdown 文件，供我预览和下载。',
    boundary: '写入当前会话目录，是否需要批准由场景与平台策略决定。默认需要确认。',
  },
};
async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const [plugins, skillResult, mcpResult] = await Promise.all([
      api<{ items: RuntimeComponent[] }>('/registry/plugins'),
      api<Availability>('/registry/skills'),
      api<{ items: McpServer[]; available: boolean; reason: string }>('/registry/mcp-servers'),
    ]);
    components.value = plugins.items;
    skills.value = skillResult;
    mcp.value = mcpResult;
  } catch (error) {
    loadError.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}
function openMcpEditor() {
  mcpMessage.value = '';
  mcpJson.value = '';
  mcpEditorOpen.value = true;
}
async function importMcpJson() {
  mcpMessage.value = '';
  let config: unknown;
  try {
    config = JSON.parse(mcpJson.value);
  } catch {
    mcpMessage.value = 'JSON 格式不正确，请检查括号和引号。';
    return;
  }
  mcpBusy.value = true;
  try {
    await api('/registry/mcp-servers/import', { method: 'POST', body: JSON.stringify({ config }) });
    mcpJson.value = '';
    mcpEditorOpen.value = false;
    mcpMessage.value = '配置已添加，请测试连接并检查工具清单。';
    const result = await api<{ items: McpServer[] }>('/registry/mcp-servers');
    mcp.value = { ...result, available: true, reason: '' };
  } catch (error) {
    mcpMessage.value = (error as Error).message;
  } finally {
    mcpBusy.value = false;
  }
}
async function testMcp(server: McpServer) {
  mcpBusy.value = true;
  mcpMessage.value = '';
  try {
    await api(`/registry/mcp-servers/${server.id}/test`, { method: 'POST' });
    const result = await api<{ items: McpServer[] }>('/registry/mcp-servers');
    mcp.value = { ...result, available: true, reason: '' };
    mcpMessage.value = `“${server.name}”连接成功，已读取工具清单。`;
  } catch (error) {
    mcpMessage.value = (error as Error).message;
    await load();
  } finally {
    mcpBusy.value = false;
  }
}
async function toggleMcp(server: McpServer) {
  try {
    await api(`/registry/mcp-servers/${server.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !server.enabled }),
    });
    await load();
  } catch (error) {
    mcpMessage.value = (error as Error).message;
  }
}
async function deleteMcp(server: McpServer) {
  if (!window.confirm(`确定移除 MCP 服务“${server.name}”吗？`)) return;
  await api(`/registry/mcp-servers/${server.id}`, { method: 'DELETE' });
  await load();
}
function selectTab(id: string) {
  query.value = '';
  detail.value = null;
  void router.replace({ query: { ...route.query, tab: id, tool: undefined } });
}
async function start(scenario: Scenario) {
  detail.value = null;
  if (route.query.tool) await router.replace({ query: { ...route.query, tool: undefined } });
  if (chat.requestNewConversation(scenario.id)) void router.push('/agent/chat');
}
function closeTool() {
  detail.value = null;
  if (route.query.tool) void router.replace({ query: { ...route.query, tool: undefined } });
}
watch(
  [() => route.query.tool, () => app.tools],
  () => {
    if (route.query.tool) detail.value = app.tools.find((tool) => tool.name === route.query.tool) ?? null;
  },
  { immediate: true },
);
onMounted(load);
</script>
<template>
  <main class="page-content enterprise-page capabilities-page">
    <div class="enterprise-page-inner">
      <div class="page-heading">
        <div>
          <h1>企业能力中心</h1>
          <p>一处发现平台提供的工具、技能与连接，按需带入工作。</p>
        </div>
        <span class="enterprise-shared-label"><Icon name="building" :size="14" />公共能力目录</span>
      </div>
      <section v-if="tab === 'tools'" class="capabilities-intro">
        <span class="capabilities-intro-icon"><Icon name="blocks" :size="27" /></span>
        <div>
          <h2>能力统一维护，场景按需引用。</h2>
          <p>了解它能做什么，再从适用场景开始。不需要为每个账号重复安装。</p>
        </div>
        <RouterLink to="/agent/scenarios">浏览企业场景 <Icon name="arrow" :size="15" /></RouterLink>
      </section>
      <div class="collection-toolbar enterprise-collection-toolbar">
        <div class="collection-tabs" aria-label="能力分类">
          <button
            v-for="item in tabs"
            :key="item.id"
            :class="{ selected: tab === item.id }"
            :aria-pressed="tab === item.id"
            @click="selectTab(item.id)"
          >
            <Icon :name="item.icon" :size="16" />{{ item.label
            }}<span v-if="item.count !== undefined">{{ item.count }}</span>
          </button>
        </div>
        <label v-if="tab === 'tools'" class="search-field"
          ><Icon name="search" :size="17" /><input
            v-model="query"
            placeholder="搜索用途、名称或说明"
            aria-label="搜索能力"
        /></label>
      </div>
      <div v-if="loadError" class="form-alert error" role="alert">
        <Icon name="info" :size="18" />
        <div>
          <strong>部分能力信息未能读取</strong>
          <p>{{ loadError }}</p>
        </div>
        <button class="button secondary small" @click="load">重试</button>
      </div>
      <template v-if="tab === 'tools'">
        <div class="capability-section-label">
          <span><span class="availability-dot"></span>{{ app.tools.length }} 项基础工具已接入</span>
          <p>通过场景调用 · 通用业务插件安装尚未开放</p>
        </div>
        <div v-if="visibleTools.length" class="enterprise-tool-grid">
          <article v-for="tool in visibleTools" :key="tool.name" class="enterprise-tool-card">
            <div class="enterprise-tool-top">
              <span :class="['scene-icon', tool.permission === 'approval' ? 'book' : 'shield']"
                ><Icon :name="tool.icon" :size="24" /></span
              ><span :class="['tag', tool.permission === 'approval' ? 'warm' : 'success']"
                ><Icon :name="tool.permission === 'approval' ? 'shield' : 'eye'" :size="12" />{{
                  tool.permission === 'approval' ? '默认需确认' : '只读'
                }}</span
              >
            </div>
            <h2>{{ tool.title }}</h2>
            <p>{{ tool.description }}</p>
            <div class="tool-use-example">
              <Icon name="message" :size="14" /><span>{{
                guidance[tool.name]?.example ?? '在允许使用此工具的场景中描述你的目标。'
              }}</span>
            </div>
            <footer>
              <span>平台基础工具</span
              ><button :aria-label="`查看${tool.title}详情`" @click="detail = tool">
                查看详情 <Icon name="arrow" :size="15" />
              </button>
            </footer>
          </article>
        </div>
        <div v-else class="enterprise-empty">
          <span class="enterprise-empty-symbol"><Icon name="search" :size="28" /></span>
          <h2>没有匹配的能力</h2>
          <p>试试搜索“文件”“时间”，或清除关键词。</p>
          <button class="button secondary" @click="query = ''">清除搜索</button>
        </div>
        <details class="runtime-details">
          <summary>
            <Icon name="box" :size="17" /><span>底层运行组件</span
            ><small>供维护者查看，不作为业务插件安装</small><Icon name="chevronDown" :size="15" />
          </summary>
          <div v-if="loading" class="loading-inline"><span class="loader small"></span>读取组件信息…</div>
          <div v-else class="runtime-component-list">
            <article v-for="item in components" :key="item.name">
              <span class="component-runtime-icon"
                ><Icon :name="item.type === 'kernel' ? 'cpu' : 'blocks'" :size="20"
              /></span>
              <div>
                <strong
                  >{{ item.name === 'dsh-sdk' ? 'DeepSeek Harness' : 'Forge Runtime'
                  }}<small>v{{ item.version }}</small></strong
                >
                <p>{{ item.description }}</p>
              </div>
              <button class="button text small" @click="componentDetail = item">
                组件详情 <Icon name="arrow" :size="14" />
              </button>
            </article>
          </div>
        </details>
      </template>
      <div v-else-if="loading" class="loading-inline" role="status">
        <span class="loader"></span>正在读取接入状态…
      </div>
      <section v-else-if="tab === 'mcp' && mcp" class="mcp-directory">
        <header class="capability-list-heading">
          <div>
            <h2>MCP 服务</h2>
            <span>{{ mcp.items.length }} 个已添加</span>
          </div>
          <button v-if="mcp.items.length" class="button secondary small" @click="openMcpEditor">
            <Icon name="plus" :size="15" />添加服务
          </button>
        </header>
        <div v-if="mcpMessage" class="mcp-feedback" role="status">{{ mcpMessage }}</div>
        <div v-if="!mcp.items.length" class="enterprise-empty">
          <span class="enterprise-empty-symbol"><Icon name="plug" :size="29" /></span>
          <h2>还没有 MCP 服务</h2>
          <p>添加远程服务，测试连接后即可查看它提供的工具。</p>
          <button class="button primary" @click="openMcpEditor">导入 MCP 配置</button>
        </div>
        <div v-else class="mcp-server-list">
          <article v-for="server in mcp.items" :key="server.id" class="mcp-server-card">
            <div class="mcp-server-card-head">
              <div>
                <strong>{{ server.name }}</strong><span
                  :class="[
                    'tag',
                    server.status === 'connected'
                      ? 'success'
                      : server.status === 'error'
                        ? 'danger'
                        : 'neutral',
                  ]"
                  >{{
                    server.status === 'connected'
                      ? '连接正常'
                      : server.status === 'error'
                        ? '连接失败'
                        : '待测试'
                  }}</span
                >
              </div>
              <code>{{ server.url }}</code>
            </div>
            <p v-if="server.lastError" class="mcp-server-error">{{ server.lastError }}</p>
            <div v-if="server.tools.length" class="mcp-tool-list">
              <strong>{{ server.tools.length }} 项工具</strong
              ><span v-for="tool in server.tools" :key="tool.name" :title="tool.description">{{
                tool.name
              }}</span>
            </div>
            <div class="mcp-server-controls">
              <span v-if="server.hasCredentials" class="mcp-credential-note">认证信息已保存</span
              ><button class="button secondary small" :disabled="mcpBusy" @click="testMcp(server)">
                测试连接</button
              ><button
                class="button secondary small"
                :disabled="server.status !== 'connected'"
                @click="toggleMcp(server)"
              >
                {{ server.enabled ? '停用' : '启用' }}</button
              ><button class="button text small" @click="deleteMcp(server)">移除</button>
            </div>
          </article>
        </div>
      </section>
      <section v-else-if="tab === 'skills' && skills" class="enterprise-empty">
        <span class="enterprise-empty-symbol"><Icon name="book" :size="29" /></span>
        <h2>Skill 管理暂未开放</h2>
        <p>接入后可将工作规范与步骤沉淀为企业可复用的能力。</p>
      </section>
      <div v-if="tab === 'tools'" class="page-note">
        <Icon name="shield" :size="14" /><span
          >能力可发现不等于无限制执行。实际可调用范围由场景与策略共同决定；当前不开放任意
          Shell、外部网络工具或第三方插件安装。</span
        >
      </div>
    </div>
    <DialogShell
      v-if="mcpEditorOpen"
      variant="modal"
      label="导入 MCP 服务配置"
      panel-class="mcp-import-dialog"
      @close="mcpEditorOpen = false"
    >
      <header>
        <div>
          <h2>导入 MCP 服务</h2>
          <p>粘贴远程 HTTPS 服务的 mcpServers JSON。</p>
        </div>
        <button class="icon-button" aria-label="关闭" @click="mcpEditorOpen = false">
          <Icon name="close" :size="20" />
        </button>
      </header>
      <div class="mcp-import-body">
        <label class="mcp-json-label" for="mcp-import-json">配置 JSON</label>
        <textarea
          id="mcp-import-json"
          v-model="mcpJson"
          class="mcp-json-input"
          rows="8"
          spellcheck="false"
          placeholder='{\n  "mcpServers": {\n    "my-service": {\n      "type": "http",\n      "url": "https://mcp.example.com/mcp"\n    }\n  }\n}'
        ></textarea>
        <p class="mcp-import-hint">认证信息会加密保存在本机，不会在服务列表中显示。导入后需先测试连接。</p>
        <div v-if="mcpMessage" class="mcp-feedback" role="alert">{{ mcpMessage }}</div>
      </div>
      <footer>
        <button class="button secondary" :disabled="mcpBusy" @click="mcpEditorOpen = false">取消</button>
        <button class="button primary" :disabled="mcpBusy || !mcpJson.trim()" @click="importMcpJson">
          {{ mcpBusy ? '处理中…' : '导入配置' }}
        </button>
      </footer>
    </DialogShell>
    <DialogShell v-if="detail" label="工具详情" panel-class="capability-detail" @close="closeTool"
      ><header>
        <div>
          <div class="eyebrow">SHARED TOOL</div>
          <h2>{{ detail.title }}</h2>
          <p>平台提供 · 按场景范围调用</p>
        </div>
        <button class="icon-button" aria-label="关闭工具详情" @click="closeTool">
          <Icon name="close" :size="21" />
        </button>
      </header>
      <div class="drawer-body">
        <span :class="['scene-icon', detail.permission === 'approval' ? 'book' : 'shield']"
          ><Icon :name="detail.icon" :size="26"
        /></span>
        <div class="detail-block">
          <h3>能做什么</h3>
          <p>{{ detail.description }}</p>
        </div>
        <div class="detail-block">
          <h3>可以这样描述需求</h3>
          <blockquote class="capability-example">
            {{ guidance[detail.name]?.example ?? '在允许使用此工具的场景中描述你的目标。' }}
          </blockquote>
        </div>
        <div class="detail-block">
          <h3>使用范围</h3>
          <p>{{ guidance[detail.name]?.boundary ?? '执行范围由场景与平台策略共同限制。' }}</p>
        </div>
        <div class="detail-block">
          <h3>适用场景</h3>
          <p v-if="!related.length">暂无预置或已发布场景引用此工具。维护者可在场景中配置授权。</p>
          <button
            v-for="scenario in related"
            :key="scenario.id"
            class="related-scenario"
            @click="start(scenario)"
          >
            <span :class="['scene-icon', scenario.payload.icon]"
              ><Icon :name="scenario.payload.icon" :size="18"
            /></span>
            <div>
              <strong>{{ scenario.payload.name }}</strong><small
                >v{{ scenario.current_version }} ·
                {{ scenario.space === 'official' ? '平台预置' : '已发布' }}</small
              >
            </div>
            <span>开始会话</span><Icon name="arrow" :size="15" />
          </button>
        </div>
        <details class="technical-detail">
          <summary>技术标识</summary>
          <code>{{ detail.name }}</code>
        </details>
      </div>
      <footer>
        <RouterLink to="/agent/scenarios" class="button secondary"
          >查看企业场景 <Icon name="arrow" :size="15"
        /></RouterLink></footer
    ></DialogShell>
    <DialogShell v-if="componentDetail" label="组件详情" @close="componentDetail = null"
      ><header>
        <div>
          <h2>{{ componentDetail.name }}</h2>
          <p>{{ componentDetail.package }}</p>
        </div>
        <button class="icon-button" aria-label="关闭组件详情" @click="componentDetail = null">
          <Icon name="close" :size="21" />
        </button>
      </header>
      <div class="drawer-body">
        <div class="detail-block">
          <h3>组件说明</h3>
          <p>{{ componentDetail.description }}</p>
        </div>
        <div class="detail-block">
          <h3>版本</h3>
          <code>{{ componentDetail.version }}</code>
        </div>
        <div class="detail-block">
          <h3>扩展点</h3>
          <div class="chip-list">
            <span v-for="point in componentDetail.extensionPoints" :key="point" class="tag soft">{{
              point
            }}</span>
          </div>
        </div>
        <div class="detail-block">
          <h3>权限范围</h3>
          <div class="chip-list">
            <span v-for="point in componentDetail.permissions" :key="point" class="tag warm">{{
              point
            }}</span>
          </div>
        </div>
        <div class="form-alert">
          <Icon name="info" :size="17" /><span>随部署安装的运行组件，不是可自由安装的业务插件。</span>
        </div>
      </div></DialogShell
    >
  </main>
</template>
