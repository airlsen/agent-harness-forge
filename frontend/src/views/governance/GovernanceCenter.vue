<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { Rule } from 'ant-design-vue/es/form';
import { api, post, put } from '../../api/client';
import { formatBytes } from '../../utils/presentation';
import { usePlatform } from '../../stores/platform';
import type { Tool, WebSearchSettings } from '../../types/platform';
import Icon from '../../components/base/ForgeIcon.vue';
const app = usePlatform(),
  saving = ref(false),
  loaded = ref(false);
const policy = reactive({
  allowedTools: [] as string[],
  allowedPluginTools: ['*'] as string[],
  maxOutputTokens: 4096,
  requestTimeoutSeconds: 120 as number | null,
  approvalTimeoutSeconds: 120 as number | null,
  fileRetentionDays: 30 as number | null,
});

// antd 表单校验规则：执行限额与文件保留天数必填且在范围内。
const policyRules: Record<string, Rule[]> = {
  requestTimeoutSeconds: [
    { required: true, message: '请填写模型请求超时' },
    { type: 'number', min: 15, max: 300, message: '模型请求超时需在 15 到 300 秒之间' },
  ],
  approvalTimeoutSeconds: [
    { required: true, message: '请填写审批等待超时' },
    { type: 'number', min: 15, max: 600, message: '审批等待超时需在 15 到 600 秒之间' },
  ],
  fileRetentionDays: [
    { required: true, message: '请填写文件保留天数' },
    { type: 'number', min: 0, max: 3650, message: '文件保留天数需在 0 到 3650 之间' },
  ],
};

// antd InputNumber 的 ValueType 是 string | number，且清空时可能发 undefined；用 computed 桥接，
// 让 policy 里存 number 或 null（null 会触发必填校验）。
type PolicyNumberKey = 'requestTimeoutSeconds' | 'approvalTimeoutSeconds' | 'fileRetentionDays';
function numberField(key: PolicyNumberKey) {
  return computed<number | undefined>({
    get: () => policy[key] ?? undefined,
    set: (value: number | string | undefined) => {
      policy[key] = typeof value === 'number' ? value : null;
    },
  });
}
const requestTimeoutValue = numberField('requestTimeoutSeconds');
const approvalTimeoutValue = numberField('approvalTimeoutSeconds');
const fileRetentionValue = numberField('fileRetentionDays');

// 工具权限标签以后端登记的 permission 为准，避免按工具名硬编码导致 bash 被误标为「只读」。
function toolTag(tool: Tool) {
  if (tool.name === 'bash') return '写入 · 按风险审批';
  return tool.permission === 'write' ? '写入' : '只读';
}

// 单次模型输出上限的固定档位。
const outputTokenOptions = [1024, 2048, 4096, 8192, 16384].map((value) => ({
  value,
  label: `${value.toLocaleString()} tokens`,
}));
interface StorageStats {
  files: number;
  bytes: number;
  sessions: number;
  storedObjects: number;
  storedBytes: number;
  retentionDays: number;
  lastCleanup: {
    purgedSessions: number;
    backfilledSessions?: number;
    failedSessions: number;
    freedBytes: number;
    ranAt: string;
  } | null;
}
const storage = ref<StorageStats | null>(null),
  cleaning = ref(false);
async function loadStorage() {
  try {
    storage.value = await api<StorageStats>('/governance/storage');
  } catch {
    storage.value = null;
  }
}
async function cleanup() {
  cleaning.value = true;
  try {
    const result = await post<NonNullable<StorageStats['lastCleanup']>>('/governance/storage/cleanup', {});
    const parts = [];
    if (result.purgedSessions || result.freedBytes)
      parts.push(`已清理 ${result.purgedSessions} 个过期会话的文件，释放 ${formatBytes(result.freedBytes)}`);
    if (result.backfilledSessions) parts.push(`${result.backfilledSessions} 个旧会话的文件已补存到服务端`);
    if (result.failedSessions) parts.push(`${result.failedSessions} 个会话处理失败，将在下次自动重试`);
    app.toast(parts.join('；') || '没有需要清理的文件', result.failedSessions ? 'error' : 'success');
    await loadStorage();
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    cleaning.value = false;
  }
}
// 联网搜索：DSH 的 web_search（DeepSeek 联网搜索）与 web_fetch（公网网页读取）
const web = ref<WebSearchSettings | null>(null),
  webSaving = ref(false);
const webForm = reactive({
  enabled: false,
  provider: 'deepseek-official',
  baseUrl: '',
  fetchEnabled: true,
  apiKey: '',
});

// 联网表单校验规则：服务地址可选，填写时需为 http/https 地址。
const webRules: Record<string, Rule[]> = {
  baseUrl: [
    {
      validator: async (_rule, value) => {
        if (!value) return;
        let ok = false;
        try {
          const url = new URL(value);
          ok = url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
          ok = false;
        }
        if (!ok) throw new Error('请输入以 http/https 开头的有效地址');
      },
      trigger: 'blur',
    },
  ],
};
const providerOptions = computed(() =>
  (web.value?.providers ?? []).map((provider) => ({ value: provider.id, label: provider.label })),
);
function applyWeb(value: WebSearchSettings) {
  web.value = value;
  Object.assign(webForm, {
    enabled: value.enabled,
    provider: value.provider,
    baseUrl: value.baseUrl,
    fetchEnabled: value.fetchEnabled,
    apiKey: '',
  });
}
async function loadWeb() {
  try {
    applyWeb(await api<WebSearchSettings>('/governance/web-search'));
  } catch {
    web.value = null;
  }
}
async function saveWeb(clearKey = false) {
  webSaving.value = true;
  try {
    const result = await put<WebSearchSettings>('/governance/web-search', {
      enabled: webForm.enabled,
      provider: webForm.provider,
      baseUrl: webForm.baseUrl.trim(),
      fetchEnabled: webForm.fetchEnabled,
      ...(webForm.apiKey.trim() ? { apiKey: webForm.apiKey.trim() } : {}),
      clearKey,
    });
    applyWeb(result);
    app.toast(
      result.available
        ? '联网设置已保存，场景或聊天开启联网后从下一轮起生效'
        : result.reason || '联网设置已保存',
      result.enabled && !result.searchReady ? 'info' : 'success',
    );
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    webSaving.value = false;
  }
}
// 关联代码目录：工作台「关联代码」从这里列项目（每个一级子目录一个项目），留空使用 FORGE_CODE_ROOT
interface CodeRootStatus {
  root: string;
  effectiveRoot: string;
  available: boolean;
  count: number;
  projects: string[];
}
const codeRootInput = ref(''),
  codeRootChecked = ref<CodeRootStatus | null>(null),
  codeRootBusy = ref(false);
// 只显示与当前输入一致的检查结果，改了路径需要重新检查
const codeRootResult = computed(() =>
  codeRootChecked.value && codeRootChecked.value.root === codeRootInput.value.trim()
    ? codeRootChecked.value
    : null,
);
async function loadCodeRoot() {
  try {
    codeRootChecked.value = await api<CodeRootStatus>('/governance/code-root');
    codeRootInput.value = codeRootChecked.value.root;
  } catch {
    codeRootChecked.value = null;
  }
}
async function codeRootRequest(save: boolean) {
  codeRootBusy.value = true;
  try {
    const body = { root: codeRootInput.value.trim() };
    codeRootChecked.value = save
      ? await put<CodeRootStatus>('/governance/code-root', body)
      : await post<CodeRootStatus>('/governance/code-root/check', body);
    if (save) app.toast(`代码目录已保存，共 ${codeRootChecked.value.count} 个项目`, 'success');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    codeRootBusy.value = false;
  }
}
const KEY_SOURCE: Record<WebSearchSettings['keySource'], string> = {
  custom: '已单独配置搜索密钥',
  model: '复用模型中心的 DeepSeek 官方模型密钥',
  none: '未配置密钥：仅能读取网页，无法搜索',
};
function cleanupTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
onMounted(async () => {
  try {
    Object.assign(policy, await api('/governance/policies'));
    void loadStorage();
    void loadWeb();
    void loadCodeRoot();
    await app.refreshRuntime();
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    loaded.value = true;
  }
});
async function save() {
  saving.value = true;
  try {
    await put('/governance/policies', policy);
    app.toast('策略已保存：执行限额应用于新建会话，文件保留期限即时生效');
    void loadStorage();
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <main class="page-content enterprise-page admin-theme-page">
    <div class="enterprise-page-inner">
      <div class="page-heading">
        <div>
          <h1>执行策略</h1>
          <p>治理不是阻碍执行，而是让每次执行都有清晰的授权与责任。</p>
        </div>
        <span class="tag soft"><Icon name="shield" :size="13" />平台策略</span>
      </div>
      <div class="policy-intro">
        <Icon name="info" :size="18" /><span
          >工具与执行限额只影响<b>新建会话</b>，已开始的会话继续使用启动时锁定的场景与策略快照；文件保留期限对所有会话即时生效。</span
        >
      </div>
      <div class="settings-layout">
        <a-form
          v-if="loaded"
          class="settings-card governance-form"
          :model="policy"
          :rules="policyRules"
          layout="vertical"
          @finish="save"
        >
          <div class="settings-section-heading">
            <Icon name="shield" :size="20" />
            <h2>工具与审批</h2>
          </div>
          <p class="section-description">
            勾选的工具是所有会话的能力上限：基础工具默认对每个会话开放，场景声明的其他工具也须在此授权；关联代码同样不能越过这里的设置。
          </p>
          <div class="policy-tool-list">
            <label v-for="tool in app.tools" :key="tool.name" class="tool-checkbox" :title="tool.description"
              ><input v-model="policy.allowedTools" type="checkbox" :value="tool.name" /><span
                class="tool-checkbox-icon"
                ><Icon :name="tool.icon" :size="18"
              /></span>
              <div>
                <strong>{{ tool.title }}</strong><small>{{ tool.name }}</small>
              </div>
              <span :class="['tag', tool.permission === 'write' ? 'warm' : 'soft']">{{
                toolTag(tool)
              }}</span></label
            >
          </div>
          <div class="switch-setting plugin-policy-setting">
            <div>
              <strong>允许已审核的受管插件工具</strong>
              <p>仍需由场景逐项授权；写入型插件工具始终逐次等待审批。关闭后，新场景不能装配插件工具。</p>
            </div>
            <button
              type="button"
              role="switch"
              :aria-checked="policy.allowedPluginTools.includes('*')"
              aria-label="允许受管插件工具"
              :class="['switch-control', { checked: policy.allowedPluginTools.includes('*') }]"
              @click="policy.allowedPluginTools = policy.allowedPluginTools.includes('*') ? [] : ['*']"
            >
              <span></span>
            </button>
          </div>
          <div class="enforced-policy">
            <Icon name="lock" :size="16" />
            <div>
              <strong>部署层强制边界</strong>
              <p>
                不开放不受限的宿主机 Shell
                与宿主机文件访问。终端命令（bash）仅在会话工作区或关联项目中受控执行：只读命令自动放行，修改、编译等命令逐次审批，高危命令直接拦截。联网仅限下方受控的搜索与公网网页读取。
              </p>
            </div>
          </div>
          <div class="form-divider"></div>
          <div class="settings-section-heading">
            <Icon name="sliders" :size="20" />
            <h2>执行限额</h2>
          </div>
          <div class="form-grid">
            <a-form-item label="单次模型输出上限" name="maxOutputTokens">
              <a-select v-model:value="policy.maxOutputTokens" :options="outputTokenOptions" />
            </a-form-item>
            <a-form-item label="模型请求超时（秒）" name="requestTimeoutSeconds">
              <a-input-number
                v-model:value="requestTimeoutValue"
                :min="15"
                :max="300"
                :controls="false"
                style="width: 100%"
              />
            </a-form-item>
            <a-form-item label="审批等待超时（秒）" name="approvalTimeoutSeconds">
              <a-input-number
                v-model:value="approvalTimeoutValue"
                :min="15"
                :max="600"
                :controls="false"
                style="width: 100%"
              />
            </a-form-item>
          </div>
          <div class="form-divider"></div>
          <div class="settings-section-heading">
            <Icon name="folder" :size="20" />
            <h2>会话文件</h2>
          </div>
          <p class="section-description">
            每轮结束后，会话工作区的文件会保存到服务端磁盘，切换会话或服务重启后仍可查看。会话最后一次活动超过保留期限后，其文件会被自动清理。
          </p>
          <div class="form-grid">
            <a-form-item label="文件保留天数" name="fileRetentionDays">
              <a-input-number
                v-model:value="fileRetentionValue"
                :min="0"
                :max="3650"
                :step="1"
                :controls="false"
                style="width: 100%"
              />
              <small class="field-hint">0 表示永久保留；修改后对所有会话即时生效。</small>
            </a-form-item>
          </div>
          <div v-if="storage" class="storage-summary">
            <dl>
              <div>
                <dt>文件</dt>
                <dd>{{ storage.files }} 个 · {{ storage.sessions }} 个会话</dd>
              </div>
              <div>
                <dt>文件总大小</dt>
                <dd>{{ formatBytes(storage.bytes) }}</dd>
              </div>
              <div>
                <dt>磁盘占用（含历史版本，已去重）</dt>
                <dd>{{ formatBytes(storage.storedBytes) }}</dd>
              </div>
              <div>
                <dt>最近清理</dt>
                <dd>
                  <template v-if="storage.lastCleanup"
                    >{{ cleanupTime(storage.lastCleanup.ranAt) }} ·
                    {{ storage.lastCleanup.purgedSessions }} 个会话</template
                  ><template v-else>尚未执行</template>
                </dd>
              </div>
            </dl>
            <button type="button" class="button secondary" :disabled="cleaning" @click="cleanup">
              <span v-if="cleaning" class="loader small"></span
              ><Icon v-else name="trash" :size="15" />立即清理过期文件
            </button>
          </div>
          <footer class="settings-footer">
            <span>配置保存后立即持久化</span
            ><button class="button primary" :disabled="saving">
              <span v-if="saving" class="loader small"></span><Icon v-else name="save" :size="16" />保存策略
            </button>
          </footer>
        </a-form>
        <aside class="settings-aside">
          <section class="settings-card governance-form web-search-card">
            <div class="settings-section-heading">
              <Icon name="folder" :size="18" />
              <h2>关联代码目录</h2>
            </div>
            <p class="section-description">
              工作台「关联代码」从这个目录列出项目，每个一级子目录是一个项目。留空使用默认目录。
            </p>
            <a-input
              v-model:value="codeRootInput"
              placeholder="例如 /usr/data/git，留空使用默认目录"
              allow-clear
              @press-enter="codeRootRequest(false)"
            />
            <small v-if="codeRootResult" class="field-hint">
              <template v-if="codeRootResult.available"
                >✓ {{ codeRootResult.effectiveRoot }} · 共 {{ codeRootResult.count }} 个项目<template
                  v-if="codeRootResult.count"
                  >：{{ codeRootResult.projects.join('、')
                  }}{{ codeRootResult.count > codeRootResult.projects.length ? ' …' : '' }}</template
                ></template
              >
              <template v-else>✗ {{ codeRootResult.effectiveRoot }} 不存在或不是目录，不能保存</template>
            </small>
            <div style="display: flex; gap: 8px; margin-top: 14px">
              <button
                type="button"
                class="button secondary"
                :disabled="codeRootBusy"
                @click="codeRootRequest(false)"
              >
                检查路径
              </button>
              <button
                type="button"
                class="button primary"
                :disabled="codeRootBusy || (!!codeRootResult && !codeRootResult.available)"
                @click="codeRootRequest(true)"
              >
                <span v-if="codeRootBusy" class="loader small"></span
                ><Icon v-else name="save" :size="16" />保存
              </button>
            </div>
          </section>
          <a-form
            v-if="web"
            class="settings-card governance-form web-search-card"
            :model="webForm"
            :rules="webRules"
            layout="vertical"
            @finish="saveWeb()"
          >
            <div class="settings-section-heading">
              <Icon name="globe" :size="18" />
              <h2>联网搜索</h2>
            </div>
            <p class="section-description">
              开启后，场景或聊天可选用联网：模型能搜索网络并读取公网网页（不访问内网地址）。每次搜索约等于一次模型调用。
            </p>
            <div class="switch-setting">
              <div>
                <strong>允许联网</strong>
                <p>{{ web.available ? '已可用' : web.reason || '未开启' }}</p>
              </div>
              <button
                type="button"
                role="switch"
                :aria-checked="webForm.enabled"
                aria-label="允许联网"
                :class="['switch-control', { checked: webForm.enabled }]"
                @click="webForm.enabled = !webForm.enabled"
              >
                <span></span>
              </button>
            </div>
            <a-form-item label="搜索服务" name="provider">
              <a-select v-model:value="webForm.provider" :options="providerOptions" />
            </a-form-item>
            <a-form-item label="DeepSeek API Key" name="apiKey">
              <a-input-password
                v-model:value="webForm.apiKey"
                autocomplete="off"
                :placeholder="web.apiKeyConfigured ? '已保存，留空则不修改' : '留空则复用 DeepSeek 模型密钥'"
              />
              <small class="field-hint"
                >{{ KEY_SOURCE[web.keySource]
                }}<template v-if="web.apiKeyConfigured">
                  ·
                  <button type="button" class="link-button" :disabled="webSaving" @click="saveWeb(true)">
                    清除已保存密钥
                  </button></template
                ></small
              >
            </a-form-item>
            <a-form-item label="服务地址（可选）" name="baseUrl">
              <a-input v-model:value="webForm.baseUrl" placeholder="留空使用 DeepSeek 默认地址" />
            </a-form-item>
            <label class="web-fetch-option"
              ><input v-model="webForm.fetchEnabled" type="checkbox" /><span
                >允许读取网页内容（web_fetch）</span
              ></label
            >
            <button class="button primary" :disabled="webSaving">
              <span v-if="webSaving" class="loader small"></span
              ><Icon v-else name="save" :size="16" />保存联网设置
            </button>
          </a-form>
          <section class="settings-card deployment-card">
            <div class="settings-section-heading">
              <Icon name="server" :size="18" />
              <h2>当前部署</h2>
            </div>
            <dl>
              <div>
                <dt>控制面</dt>
                <dd>FastAPI <span class="dot"></span></dd>
              </div>
              <div>
                <dt>执行内核</dt>
                <dd>
                  {{ app.runtime?.runner.status === 'online' ? '在线' : '离线'
                  }}<span :class="['dot', { neutral: app.runtime?.runner.status !== 'online' }]"></span>
                </dd>
              </div>
              <div>
                <dt>Harness</dt>
                <dd>{{ app.runtime?.runner.dshVersion ?? '—' }}</dd>
              </div>
              <div>
                <dt>Node.js</dt>
                <dd>{{ app.runtime?.runner.node ?? '—' }}</dd>
              </div>
              <div>
                <dt>持久化存储</dt>
                <dd>{{ app.runtime?.storage ?? '—' }}</dd>
              </div>
              <div>
                <dt>执行并发</dt>
                <dd>{{ app.runtime?.runner.active ?? 0 }} / {{ app.runtime?.runner.capacity ?? '—' }}</dd>
              </div>
              <div>
                <dt>认证方式</dt>
                <dd>本地管理员账号</dd>
              </div>
            </dl>
          </section>
          <section class="settings-card deployment-boundaries">
            <h3><Icon name="info" :size="18" />开发部署的边界</h3>
            <ul>
              <li v-for="note in app.runtime?.limitations" :key="note">{{ note }}</li>
            </ul>
            <p>沙箱休眠或停止时，服务可能中断。长期与生产部署需要单独的基础设施和安全配置。</p>
          </section>
        </aside>
      </div>
    </div>
  </main>
</template>
