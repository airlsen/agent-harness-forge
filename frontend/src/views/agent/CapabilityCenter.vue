<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, apiFetch } from '../../api/client';
import { formatBytes } from '../../utils/presentation';
import { usePlatform } from '../../stores/platform';
import { useConversation } from '../../stores/conversation';
import type { Scenario, Tool } from '../../types/platform';
import type { SkillSummary } from '../../types/skill';
import type { PluginPackage } from '../../types/plugin';
import Icon from '../../components/ForgeIcon.vue';
import DialogShell from '../../components/DialogShell.vue';

type RuntimeComponent = PluginPackage;
type McpServer = {
  id: number;
  name: string;
  url: string;
  transport: string;
  enabled: boolean;
  status: string;
  lastError: string;
  tools: { name: string; description: string; inputSchema?: Record<string, any> }[];
  serverInfo: Record<string, unknown>;
  hasCredentials: boolean;
};
const app = usePlatform();
const chat = useConversation();
const route = useRoute();
const router = useRouter();
const query = ref('');
const loading = ref(true);
const loadError = ref('');
const components = ref<RuntimeComponent[]>([]);
const pluginSubmissions = ref<PluginPackage[]>([]);
const pluginUploadOpen = ref(false);
const pluginFileInput = ref<HTMLInputElement | null>(null);
const pluginArchive = ref<File | null>(null);
const pluginDragActive = ref(false);
const pluginUploadBusy = ref(false);
const pluginUploadMessage = ref('');
const MAX_PLUGIN_ARCHIVE_BYTES = 5 * 1024 * 1024;
const reviewingPlugin = ref<number | null>(null);
const skills = ref<{ items: SkillSummary[] } | null>(null);
const mcp = ref<{ items: McpServer[]; available: boolean; reason: string } | null>(null);
const mcpJson = ref('');
const mcpTransport = ref<'streamable-http' | 'sse' | 'stdio'>('streamable-http');
const mcpExample = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'my-service':
          mcpTransport.value === 'stdio'
            ? {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed-folder'],
                env: {},
              }
            : {
                type: mcpTransport.value,
                url:
                  mcpTransport.value === 'sse'
                    ? 'https://mcp.example.com/sse'
                    : 'https://mcp.example.com/mcp',
                headers: { Authorization: 'Bearer <token>' },
              },
      },
    },
    null,
    2,
  ),
);
const mcpTemplate = ref('');
function changeMcpTransport() {
  if (mcpJson.value === mcpTemplate.value) mcpJson.value = mcpExample.value;
  mcpTemplate.value = mcpExample.value;
}
const mcpBusy = ref(false);
// 仅用于导入弹窗内、需要用户修改输入的错误；操作结果统一走全局 toast。
const mcpImportError = ref('');
const mcpEditorOpen = ref(false);
const selectedMcp = ref<McpServer | null>(null);
const mcpToolQuery = ref('');
const visibleMcpTools = computed(() =>
  (selectedMcp.value?.tools ?? []).filter((tool) =>
    `${tool.name} ${tool.description}`.toLowerCase().includes(mcpToolQuery.value.trim().toLowerCase()),
  ),
);
function openMcpTools(server: McpServer) {
  selectedMcp.value = server;
  mcpToolQuery.value = '';
}
const detail = ref<Tool | null>(null);
const componentDetail = ref<RuntimeComponent | null>(null);
const tab = computed(() => {
  const requestedTab = String(route.query.tab ?? '');
  // Keep the legacy ?tab=tools deep link focused on the managed plugin directory.
  if (requestedTab === 'tools' || requestedTab === 'plugins') return 'plugins';
  return ['skills', 'mcp'].includes(requestedTab) ? requestedTab : 'tools';
});
const tabs = computed(() => [
  { id: 'tools', label: '基础工具', icon: 'wrench', count: app.tools.length },
  { id: 'plugins', label: '插件', icon: 'blocks', count: components.value.length },
  { id: 'skills', label: '技能', icon: 'book', count: skills.value?.items.length },
  { id: 'mcp', label: 'MCP 服务', icon: 'plug', count: mcp.value?.items.length },
]);
const visibleTools = computed(() =>
  app.tools.filter((tool) =>
    `${tool.name} ${tool.title} ${tool.description}`.toLowerCase().includes(query.value.trim().toLowerCase()),
  ),
);
const visiblePlugins = computed(() =>
  components.value.filter((plugin) =>
    `${plugin.displayName} ${plugin.package} ${plugin.description} ${plugin.tools.map((tool) => `${tool.title} ${tool.description}`).join(' ')}`
      .toLowerCase()
      .includes(query.value.trim().toLowerCase()),
  ),
);
const visiblePluginSubmissions = computed(() =>
  pluginSubmissions.value.filter((plugin) =>
    `${plugin.displayName} ${plugin.package} ${plugin.version} ${plugin.artifactName} ${plugin.reviewNote}`
      .toLowerCase()
      .includes(query.value.trim().toLowerCase()),
  ),
);
const pendingPluginSubmissions = computed(() =>
  visiblePluginSubmissions.value.filter((plugin) => plugin.auditStatus === 'pending'),
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
    boundary: '直接写入当前会话目录，无需逐次确认；受文件数量与容量配额约束，不能写到会话目录之外。',
  },
};
async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const [plugins, skillResult, mcpResult] = await Promise.all([
      api<{ items: RuntimeComponent[]; submissions: PluginPackage[] }>('/registry/plugins'),
      api<{ items: SkillSummary[] }>('/skills'),
      api<{ items: McpServer[]; available: boolean; reason: string }>('/registry/mcp-servers'),
    ]);
    components.value = plugins.items;
    pluginSubmissions.value = plugins.submissions;
    skills.value = skillResult;
    mcp.value = mcpResult;
  } catch (error) {
    loadError.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}
function openPluginUpload() {
  pluginArchive.value = null;
  pluginUploadMessage.value = '';
  pluginDragActive.value = false;
  if (pluginFileInput.value) pluginFileInput.value.value = '';
  pluginUploadOpen.value = true;
}
function clearPluginArchive() {
  pluginArchive.value = null;
  pluginUploadMessage.value = '';
  if (pluginFileInput.value) pluginFileInput.value.value = '';
}
function setPluginArchive(file: File | null) {
  if (pluginUploadBusy.value) return;
  pluginUploadMessage.value = '';
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.zip')) {
    pluginArchive.value = null;
    pluginUploadMessage.value = '当前仅支持 .zip Forge 插件包。';
    if (pluginFileInput.value) pluginFileInput.value.value = '';
    return;
  }
  if (!file.size) {
    pluginArchive.value = null;
    pluginUploadMessage.value = '所选文件为空，请重新选择插件包。';
    if (pluginFileInput.value) pluginFileInput.value.value = '';
    return;
  }
  if (file.size > MAX_PLUGIN_ARCHIVE_BYTES) {
    pluginArchive.value = null;
    pluginUploadMessage.value = '插件包不能超过 5 MB，请压缩后重试。';
    if (pluginFileInput.value) pluginFileInput.value.value = '';
    return;
  }
  pluginArchive.value = file;
}
function choosePluginArchive(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  setPluginArchive(input.files?.[0] ?? null);
}
function handlePluginDrop(event: DragEvent) {
  pluginDragActive.value = false;
  setPluginArchive(event.dataTransfer?.files?.[0] ?? null);
}
async function uploadPluginArchive() {
  const file = pluginArchive.value;
  if (!file) {
    pluginUploadMessage.value = '请选择包含 forge.plugin.json 的 .zip 插件包。';
    return;
  }
  pluginUploadBusy.value = true;
  pluginUploadMessage.value = '';
  try {
    const response = await apiFetch(
      `/api/registry/plugins/upload?filename=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0) throw new Error(body.message ?? body.detail ?? '插件包上传失败');
    const displayName = body.data?.displayName ?? file.name;
    pluginArchive.value = null;
    if (pluginFileInput.value) pluginFileInput.value.value = '';
    pluginUploadOpen.value = false;
    app.toast(`“${displayName}”已完成契约检查，等待审核。`);
    await load();
  } catch (error) {
    pluginUploadMessage.value = (error as Error).message;
  } finally {
    pluginUploadBusy.value = false;
  }
}
async function reviewPlugin(plugin: PluginPackage, action: 'approved' | 'rejected') {
  const verb = action === 'approved' ? '批准' : '拒绝';
  if (!window.confirm(`确定${verb}插件版本“${plugin.displayName}” v${plugin.version} 吗？`)) return;
  reviewingPlugin.value = plugin.id;
  try {
    await api(`/registry/plugins/${plugin.id}/review`, { method: 'POST', body: JSON.stringify({ action }) });
    app.toast(action === 'approved' ? '插件版本已批准，可在场景中授权使用。' : '插件版本已拒绝。');
    await load();
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    reviewingPlugin.value = null;
  }
}
async function togglePlugin(plugin: PluginPackage) {
  reviewingPlugin.value = plugin.id;
  try {
    await api(`/registry/plugins/${plugin.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !plugin.enabled }),
    });
    await load();
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    reviewingPlugin.value = null;
  }
}
function openMcpEditor() {
  mcpImportError.value = '';
  mcpTransport.value = 'streamable-http';
  mcpJson.value = mcpExample.value;
  mcpTemplate.value = mcpExample.value;
  mcpEditorOpen.value = true;
}
async function importMcpJson() {
  mcpImportError.value = '';
  let config: unknown;
  try {
    config = JSON.parse(mcpJson.value);
  } catch {
    mcpImportError.value = 'JSON 格式不正确，请检查括号和引号。';
    return;
  }
  if (
    config &&
    typeof config === 'object' &&
    'mcpServers' in config &&
    config.mcpServers &&
    typeof config.mcpServers === 'object'
  ) {
    for (const entry of Object.values(config.mcpServers as Record<string, Record<string, unknown>>)) {
      entry.type = mcpTransport.value;
    }
  }
  mcpBusy.value = true;
  try {
    await api('/registry/mcp-servers/import', { method: 'POST', body: JSON.stringify({ config }) });
    mcpJson.value = '';
    mcpEditorOpen.value = false;
    app.toast('MCP 服务已添加，请测试连接以读取工具清单。');
    await refreshMcp();
  } catch (error) {
    // 弹窗保持打开，错误留在输入框下方，方便对照修改。
    mcpImportError.value = (error as Error).message;
  } finally {
    mcpBusy.value = false;
  }
}
async function refreshMcp() {
  const result = await api<{ items: McpServer[] }>('/registry/mcp-servers');
  mcp.value = { ...result, available: true, reason: '' };
}
async function testMcp(server: McpServer) {
  mcpBusy.value = true;
  try {
    await api(`/registry/mcp-servers/${server.id}/test`, { method: 'POST' });
    await refreshMcp();
    app.toast(`“${server.name}”连接成功，已读取工具清单。`);
  } catch (error) {
    app.toast((error as Error).message, 'error');
    // 刷新卡片上的“连接失败”状态；刷新本身失败时已由 loadError 展示。
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
    app.toast(server.enabled ? `“${server.name}”已停用` : `“${server.name}”已启用`);
    await load();
  } catch (error) {
    app.toast((error as Error).message, 'error');
  }
}
async function deleteMcp(server: McpServer) {
  if (!window.confirm(`确定移除 MCP 服务“${server.name}”吗？`)) return;
  try {
    await api(`/registry/mcp-servers/${server.id}`, { method: 'DELETE' });
    app.toast(`MCP 服务“${server.name}”已移除`);
    await load();
  } catch (error) {
    app.toast((error as Error).message, 'error');
  }
}
function selectTab(id: string) {
  query.value = '';
  detail.value = null;
  const routeTab = id === 'tools' ? 'base-tools' : id;
  void router.replace({ query: { ...route.query, tab: routeTab, tool: undefined } });
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
      <div class="page-heading catalog-page-heading capability-page-heading">
        <div class="catalog-heading-copy">
          <span class="catalog-kicker"
            ><span class="catalog-kicker-mark"><Icon name="sparkles" :size="12" /></span>CAPABILITY
            STUDIO</span
          >
          <h1>能力管理</h1>
          <p>查看工具、技能和 MCP 服务，按需配置到场景或会话。</p>
        </div>
      </div>
      <div class="collection-toolbar enterprise-collection-toolbar capability-collection-toolbar">
        <div class="collection-tabs capability-category-switcher" role="group" aria-label="能力分类">
          <button
            v-for="item in tabs"
            :key="item.id"
            :class="['capability-category-option', { selected: tab === item.id }]"
            :aria-pressed="tab === item.id"
            @click="selectTab(item.id)"
          >
            <Icon :name="item.icon" :size="16" />
            <span class="capability-category-label">{{ item.label }}</span>
            <span v-if="item.count !== undefined" class="capability-category-count">{{ item.count }}</span>
          </button>
        </div>
        <div class="capability-toolbar-actions">
          <label v-if="tab === 'tools' || tab === 'plugins'" class="search-field"
            ><Icon name="search" :size="17" /><input
              v-model="query"
              :placeholder="tab === 'plugins' ? '搜索插件、工具或说明' : '搜索用途、名称或说明'"
              :aria-label="tab === 'plugins' ? '搜索插件' : '搜索基础工具'"
          /></label>
          <div v-else-if="tab === 'skills' && skills?.items.length" class="skill-capability-actions">
            <RouterLink to="/agent/skills" class="button secondary small"
              >全部技能 <Icon name="arrow" :size="14" /></RouterLink
            ><RouterLink to="/agent/skills/new" class="button primary small"
              ><Icon name="plus" :size="15" />新建技能</RouterLink
            >
          </div>
        </div>
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
          <span><span class="availability-dot"></span>基础工具 · {{ visibleTools.length }} 项</span>
          <p>默认可用</p>
        </div>
        <div v-if="visibleTools.length" class="enterprise-tool-grid">
          <article v-for="tool in visibleTools" :key="tool.name" class="enterprise-tool-card">
            <div class="enterprise-tool-top">
              <span :class="['scene-icon', tool.permission === 'read' ? 'shield' : 'book']"
                ><Icon :name="tool.icon" :size="24" /></span
              ><span :class="['tag', tool.permission === 'read' ? 'success' : 'warm']"
                ><Icon :name="tool.permission === 'read' ? 'eye' : 'edit'" :size="12" />{{
                  tool.permission === 'read' ? '只读' : '写入会话目录'
                }}</span
              >
            </div>
            <h2>{{ tool.title }}</h2>
            <p>{{ tool.description }}</p>
            <footer>
              <button :aria-label="`查看${tool.title}详情`" @click="detail = tool">
                详情 <Icon name="arrow" :size="15" />
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
      </template>
      <template v-else-if="tab === 'plugins'">
        <div v-if="loading" class="loading-inline" role="status">
          <span class="loader"></span>正在读取插件目录…
        </div>
        <section v-else class="plugin-directory">
          <header class="capability-list-heading plugin-directory-heading">
            <div>
              <h2>受管插件</h2>
              <span>{{ components.length }} 个当前可用版本 · {{ pluginSubmissions.length }} 个上传版本</span>
            </div>
            <button class="button primary small" @click="openPluginUpload">
              <Icon name="arrow-up-line" :size="15" />上传插件包
            </button>
          </header>
          <p class="plugin-directory-description">
            上传的 ZIP 会先经过契约检查并进入审核；批准后，维护者可以在企业场景中绑定具体插件和工具。
          </p>
          <div v-if="!visiblePlugins.length" class="enterprise-empty plugin-empty-state">
            <span class="enterprise-empty-symbol"><Icon name="blocks" :size="28" /></span>
            <h2>{{ query.trim() ? '没有匹配的插件' : '还没有可用的受管插件' }}</h2>
            <p>
              {{
                query.trim()
                  ? '试试其他插件名称、工具名称或说明。'
                  : '上传 Forge 插件包后会先进入审核；审核通过并启用后，才可在场景中授权使用。'
              }}
            </p>
            <button v-if="query.trim()" class="button secondary" @click="query = ''">清除搜索</button>
          </div>
          <section v-if="visiblePlugins.length" class="managed-plugin-section">
            <div class="capability-section-label">
              <span><Icon name="shield" :size="15" />受管插件 · {{ visiblePlugins.length }}</span>
            </div>
            <div class="enterprise-tool-grid">
              <article
                v-for="plugin in visiblePlugins"
                :key="plugin.package"
                class="enterprise-tool-card managed-plugin-card"
              >
                <div class="enterprise-tool-top">
                  <span class="scene-icon shield"><Icon name="blocks" :size="24" /></span
                  ><span
                    :class="[
                      'tag',
                      plugin.auditStatus === 'approved' && plugin.enabled ? 'success' : 'neutral',
                    ]"
                    >{{ plugin.auditStatus === 'approved' && plugin.enabled ? '已批准' : '不可用' }}</span
                  >
                </div>
                <h2>{{ plugin.displayName }}</h2>
                <p>{{ plugin.description }}</p>
                <div class="managed-plugin-meta">
                  <span>v{{ plugin.version }}</span
                  ><span>{{ plugin.tools.length }} 项已声明工具</span
                  ><span
                    v-if="plugin.source.includes('demo')"
                    class="tag warm"
                    title="仅返回模拟数据，不连接真实系统"
                    >演示数据</span
                  >
                </div>
                <details class="managed-plugin-tools-details">
                  <summary>查看工具与权限</summary>
                  <ul class="managed-plugin-tools">
                    <li v-for="tool in plugin.tools" :key="tool.name">
                      <span
                        ><b>{{ tool.title }}</b
                        ><small>{{ tool.description }}</small></span
                      ><em>{{ tool.permission === 'approval' ? '需审批' : '只读' }}</em>
                    </li>
                  </ul>
                </details>
                <footer>
                  <RouterLink to="/agent/scenarios">场景授权 <Icon name="arrow" :size="15" /></RouterLink>
                </footer>
              </article>
            </div>
          </section>
          <details
            v-if="visiblePluginSubmissions.length"
            class="plugin-review-section"
            :open="pendingPluginSubmissions.length > 0"
          >
            <summary class="capability-section-label">
              <span
                ><Icon name="box" :size="15" />上传版本与审核队列 ·
                {{ pendingPluginSubmissions.length }} 项待处理</span
              ><Icon class="plugin-review-toggle-icon" name="chevronDown" :size="15" />
            </summary>
            <div class="plugin-submission-list">
              <article
                v-for="plugin in visiblePluginSubmissions"
                :key="plugin.id"
                class="plugin-submission-card"
              >
                <div>
                  <strong>{{ plugin.displayName }}</strong><small
                    >{{ plugin.package }} · v{{ plugin.version }} ·
                    {{ plugin.artifactName || '已登记制品' }}</small
                  >
                </div>
                <p>
                  {{
                    plugin.runtime === 'dsh-native'
                      ? '原生 DSH 插件候选：只能由平台团队通过专用 Runner 镜像审核。'
                      : plugin.reviewNote ||
                        'Manifest 已校验，等待管理员审核远程 Worker、工具权限与网络域名。'
                  }}
                </p>
                <small v-if="plugin.execution?.networkDomains?.length" class="plugin-network-scope"
                  >网络白名单：{{ plugin.execution.networkDomains.join('、') }} ·
                  {{ plugin.execution.timeoutSeconds ?? 20 }} 秒超时</small
                >
                <div class="plugin-submission-meta">
                  <span
                    :class="[
                      'tag',
                      plugin.auditStatus === 'approved'
                        ? 'success'
                        : plugin.auditStatus === 'rejected'
                          ? 'warm'
                          : 'neutral',
                    ]"
                    >{{
                      plugin.auditStatus === 'approved'
                        ? plugin.enabled
                          ? '已批准'
                          : '已停用'
                        : plugin.auditStatus === 'rejected'
                          ? '已拒绝'
                          : '待审核'
                    }}</span><code>{{ plugin.artifactHash.slice(0, 12) }}</code>
                </div>
                <footer>
                  <template v-if="plugin.auditStatus === 'pending'"
                    ><button
                      class="button secondary small"
                      :disabled="reviewingPlugin === plugin.id"
                      @click="reviewPlugin(plugin, 'rejected')"
                    >
                      拒绝</button
                    ><button
                      class="button primary small"
                      :disabled="reviewingPlugin === plugin.id || plugin.runtime === 'dsh-native'"
                      @click="reviewPlugin(plugin, 'approved')"
                    >
                      批准并发布
                    </button></template
                  ><button
                    v-else-if="plugin.auditStatus === 'approved'"
                    class="button secondary small"
                    :disabled="reviewingPlugin === plugin.id"
                    @click="togglePlugin(plugin)"
                  >
                    {{ plugin.enabled ? '停用版本' : '启用版本' }}
                  </button>
                </footer>
              </article>
            </div>
          </details>
          <details class="runtime-details">
            <summary>
              <Icon name="box" :size="17" /><span>平台运行组件</span><small>只读 · 非业务插件</small
              ><Icon name="chevronDown" :size="15" />
            </summary>
            <div v-if="loading" class="loading-inline"><span class="loader small"></span>读取组件信息…</div>
            <div v-else class="runtime-component-list">
              <article v-for="item in components" :key="item.package">
                <span class="component-runtime-icon"><Icon name="blocks" :size="20" /></span>
                <div>
                  <strong
                    >{{ item.displayName }}<small>v{{ item.version }}</small></strong
                  >
                  <p>{{ item.package }} · {{ item.runtime }}</p>
                </div>
                <button class="button text small" @click="componentDetail = item">
                  组件详情 <Icon name="arrow" :size="14" />
                </button>
              </article>
            </div>
          </details>
        </section>
      </template>
      <div v-else-if="loading" class="loading-inline" role="status">
        <span class="loader"></span>正在读取接入状态…
      </div>
      <section v-else-if="tab === 'mcp' && mcp" class="mcp-directory">
        <header v-if="mcp.items.length" class="capability-list-heading">
          <button class="button secondary small" @click="openMcpEditor">
            <Icon name="plus" :size="15" />添加服务
          </button>
        </header>
        <div v-if="!mcp.items.length" class="enterprise-empty">
          <span class="enterprise-empty-symbol"><Icon name="plug" :size="29" /></span>
          <h2>还没有 MCP 服务</h2>
          <p>连接外部工具服务，供场景或会话调用。</p>
          <button class="button primary" @click="openMcpEditor">添加 MCP 服务</button>
        </div>
        <div v-else class="mcp-server-list">
          <article v-for="server in mcp.items" :key="server.id" class="mcp-server-card">
            <div class="mcp-card-main">
              <span class="mcp-card-icon"><Icon name="plug" :size="20" /></span>
              <div class="mcp-card-info">
                <div class="mcp-card-title">
                  <h3>{{ server.name }}</h3>
                  <span
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
                  <span
                    v-if="server.transport === 'stdio' || server.transport === 'sse'"
                    class="mcp-transport-badge"
                    >{{ server.transport === 'stdio' ? '本机进程' : '旧版 SSE' }}</span
                  >
                </div>
                <details class="mcp-connection-details">
                  <summary>连接详情</summary>
                  <p class="mcp-card-description">
                    {{
                      server.serverInfo?.name ||
                      (server.transport === 'stdio' ? '本机 MCP 进程' : server.url)
                    }}<span v-if="server.serverInfo?.version"> · {{ server.serverInfo.version }}</span>
                  </p>
                  <p class="mcp-credential-note">
                    {{ server.hasCredentials ? '认证信息已加密保存' : '无需认证' }}
                  </p>
                </details>
              </div>
              <button
                class="button secondary small mcp-view-tools"
                :disabled="!server.tools.length"
                @click="openMcpTools(server)"
              >
                查看工具 <span>{{ server.tools.length }}</span><Icon name="arrow" :size="14" />
              </button>
            </div>
            <p v-if="server.lastError" class="mcp-server-error">{{ server.lastError }}</p>
            <p v-if="server.transport === 'sse'" class="mcp-server-note">
              仅测试连接，暂不可在会话中运行。会话执行内核不支持旧版 SSE，请改用 Streamable HTTP 或 stdio。
            </p>
            <footer class="mcp-card-footer">
              <div class="mcp-card-actions">
                <button class="button text small" :disabled="mcpBusy" @click="testMcp(server)">
                  测试连接
                </button>
                <button
                  class="button secondary small"
                  :disabled="server.status !== 'connected' || (server.transport === 'sse' && !server.enabled)"
                  :title="
                    server.transport === 'sse' && !server.enabled ? '旧版 SSE 暂不可在会话中运行' : undefined
                  "
                  @click="toggleMcp(server)"
                >
                  {{ server.enabled ? '停用' : '启用' }}
                </button>
                <button class="button text small danger-text" @click="deleteMcp(server)">移除</button>
              </div>
            </footer>
          </article>
        </div>
      </section>
      <section v-else-if="tab === 'skills' && skills" class="mcp-directory skill-capability-directory">
        <header v-if="skills.items.length" class="capability-list-heading capability-content-heading">
          <div>
            <h2>可复用技能</h2>
            <span>查看状态，或将已发布版本配置到场景与会话。</span>
          </div>
          <span class="capability-content-count">{{ skills.items.length }} 项</span>
        </header>
        <div v-if="!skills.items.length" class="enterprise-empty">
          <span class="enterprise-empty-symbol"><Icon name="book" :size="29" /></span>
          <h2>还没有技能</h2>
          <p>创建一项可复用的工作方法。</p>
          <RouterLink to="/agent/skills/new" class="button primary"
            ><Icon name="plus" :size="16" />新建技能</RouterLink
          >
        </div>
        <div v-else class="capability-skill-grid">
          <RouterLink
            v-for="skill in skills.items"
            :key="skill.id"
            :to="`/agent/skills/${skill.id}`"
            class="capability-skill-card"
          >
            <div class="capability-skill-card-top">
              <span class="capability-skill-icon"><Icon name="book" :size="19" /></span
              ><span :class="['tag', skill.status === 'published' ? 'success' : 'neutral']">{{
                skill.status === 'published' ? `已发布 · v${skill.publishedVersion}` : '草稿'
              }}</span>
            </div>
            <div>
              <h3>{{ skill.name }}</h3>
              <p>{{ skill.description || '尚未添加用途说明。' }}</p>
            </div>
            <footer>
              <span class="skill-open-link">编辑 <Icon name="arrow" :size="14" /></span>
            </footer>
          </RouterLink>
        </div>
      </section>
      <div v-if="tab === 'tools' || tab === 'plugins'" class="page-note">
        <Icon name="shield" :size="14" /><span>{{
          tab === 'plugins'
            ? '插件包上传只做静态契约检查，不会执行包内代码；审核通过后才能由场景授权使用。'
            : '实际调用范围由场景授权和平台策略决定。'
        }}</span>
      </div>
    </div>
    <DialogShell
      v-if="pluginUploadOpen"
      variant="modal"
      label="上传受管插件包"
      panel-class="plugin-upload-dialog"
      @close="!pluginUploadBusy && (pluginUploadOpen = false)"
    >
      <header class="plugin-upload-header">
        <span class="plugin-upload-icon"><Icon name="blocks" :size="22" /></span>
        <div>
          <span class="eyebrow">MANAGED PLUGIN</span>
          <h2>上传插件包</h2>
          <p>先检查插件契约，再进入平台审核流程。</p>
        </div>
        <button
          class="icon-button"
          aria-label="关闭上传插件"
          :disabled="pluginUploadBusy"
          @click="pluginUploadOpen = false"
        >
          <Icon name="close" :size="20" />
        </button>
      </header>
      <div class="plugin-upload-content">
        <div
          :class="['plugin-upload-dropzone', { 'is-dragging': pluginDragActive }]"
          @dragenter.prevent="pluginDragActive = true"
          @dragover.prevent="pluginDragActive = true"
          @dragleave.prevent="pluginDragActive = false"
          @drop.prevent="handlePluginDrop"
        >
          <span class="plugin-upload-dropzone-icon"><Icon name="arrow-up-line" :size="22" /></span>
          <strong>{{ pluginArchive ? '插件包已就绪' : '拖放 ZIP 插件包到这里' }}</strong>
          <small>{{ pluginArchive ? '确认文件后即可上传并进行契约检查。' : '或从设备中选择文件' }}</small>
          <label :class="['plugin-file-picker', { 'is-disabled': pluginUploadBusy }]">
            <input
              ref="pluginFileInput"
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              aria-label="选择 ZIP 插件包"
              :disabled="pluginUploadBusy"
              @change="choosePluginArchive"
            />
            <span class="button secondary small">浏览文件</span>
          </label>
        </div>
        <div v-if="pluginArchive" class="plugin-selected-file">
          <span class="plugin-selected-file-icon"><Icon name="box" :size="17" /></span>
          <span class="plugin-selected-file-name" :title="pluginArchive.name">{{ pluginArchive.name }}</span>
          <small>{{ formatBytes(pluginArchive.size) }}</small>
          <button
            type="button"
            class="button text small"
            :disabled="pluginUploadBusy"
            @click="clearPluginArchive"
          >
            移除
          </button>
        </div>
        <div class="plugin-upload-requirements" aria-label="上传要求">
          <div><strong>ZIP</strong><span>仅支持 .zip</span></div>
          <div><strong>5 MB</strong><span>单个文件上限</span></div>
          <div><strong>Manifest</strong><span>需位于包根目录</span></div>
        </div>
        <div class="plugin-upload-boundary">
          <Icon name="shield" :size="17" />
          <p>
            上传只校验 Manifest 与制品，不安装依赖或执行包内代码。可进入审核流程的 Worker 包需使用
            <code>forge-remote-worker-v1</code>；原生 DSH 包只登记为候选。
          </p>
        </div>
        <div v-if="pluginUploadMessage" class="plugin-upload-alert" role="alert" aria-live="polite">
          <Icon name="info" :size="16" /><span>{{ pluginUploadMessage }}</span>
        </div>
      </div>
      <footer class="plugin-upload-footer">
        <span>审核通过后，才可在场景中授权使用。</span>
        <div>
          <button class="button secondary" :disabled="pluginUploadBusy" @click="pluginUploadOpen = false">
            取消
          </button>
          <button
            class="button primary"
            :disabled="pluginUploadBusy || !pluginArchive"
            @click="uploadPluginArchive"
          >
            <span v-if="pluginUploadBusy" class="loader small"></span>
            {{ pluginUploadBusy ? '正在校验…' : '上传并校验' }}
          </button>
        </div>
      </footer>
    </DialogShell>
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
          <p>选择连接协议并粘贴 mcpServers JSON。远程服务须使用 HTTPS；旧版 SSE 仅可测试连接。</p>
        </div>
        <button class="icon-button" aria-label="关闭" @click="mcpEditorOpen = false">
          <Icon name="close" :size="20" />
        </button>
      </header>
      <div class="mcp-import-body">
        <div class="mcp-format-row">
          <label class="mcp-json-label" for="mcp-import-json">连接协议</label
          ><select v-model="mcpTransport" class="mcp-transport-select" @change="changeMcpTransport">
            <option value="streamable-http">Streamable HTTP（推荐）</option>
            <option value="sse">SSE（旧版 HTTP，仅测试连接）</option>
            <option value="stdio">stdio（本机进程）</option>
          </select>
        </div>
        <label class="mcp-json-label" for="mcp-import-json">mcpServers 配置 JSON</label>
        <textarea
          id="mcp-import-json"
          v-model="mcpJson"
          class="mcp-json-input"
          @input="mcpImportError = ''"
          rows="8"
          spellcheck="false"
          :placeholder="mcpExample"
        ></textarea>
        <p class="mcp-import-hint">
          凭据和 stdio 参数会加密保存在本机，不会在服务列表中显示。stdio 命令会以 Forge
          服务进程权限启动，请只配置可信 MCP 程序；导入后需先测试连接。
        </p>
        <div v-if="mcpImportError" class="mcp-import-error" role="alert">
          <Icon name="info" :size="16" /><span>{{ mcpImportError }}</span>
        </div>
      </div>
      <footer>
        <button class="button secondary" :disabled="mcpBusy" @click="mcpEditorOpen = false">取消</button>
        <button class="button primary" :disabled="mcpBusy || !mcpJson.trim()" @click="importMcpJson">
          {{ mcpBusy ? '处理中…' : '导入配置' }}
        </button>
      </footer>
    </DialogShell>
    <DialogShell
      v-if="selectedMcp"
      variant="modal"
      :label="`${selectedMcp.name} 工具清单`"
      panel-class="mcp-tools-dialog"
      @close="selectedMcp = null"
    >
      <header class="mcp-tools-header">
        <div>
          <span class="mcp-transport-badge">{{
            selectedMcp.transport === 'stdio'
              ? 'stdio'
              : selectedMcp.transport === 'sse'
                ? '旧版 SSE'
                : 'Streamable HTTP'
          }}</span>
          <h2>{{ selectedMcp.name }}</h2>
          <p>{{ selectedMcp.tools.length }} 项工具 · 由 MCP 服务提供</p>
        </div>
        <button class="icon-button" aria-label="关闭工具清单" @click="selectedMcp = null">
          <Icon name="close" :size="20" />
        </button>
      </header>
      <label class="mcp-tools-search"
        ><Icon name="search" :size="16" /><input v-model="mcpToolQuery" placeholder="搜索工具名称或用途"
      /></label>
      <div class="mcp-tools-list">
        <article v-for="tool in visibleMcpTools" :key="tool.name" class="mcp-tool-row">
          <span class="mcp-tool-symbol"><Icon name="wrench" :size="16" /></span>
          <div>
            <strong>{{ tool.name }}</strong>
            <p>{{ tool.description || '此工具未提供用途说明。' }}</p>
          </div>
        </article>
        <div v-if="!visibleMcpTools.length" class="mcp-tools-empty">
          {{ selectedMcp.tools.length ? '没有匹配的工具' : '服务尚未返回工具清单，请先测试连接。' }}
        </div>
      </div>
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
        <span :class="['scene-icon', detail.permission === 'read' ? 'shield' : 'book']"
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
          <h2>{{ componentDetail.displayName }}</h2>
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
          <Icon name="info" :size="17" /><span
            >仅可由平台审核、固定版本并通过场景授权；不支持自由安装 npm、GitHub 或本地插件。</span
          >
        </div>
      </div></DialogShell
    >
  </main>
</template>
