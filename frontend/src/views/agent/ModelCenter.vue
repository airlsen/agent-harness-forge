<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, post, put, remove } from '../../api/client';
import { usePlatform } from '../../stores/platform';
import type { ModelConnection } from '../../types/platform';
import Icon from '../../components/ForgeIcon.vue';
import DialogShell from '../../components/DialogShell.vue';

const app = usePlatform();
const models = ref<ModelConnection[]>([]);
const loading = ref(true);
const loadError = ref('');
const editorOpen = ref(false);
const editing = ref<ModelConnection | null>(null);
const saving = ref(false);
const deletingId = ref<number | null>(null);
const form = reactive({
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  contextWindow: 64000,
  inputPrice: null as number | null,
  outputPrice: null as number | null,
});

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
async function deleteModel(model: ModelConnection) {
  if (!model.id || deletingId.value !== null) return;
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

onMounted(load);
</script>

<template>
  <main class="page-content enterprise-page model-management-page">
    <div class="enterprise-page-inner">
      <div class="page-heading model-management-heading">
        <div>
          <h1>模型管理</h1>
          <p>维护企业模型配置，为聊天工作台后续的模型选择提供统一来源；密钥只保存在服务端。</p>
        </div>
        <div class="page-heading-actions">
          <span v-if="models.length" class="heading-count">{{ models.length }} 个模型</span>
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
        <article v-for="model in models" :key="model.id" class="model-management-card">
          <div class="model-card-top">
            <span class="model-card-icon"><Icon name="cpu" :size="20" /></span>
          </div>
          <div class="model-card-copy">
            <h2>{{ model.name }}</h2>
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
          <footer>
            <button class="button secondary small" @click="openEditor(model)">编辑</button>
            <button
              class="button text small danger-text"
              :disabled="deletingId === model.id"
              @click="deleteModel(model)"
            >
              {{ deletingId === model.id ? '正在删除…' : '删除' }}
            </button>
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
        <p>填写模型服务的实际连接信息。保存后不会展示或回传 API Key 原文。</p>
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
