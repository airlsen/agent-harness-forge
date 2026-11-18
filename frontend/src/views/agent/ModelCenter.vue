<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api, post, put, remove } from '../../api/client';
import { usePlatform } from '../../stores/platform';
import type { ModelConnection } from '../../types/platform';
import Icon from '../../components/ForgeIcon.vue';
import DialogShell from '../../components/DialogShell.vue';

type ModelHealthTone = 'normal' | 'attention' | 'unverified' | 'disabled';
type ModelTestResult = ModelConnection['lastTest'];

const app = usePlatform();
const models = ref<ModelConnection[]>([]);
const loading = ref(true);
const loadError = ref('');
const editorOpen = ref(false);
const editing = ref<ModelConnection | null>(null);
const saving = ref(false);
const deletingId = ref<number | null>(null);
const defaultingId = ref<number | null>(null);
const testingId = ref<number | null>(null);
const changingAvailabilityId = ref<number | null>(null);
const actionMenuId = ref<number | null>(null);
const form = reactive({
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  contextWindow: 64000,
  inputPrice: null as number | null,
  outputPrice: null as number | null,
});

const enabledCount = computed(() => models.value.filter((model) => model.enabled).length);
const attentionCount = computed(
  () => models.value.filter((model) => model.enabled && modelHealth(model).tone !== 'normal').length,
);

function resetForm(model?: ModelConnection) {
  editing.value = model ?? null;
  form.name = model?.name ?? '';
  form.baseUrl = model?.baseUrl ?? '';
  form.model = model?.model ?? '';
  form.apiKey = '';
  form.contextWindow = model?.contextWindow ?? 64000;
  form.inputPrice = model?.inputPrice ?? null;
  form.outputPrice = model?.outputPrice ?? null;
}
function openEditor(model?: ModelConnection) {
  resetForm(model);
  actionMenuId.value = null;
  editorOpen.value = true;
}
function closeEditor() {
  if (!saving.value) editorOpen.value = false;
}
function endpointHost(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
function formatTestTime(at?: string) {
  if (!at) return '';
  const testedAt = new Date(at);
  const elapsed = Date.now() - testedAt.getTime();
  if (Number.isNaN(elapsed) || elapsed < 0) return '上次测试';
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return '刚刚验证';
  if (minutes < 60) return `${minutes} 分钟前验证`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前验证`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(testedAt);
}
function modelHealth(model: ModelConnection): { tone: ModelHealthTone; label: string; description: string } {
  if (!model.enabled)
    return {
      tone: 'disabled',
      label: '已停用',
      description: '不会出现在聊天模型选择中；已在使用它的会话仍可继续',
    };
  if (model.lastTest?.ok)
    return {
      tone: 'normal',
      label: '连接正常',
      description: `${formatTestTime(model.lastTest.at)}${model.lastTest.latencyMs !== undefined ? ` · ${model.lastTest.latencyMs} ms` : ''}`,
    };
  if (model.lastTest?.at)
    return {
      tone: 'attention',
      label: '连接异常',
      description: model.lastTest.message || `${formatTestTime(model.lastTest.at)}，请检查模型服务配置`,
    };
  return { tone: 'unverified', label: '尚未验证', description: '启用后可随时手动测试连接' };
}
function toggleActionMenu(id?: number) {
  if (!id) return;
  actionMenuId.value = actionMenuId.value === id ? null : id;
}
function closeActionMenu() {
  actionMenuId.value = null;
}
async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    models.value = (await api<{ items: ModelConnection[] }>('/models')).items;
  } catch (error) {
    loadError.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) {
    app.toast('请填写模型名称、Base URL 和模型 ID', 'error');
    return;
  }
  saving.value = true;
  try {
    const payload = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      apiKey: form.apiKey || null,
      contextWindow: form.contextWindow,
      inputPrice: form.inputPrice,
      outputPrice: form.outputPrice,
    };
    if (editing.value?.id) await put(`/models/${editing.value.id}`, payload);
    else await post('/models', payload);
    await Promise.all([load(), app.refreshRuntime()]);
    app.toast(editing.value ? '模型配置已保存' : '模型已添加。');
    editorOpen.value = false;
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    saving.value = false;
  }
}
async function testModel(model: ModelConnection) {
  if (!model.id || testingId.value !== null) return;
  testingId.value = model.id;
  try {
    const result = await post<ModelTestResult>(`/models/${model.id}/test`);
    model.lastTest = result;
    await app.refreshRuntime();
    app.toast(
      result.ok ? `“${model.name}”连接验证通过` : result.message || `“${model.name}”连接异常`,
      result.ok ? 'success' : 'error',
    );
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    testingId.value = null;
  }
}
async function toggleAvailability(model: ModelConnection) {
  if (!model.id || changingAvailabilityId.value !== null) return;
  const enabled = !model.enabled;
  changingAvailabilityId.value = model.id;
  try {
    const updated = await api<ModelConnection>(`/models/${model.id}/availability`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    models.value = models.value.map((item) => (item.id === model.id ? updated : item));
    await app.refreshRuntime();
    app.toast(enabled ? `“${model.name}”已启用，可供聊天工作台选择` : `“${model.name}”已停用`);
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    changingAvailabilityId.value = null;
  }
}
async function setDefault(model: ModelConnection) {
  if (!model.id || !model.enabled || model.isDefault || defaultingId.value !== null) return;
  actionMenuId.value = null;
  defaultingId.value = model.id;
  try {
    const updated = await put<ModelConnection>(`/models/${model.id}/default`, {});
    // 平台只有一个默认模型：其余配置的默认标记同步清除。
    models.value = models.value.map((item) =>
      item.id === updated.id ? updated : { ...item, isDefault: false },
    );
    await app.refreshRuntime();
    app.toast(`“${model.name}”已设为平台默认模型，新会话将默认使用它`, 'success');
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    defaultingId.value = null;
  }
}
async function deleteModel(model: ModelConnection) {
  if (!model.id || deletingId.value !== null) return;
  actionMenuId.value = null;
  if (!window.confirm(`确定删除模型“${model.name}”吗？历史会话仍保留已有模型快照。`)) return;
  deletingId.value = model.id;
  try {
    await remove(`/models/${model.id}`);
    await Promise.all([load(), app.refreshRuntime()]);
    app.toast('模型配置已删除。');
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    deletingId.value = null;
  }
}

onMounted(() => {
  document.addEventListener('click', closeActionMenu);
  void load();
});
onBeforeUnmount(() => document.removeEventListener('click', closeActionMenu));
</script>

<template>
  <main class="page-content enterprise-page model-management-page">
    <div class="enterprise-page-inner">
      <div class="page-heading model-management-heading">
        <div>
          <h1>模型管理</h1>
          <p>
            维护企业模型配置。已启用的模型可在聊天中选择，并可在会话两轮之间切换；新会话未选择时使用平台默认模型。停用模型不影响正在使用它的会话继续，密钥只保存在服务端。
          </p>
          <p v-if="models.length && !loading" class="model-management-summary" aria-live="polite">
            <span
              ><strong>{{ models.length }}</strong> 个模型配置</span
            >
            <span
              ><strong>{{ enabledCount }}</strong> 个已启用</span
            >
            <span v-if="attentionCount" class="needs-attention"
              ><strong>{{ attentionCount }}</strong> 个待验证或异常</span
            >
          </p>
        </div>
        <div class="page-heading-actions">
          <button class="button primary" @click="openEditor()">
            <Icon name="plus" :size="16" />添加模型
          </button>
        </div>
      </div>

      <section v-if="loading" class="model-management-loading" aria-live="polite">
        <span class="loader"></span>正在读取模型配置…
      </section>
      <section v-else-if="loadError" class="form-alert error model-management-alert" role="alert">
        <Icon name="info" :size="18" />
        <div>
          <strong>模型配置未能读取</strong>
          <p>{{ loadError }}</p>
        </div>
        <button class="button secondary small" @click="load">重试</button>
      </section>
      <section v-else-if="!models.length" class="enterprise-empty model-management-empty">
        <span class="enterprise-empty-symbol"><Icon name="cpu" :size="30" /></span>
        <h2>还没有模型配置</h2>
        <p>添加一个兼容 OpenAI Chat Completions 的模型连接，统一维护其名称、端点、模型 ID 和凭据。</p>
        <button class="button primary" @click="openEditor()">
          <Icon name="plus" :size="16" />添加第一个模型
        </button>
      </section>
      <section v-else class="model-card-grid" aria-label="模型配置列表">
        <article
          v-for="model in models"
          :key="model.id"
          :class="[
            'model-management-card',
            {
              'is-disabled': !model.enabled,
              'needs-attention': model.enabled && modelHealth(model).tone === 'attention',
            },
          ]"
        >
          <div class="model-card-top">
            <span class="model-card-icon"><Icon name="cpu" :size="20" /></span>
            <button
              type="button"
              :class="['model-availability-toggle', { enabled: model.enabled }]"
              role="switch"
              :aria-checked="model.enabled"
              :aria-label="`${model.name}：${model.enabled ? '已启用，点击停用' : '已停用，点击启用'}`"
              :disabled="
                !model.id ||
                changingAvailabilityId === model.id ||
                testingId === model.id ||
                deletingId === model.id
              "
              @click="toggleAvailability(model)"
            >
              <span class="model-toggle-track" aria-hidden="true"><i></i></span>
              <span>{{
                changingAvailabilityId === model.id ? '正在更新…' : model.enabled ? '已启用' : '已停用'
              }}</span>
            </button>
          </div>
          <div class="model-card-copy">
            <h2>
              <span>{{ model.name }}</span><em
                v-if="model.id === app.defaultModelId"
                :class="['model-default-tag', { 'is-implicit': !model.isDefault }]"
                :title="
                  model.isDefault
                    ? '平台默认模型：新会话未选择模型时使用'
                    : '尚未设置平台默认模型，暂时自动使用最早启用的模型；可在更多操作中设为默认'
                "
                >{{ model.isDefault ? '默认' : '默认 · 自动' }}</em
              >
            </h2>
            <p>{{ model.model }}</p>
          </div>
          <dl class="model-card-details">
            <div>
              <dt>服务地址</dt>
              <dd>{{ endpointHost(model.baseUrl) }}</dd>
            </div>
            <div>
              <dt>上下文窗口</dt>
              <dd>{{ model.contextWindow.toLocaleString() }}</dd>
            </div>
          </dl>
          <div :class="['model-card-status', `is-${modelHealth(model).tone}`]">
            <span class="model-status-dot" aria-hidden="true"></span>
            <p>
              <strong>{{ modelHealth(model).label }}</strong>
              <span>{{ modelHealth(model).description }}</span>
            </p>
          </div>
          <footer>
            <button
              type="button"
              class="button secondary small"
              :disabled="
                !model.id ||
                testingId === model.id ||
                changingAvailabilityId === model.id ||
                deletingId === model.id
              "
              @click="testModel(model)"
            >
              <span v-if="testingId === model.id" class="loader small"></span
              ><Icon v-else name="activity" :size="14" />{{
                testingId === model.id ? '正在测试…' : '测试连接'
              }}
            </button>
            <div class="model-card-actions">
              <button type="button" class="button text small" @click="openEditor(model)">编辑</button>
              <div class="model-card-menu">
                <button
                  type="button"
                  class="icon-button small model-card-more"
                  aria-label="更多模型操作"
                  :aria-expanded="actionMenuId === model.id"
                  :disabled="
                    testingId === model.id ||
                    changingAvailabilityId === model.id ||
                    deletingId === model.id ||
                    defaultingId === model.id
                  "
                  @click.stop="toggleActionMenu(model.id)"
                >
                  <Icon name="more" :size="18" />
                </button>
                <div v-if="actionMenuId === model.id" class="model-card-menu-list" role="menu" @click.stop>
                  <button
                    v-if="model.enabled && !model.isDefault"
                    type="button"
                    role="menuitem"
                    @click="setDefault(model)"
                  >
                    <Icon name="check" :size="15" />设为默认
                  </button>
                  <button type="button" role="menuitem" class="danger" @click="deleteModel(model)">
                    <Icon name="trash" :size="15" />删除模型
                  </button>
                </div>
              </div>
            </div>
          </footer>
        </article>
      </section>
    </div>
  </main>

  <DialogShell
    v-if="editorOpen"
    label="模型配置"
    variant="drawer"
    panel-class="model-editor-drawer"
    @close="closeEditor"
  >
    <header>
      <div>
        <h2>{{ editing ? '编辑模型' : '添加模型' }}</h2>
        <p>填写模型服务的实际连接信息。保存后可手动测试连接，测试不是启用前置条件。</p>
      </div>
      <button class="icon-button" aria-label="关闭模型配置" :disabled="saving" @click="closeEditor">
        <Icon name="close" :size="20" />
      </button>
    </header>
    <form class="model-editor-form" @submit.prevent="save">
      <label for="model-name">模型名称 <span class="required">*</span></label>
      <input
        id="model-name"
        v-model="form.name"
        maxlength="100"
        placeholder="例如：企业 DeepSeek Chat"
        required
      />

      <label for="model-id">模型 ID <span class="required">*</span></label>
      <input id="model-id" v-model="form.model" maxlength="128" placeholder="例如：deepseek-chat" required />

      <label for="model-base-url">Base URL <span class="required">*</span></label>
      <input
        id="model-base-url"
        v-model="form.baseUrl"
        type="url"
        maxlength="512"
        placeholder="https://your-gateway.example.com/v1"
        required
      />
      <p class="field-hint">填写 API 根路径，不包含 <code>/chat/completions</code>。</p>

      <label for="model-api-key">API Key</label>
      <input
        id="model-api-key"
        v-model="form.apiKey"
        type="password"
        autocomplete="new-password"
        :placeholder="editing?.apiKeyConfigured ? '留空保留已保存密钥；填写新值可替换' : '无鉴权服务可留空'"
      />
      <p class="field-hint">密钥仅通过同源 API 提交，并以加密形式存储在服务端。</p>

      <label for="model-context-window">上下文窗口（tokens）</label>
      <input
        id="model-context-window"
        v-model.number="form.contextWindow"
        type="number"
        min="4096"
        max="2000000"
        required
      />
    </form>
    <footer>
      <button class="button secondary" :disabled="saving" @click="closeEditor">取消</button>
      <button class="button primary" :disabled="saving" @click="save">
        <span v-if="saving" class="loader small"></span><Icon v-else name="save" :size="16" />{{
          saving ? '正在保存…' : '保存模型'
        }}
      </button>
    </footer>
  </DialogShell>
</template>
