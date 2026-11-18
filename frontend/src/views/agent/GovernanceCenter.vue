<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, post, put } from '../../api/client';
import { formatBytes } from '../../utils/presentation';
import { usePlatform } from '../../stores/platform';
import Icon from '../../components/ForgeIcon.vue';
const app = usePlatform(),
  saving = ref(false),
  loaded = ref(false);
const policy = reactive({
  allowedTools: [] as string[],
  allowedPluginTools: ['*'] as string[],
  maxOutputTokens: 4096,
  requestTimeoutSeconds: 120,
  approvalTimeoutSeconds: 120,
  fileRetentionDays: 30,
});
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
function cleanupTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
onMounted(async () => {
  try {
    Object.assign(policy, await api('/governance/policies'));
    void loadStorage();
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
  <main class="page-content enterprise-page">
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
        <form v-if="loaded" class="settings-card governance-form" @submit.prevent="save">
          <div class="settings-section-heading">
            <Icon name="shield" :size="20" />
            <h2>工具与审批</h2>
          </div>
          <p class="section-description">场景声明与平台策略取交集，未被同时授权的工具一律拒绝。</p>
          <div class="policy-tool-list">
            <label v-for="tool in app.tools" :key="tool.name" class="tool-checkbox"
              ><input v-model="policy.allowedTools" type="checkbox" :value="tool.name" /><span
                class="tool-checkbox-icon"
                ><Icon :name="tool.icon" :size="18"
              /></span>
              <div>
                <strong>{{ tool.title }}</strong><small>{{ tool.name }}</small>
              </div>
              <span class="tag soft">{{ tool.name === 'workspace_write' ? '写入' : '只读' }}</span></label
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
              <p>任意 Shell、宿主机文件访问和通用网络工具未开放，不能通过此页面启用。</p>
            </div>
          </div>
          <div class="form-divider"></div>
          <div class="settings-section-heading">
            <Icon name="sliders" :size="20" />
            <h2>执行限额</h2>
          </div>
          <div class="form-grid">
            <div>
              <label for="output-tokens">单次模型输出上限</label
              ><select id="output-tokens" v-model.number="policy.maxOutputTokens">
                <option :value="1024">1,024 tokens</option>
                <option :value="2048">2,048 tokens</option>
                <option :value="4096">4,096 tokens</option>
                <option :value="8192">8,192 tokens</option>
                <option :value="16384">16,384 tokens</option>
              </select>
            </div>
            <div>
              <label for="request-timeout">模型请求超时（秒）</label
              ><input
                id="request-timeout"
                v-model.number="policy.requestTimeoutSeconds"
                type="number"
                min="15"
                max="300"
              />
            </div>
            <div>
              <label for="approval-timeout">审批等待超时（秒）</label
              ><input
                id="approval-timeout"
                v-model.number="policy.approvalTimeoutSeconds"
                type="number"
                min="15"
                max="600"
              />
            </div>
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
            <div>
              <label for="file-retention">文件保留天数</label
              ><input
                id="file-retention"
                v-model.number="policy.fileRetentionDays"
                type="number"
                min="0"
                max="3650"
                step="1"
                required
              />
              <small class="field-hint">0 表示永久保留；修改后对所有会话即时生效。</small>
            </div>
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
        </form>
        <aside class="settings-aside">
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
                <dt>Runner 会话</dt>
                <dd>{{ app.runtime?.runner.sessions ?? 0 }} / {{ app.runtime?.runner.capacity ?? '—' }}</dd>
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
