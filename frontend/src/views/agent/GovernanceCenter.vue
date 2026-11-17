<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, put } from '../../api/client';
import { usePlatform } from '../../stores/platform';
import Icon from '../../components/ForgeIcon.vue';
const app = usePlatform(),
  saving = ref(false),
  loaded = ref(false);
const policy = reactive({
  requireWriteApproval: true,
  allowedTools: [] as string[],
  maxOutputTokens: 4096,
  requestTimeoutSeconds: 120,
  approvalTimeoutSeconds: 120,
});
onMounted(async () => {
  try {
    Object.assign(policy, await api('/governance/policies'));
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
    app.toast('策略已保存，将应用于新建会话');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <main class="page-content">
    <div class="enterprise-page-inner">
      <div class="page-heading">
        <div>
          <h1>企业策略</h1>
          <p>治理不是阻碍执行，而是让每次执行都有清晰的授权与责任。</p>
        </div>
        <span class="tag soft"><Icon name="shield" :size="13" />平台策略</span>
      </div>
      <div class="policy-intro">
        <Icon name="info" :size="18" /><span
          >修改只影响<b>新建会话</b>。已开始的会话继续使用启动时锁定的场景与策略快照。</span
        >
      </div>
      <div class="settings-layout">
        <form v-if="loaded" class="settings-card governance-form" @submit.prevent="save">
          <div class="settings-section-heading">
            <Icon name="shield" :size="20" />
            <h2>工具与审批</h2>
          </div>
          <p class="section-description">场景声明与平台策略取交集，未被同时授权的工具一律拒绝。</p>
          <div class="switch-setting">
            <div>
              <strong>写入会话目录前需要审批</strong>
              <p>生成或覆盖文本产物时，逐次等待用户批准；超时默认拒绝。</p>
            </div>
            <button
              type="button"
              role="switch"
              :aria-checked="policy.requireWriteApproval"
              aria-label="写入前需要审批"
              :class="['switch-control', { checked: policy.requireWriteApproval }]"
              @click="policy.requireWriteApproval = !policy.requireWriteApproval"
            >
              <span></span>
            </button>
          </div>
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
