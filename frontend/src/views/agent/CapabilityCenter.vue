<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, apiFetch } from '../../api/client';
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
const pluginArchive = ref<File | null>(null);
const pluginUploadBusy = ref(false);
const pluginUploadMessage = ref('');
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
const mcpMessage = ref('');
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
const tab = computed(() =>
  ['tools', 'skills', 'mcp'].includes(String(route.query.tab)) ? String(route.query.tab) : 'tools',
);
const tabs = computed(() => [
  { id: 'tools', label: '插件与工具', icon: 'wrench', count: app.tools.length + components.value.length },
  { id: 'skills', label: 'Skills 技能', icon: 'book', count: skills.value?.items.length },
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
function choosePluginArchive(event: Event) {
  pluginArchive.value = (event.target as HTMLInputElement).files?.[0] ?? null;
  pluginUploadMessage.value = '';
}
async function uploadPluginArchive() {
  const file = pluginArchive.value;
  if (!file) {
    pluginUploadMessage.value = '请选择包含 forge.plugin.json 的 .zip 插件包。';
    return;
  }
  if (!file.name.toLowerCase().endsWith('.zip')) {
    pluginUploadMessage.value = '当前仅支持上传 .zip Forge 插件包。';
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
    pluginUploadMessage.value = `“${body.data.displayName}”已完成契约检查，等待审核发布。`;
    pluginArchive.value = null;
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
  mcpMessage.value = '';
  mcpTransport.value = 'streamable-http';
  mcpJson.value = mcpExample.value;
  mcpTemplate.value = mcpExample.value;
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
        <div class="capability-heading-actions">
          <button class="button secondary small" @click="pluginUploadOpen = true">
            <Icon name="box" :size="15" />上传插件包
          </button>
          <span class="enterprise-shared-label"><Icon name="building" :size="14" />公共能力目录</span>
        </div>
      </div>
      <section class="capabilities-intro">
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
          <span
            ><span class="availability-dot"></span>{{ app.tools.length }} 项基础工具 ·
            {{ visiblePlugins.length }} 个受管插件</span
          >
          <p>通过场景调用 · 仅展示审核且由 Forge 托管的版本</p>
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
        <section v-if="visiblePlugins.length" class="managed-plugin-section">
          <div class="capability-section-label">
            <span><Icon name="shield" :size="15" />受管业务插件</span>
            <p>版本、工具契约和可用状态均由平台控制</p>
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
                ><span>{{ plugin.tools.length }} 项已声明工具</span>
              </div>
              <ul class="managed-plugin-tools">
                <li v-for="tool in plugin.tools" :key="tool.name">
                  <span
                    ><b>{{ tool.title }}</b
                    ><small>{{ tool.description }}</small></span
                  ><em>{{ tool.permission === 'approval' ? '需审批' : '只读' }}</em>
                </li>
              </ul>
              <footer>
                <span>Forge 受管运行时</span
                ><RouterLink to="/agent/scenarios">前往场景授权 <Icon name="arrow" :size="15" /></RouterLink>
              </footer>
            </article>
          </div>
        </section>
        <section v-if="pluginSubmissions.length" class="plugin-review-section">
          <div class="capability-section-label">
            <span><Icon name="box" :size="15" />上传版本与审核队列</span>
            <p>上传包只完成静态契约检查；不会在 Forge Runner 中安装或执行其中的 Node 代码。</p>
          </div>
          <div class="plugin-submission-list">
            <article v-for="plugin in pluginSubmissions" :key="plugin.id" class="plugin-submission-card">
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
                    : plugin.reviewNote || 'Manifest 已校验，等待管理员审核远程 Worker、工具权限与网络域名。'
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
        </section>
        <details class="runtime-details">
          <summary>
            <Icon name="box" :size="17" /><span>底层运行组件</span
            ><small>供维护者查看，不作为业务插件安装</small><Icon name="chevronDown" :size="15" />
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
                  <span class="mcp-transport-badge">{{
                    server.transport === 'stdio'
                      ? 'stdio'
                      : server.transport === 'sse'
                        ? '旧版 SSE'
                        : 'Streamable HTTP'
                  }}</span>
                </div>
                <p class="mcp-card-description">
                  {{ server.serverInfo?.name || (server.transport === 'stdio' ? '本机 MCP 进程' : server.url)
                  }}<span v-if="server.serverInfo?.version"> · {{ server.serverInfo.version }}</span>
                </p>
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
            <footer class="mcp-card-footer">
              <span v-if="server.hasCredentials" class="mcp-credential-note">认证信息已加密保存</span
              ><span v-else class="mcp-credential-note">{{
                server.transport === 'stdio' ? '本机进程' : '无需认证'
              }}</span>
              <div class="mcp-card-actions">
                <button class="button text small" :disabled="mcpBusy" @click="testMcp(server)">
                  测试连接
                </button>
                <button
                  class="button secondary small"
                  :disabled="server.status !== 'connected'"
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
        <header class="capability-list-heading">
          <div>
            <h2>Skills 技能</h2>
            <span>{{ skills.items.length }} 个可复用工作方法</span>
          </div>
          <div class="skill-capability-actions">
            <RouterLink v-if="skills.items.length" to="/agent/skills" class="button secondary small"
              >管理全部 <Icon name="arrow" :size="14" /></RouterLink
            ><RouterLink to="/agent/skills/new" class="button primary small"
              ><Icon name="plus" :size="15" />新建 Skill</RouterLink
            >
          </div>
        </header>
        <div v-if="!skills.items.length" class="enterprise-empty">
          <span class="enterprise-empty-symbol"><Icon name="book" :size="29" /></span>
          <h2>还没有 Skill</h2>
          <p>从一项常用工作开始，定义目标、步骤与输出要求；创建后可以由助手协助完善草稿。</p>
          <RouterLink to="/agent/skills/new" class="button primary"
            ><Icon name="plus" :size="16" />创建第一个 Skill</RouterLink
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
              <span>修订 r{{ skill.revision ?? 1 }}</span
              ><span>打开工作台 <Icon name="arrow" :size="14" /></span>
            </footer>
          </RouterLink>
        </div>
      </section>
      <div v-if="tab === 'tools'" class="page-note">
        <Icon name="shield" :size="14" /><span
          >能力可发现不等于无限制执行。实际可调用范围由场景与策略共同决定；上传包必须经契约检查与审核，绝不会被直接安装到
          Runner。</span
        >
      </div>
    </div>
    <DialogShell
      v-if="pluginUploadOpen"
      variant="modal"
      label="上传受管插件包"
      panel-class="plugin-upload-dialog"
      @close="!pluginUploadBusy && (pluginUploadOpen = false)"
    >
      <header>
        <div>
          <h2>上传已有 Forge 插件</h2>
          <p>上传 ZIP 包进行 Manifest 与制品完整性检查；上传不会安装 npm 依赖或执行包内代码。</p>
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
      <div class="plugin-upload-body">
        <label class="plugin-file-drop" for="plugin-archive"
          ><Icon name="box" :size="26" /><strong>{{
            pluginArchive ? pluginArchive.name : '选择 .zip 插件包'
          }}</strong
          ><small>包根目录须包含 forge.plugin.json；最大 5 MB。</small
          ><input id="plugin-archive" accept=".zip,application/zip" type="file" @change="choosePluginArchive"
        /></label>
        <div class="plugin-upload-boundary">
          <Icon name="shield" :size="17" />
          <p>
            可审核发布的上传包需使用 <code>forge-remote-worker-v1</code>。原生 DSH
            包可登记为候选，但不会被直接装入 Runner。
          </p>
        </div>
        <div v-if="pluginUploadMessage" class="mcp-feedback" role="alert">{{ pluginUploadMessage }}</div>
      </div>
      <footer>
        <button class="button secondary" :disabled="pluginUploadBusy" @click="pluginUploadOpen = false">
          取消</button
        ><button
          class="button primary"
          :disabled="pluginUploadBusy || !pluginArchive"
          @click="uploadPluginArchive"
        >
          {{ pluginUploadBusy ? '正在校验…' : '上传并校验' }}
        </button>
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
          <p>选择 Streamable HTTP 或旧版 SSE，粘贴远程 HTTPS 服务的 mcpServers JSON。</p>
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
            <option value="sse">SSE（旧版 HTTP）</option>
            <option value="stdio">stdio（本机进程）</option>
          </select>
        </div>
        <label class="mcp-json-label" for="mcp-import-json">mcpServers 配置 JSON</label>
        <textarea
          id="mcp-import-json"
          v-model="mcpJson"
          class="mcp-json-input"
          rows="8"
          spellcheck="false"
          :placeholder="mcpExample"
        ></textarea>
        <p class="mcp-import-hint">
          凭据和 stdio 参数会加密保存在本机，不会在服务列表中显示。stdio 命令会以 Forge
          服务进程权限启动，请只配置可信 MCP 程序；导入后需先测试连接。
        </p>
        <div v-if="mcpMessage" class="mcp-feedback" role="alert">{{ mcpMessage }}</div>
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
