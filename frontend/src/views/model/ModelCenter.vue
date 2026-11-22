<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { Rule } from 'ant-design-vue/es/form';
import type { MenuInfo } from 'ant-design-vue/es/menu/src/interface';
import { api, post, put, remove } from '../../api/client';
import { usePlatform } from '../../stores/platform';
import { confirm } from '../../utils/feedback';
import type { ModelConnection } from '../../types/platform';
import Icon from '../../components/ForgeIcon.vue';
import CatalogEmpty from '../../components/catalog/CatalogEmpty.vue';
import { drawerA11y } from '../../utils/overlay';

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
const form = reactive({
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  contextWindow: 64000 as number | null,
  inputPrice: null as number | null,
  outputPrice: null as number | null,
});

// antd 表单校验规则：等价于原原生 HTML5 校验（必填、URL、数值范围），并提供字段级错误提示。
const rules: Record<string, Rule[]> = {
  name: [
    { required: true, whitespace: true, message: '请填写模型名称' },
    { max: 100, message: '模型名称不能超过 100 个字符' },
  ],
  model: [
    { required: true, whitespace: true, message: '请填写模型 ID' },
    { max: 128, message: '模型 ID 不能超过 128 个字符' },
  ],
  baseUrl: [
    { required: true, whitespace: true, message: '请填写 Base URL' },
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
    { max: 512, message: 'Base URL 不能超过 512 个字符' },
  ],
  contextWindow: [
    { required: true, message: '请填写上下文窗口' },
    { type: 'number', min: 4096, max: 2000000, message: '上下文窗口需在 4096 到 2000000 之间' },
  ],
};

// antd InputNumber 的 ValueType 不含 null，但清空时会发 null；用 computed 桥接，让 form 里可存 null 以触发“必填”校验。
const contextWindowValue = computed({
  get: () => form.contextWindow ?? undefined,
  set: (value: number | string | undefined) => {
    form.contextWindow = typeof value === 'number' ? value : null;
  },
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
  if (saving.value) return;
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
  if (
    !(await confirm({
      title: `确定删除模型“${model.name}”吗？`,
      content: '历史会话仍保留已有模型快照。',
      okText: '删除',
      danger: true,
    }))
  )
    return;
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

function modelMenuClick(info: MenuInfo, model: ModelConnection) {
  if (info.key === 'default') void setDefault(model);
  if (info.key === 'delete') void deleteModel(model);
}

onMounted(load);
</script>

<template>
  <main class="page-content enterprise-page model-management-page">
    <div class="enterprise-page-inner">
      <div class="page-heading catalog-page-heading model-management-heading">
        <div class="catalog-heading-copy">
          <span class="catalog-kicker"
            ><span class="catalog-kicker-mark"><Icon name="model" :size="12" /></span>MODEL CONNECTIONS</span
          >
          <h1>模型管理</h1>
          <p>管理聊天模型及其连接状态。</p>
        </div>
        <div class="page-heading-actions">
          <a-button type="primary" @click="openEditor()">
            <template #icon><Icon name="plus" :size="16" /></template>添加模型
          </a-button>
        </div>
      </div>

      <div v-if="loading" class="loading-inline" role="status"><a-spin size="small" />正在读取模型配置…</div>
      <a-alert
        v-else-if="loadError"
        type="error"
        show-icon
        message="模型配置未能读取"
        :description="loadError"
      >
        <template #action><a-button size="small" @click="load">重试</a-button></template>
      </a-alert>
      <CatalogEmpty
        v-else-if="!models.length"
        icon="model"
        title="还没有模型配置"
        description="添加模型后即可在聊天中选择。"
      >
        <a-button type="primary" @click="openEditor()">添加第一个模型</a-button>
      </CatalogEmpty>
      <section v-else class="model-directory" aria-label="模型配置列表">
        <p class="model-directory-summary" aria-live="polite">
          {{ models.length }} 个模型 · {{ enabledCount }} 个已启用<span v-if="attentionCount">
            · {{ attentionCount }} 个待验证或异常</span
          >
        </p>
        <div class="model-card-grid">
          <article
            v-for="model in models"
            :key="model.id"
            :class="['model-management-card', { 'is-disabled': !model.enabled }]"
          >
            <header class="model-card-heading">
              <span class="model-card-icon"><Icon name="model" :size="20" /></span>
              <div class="model-card-copy">
                <h2 :title="model.name">{{ model.name }}</h2>
                <p :title="model.model">{{ model.model }}</p>
              </div>
              <a-tag
                v-if="model.id === app.defaultModelId"
                class="model-default-tag"
                :bordered="false"
                :title="
                  model.isDefault ? '新会话未选择模型时使用' : '未指定默认模型，暂时自动使用最早启用的模型'
                "
              >
                {{ model.isDefault ? '默认' : '默认 · 自动' }}
              </a-tag>
            </header>
            <div class="model-card-meta">
              <span :title="model.baseUrl">{{ endpointHost(model.baseUrl) }}</span>
              <span>上下文 {{ model.contextWindow.toLocaleString() }}</span>
            </div>
            <div class="model-card-health">
              <a-tag
                :color="
                  modelHealth(model).tone === 'normal'
                    ? 'success'
                    : modelHealth(model).tone === 'attention'
                      ? 'error'
                      : modelHealth(model).tone === 'unverified'
                        ? 'warning'
                        : undefined
                "
                :bordered="false"
              >
                {{ modelHealth(model).label }}
              </a-tag>
              <span v-if="model.enabled && model.lastTest?.at" :title="modelHealth(model).description">
                {{ modelHealth(model).description }}
              </span>
            </div>
            <footer class="model-card-footer">
              <label
                class="model-availability"
                :title="model.enabled ? '停用后不再供新会话选择；已有会话仍可继续' : '启用后可在聊天中选择'"
              >
                <a-switch
                  size="small"
                  :checked="model.enabled"
                  :loading="changingAvailabilityId === model.id"
                  :disabled="!model.id || testingId === model.id || deletingId === model.id"
                  :aria-label="`${model.name}：${model.enabled ? '停用' : '启用'}`"
                  @change="toggleAvailability(model)"
                />
                <span>{{ model.enabled ? '已启用' : '已停用' }}</span>
              </label>
              <div class="model-card-actions">
                <a-button
                  type="text"
                  size="small"
                  :loading="testingId === model.id"
                  :disabled="!model.id || changingAvailabilityId === model.id || deletingId === model.id"
                  @click="testModel(model)"
                >
                  <template #icon><Icon name="refresh" :size="14" /></template>测试连接
                </a-button>
                <a-button
                  type="primary"
                  size="small"
                  :disabled="testingId === model.id || deletingId === model.id"
                  @click="openEditor(model)"
                >
                  <template #icon><Icon name="edit" :size="14" /></template>编辑
                </a-button>
                <a-dropdown :trigger="['click']" placement="bottomRight">
                  <a-button
                    type="text"
                    size="small"
                    :aria-label="`更多操作 ${model.name}`"
                    title="更多操作"
                    :disabled="
                      testingId === model.id ||
                      changingAvailabilityId === model.id ||
                      deletingId === model.id ||
                      defaultingId === model.id
                    "
                  >
                    <template #icon><Icon name="more" :size="16" /></template>
                  </a-button>
                  <template #overlay>
                    <a-menu @click="(info: MenuInfo) => modelMenuClick(info, model)">
                      <a-menu-item v-if="model.enabled && !model.isDefault" key="default"
                        >设为默认</a-menu-item
                      >
                      <a-menu-item key="delete" danger>删除</a-menu-item>
                    </a-menu>
                  </template>
                </a-dropdown>
              </div>
            </footer>
          </article>
        </div>
      </section>
    </div>
  </main>

  <a-drawer
    :open="editorOpen"
    :width="520"
    :title="editing ? '编辑模型' : '添加模型'"
    class="model-editor-drawer"
    :closable="!saving"
    :mask-closable="!saving"
    :keyboard="!saving"
    destroy-on-close
    v-bind="drawerA11y(editing ? '编辑模型' : '添加模型', editorOpen)"
    @close="closeEditor"
  >
    <a-form
      id="model-editor-form"
      :model="form"
      :rules="rules"
      layout="vertical"
      class="model-editor-form"
      @finish="save"
    >
      <a-form-item label="模型名称" name="name">
        <a-input v-model:value="form.name" :maxlength="100" placeholder="例如：企业 DeepSeek Chat" />
      </a-form-item>

      <a-form-item label="模型 ID" name="model">
        <a-input v-model:value="form.model" :maxlength="128" placeholder="例如：deepseek-chat" />
      </a-form-item>

      <a-form-item label="Base URL" name="baseUrl" extra="填写 API 根路径，不包含 /chat/completions。">
        <a-input
          v-model:value="form.baseUrl"
          :maxlength="512"
          placeholder="https://your-gateway.example.com/v1"
        />
      </a-form-item>

      <a-form-item label="API Key" name="apiKey">
        <a-input-password
          v-model:value="form.apiKey"
          autocomplete="new-password"
          :placeholder="editing?.apiKeyConfigured ? '留空保留原密钥' : '无鉴权服务可留空'"
        />
        <template #extra>{{
          editing?.apiKeyConfigured ? '留空保留原密钥；填写新值将替换。' : '密钥加密保存在服务端。'
        }}</template>
      </a-form-item>

      <a-form-item label="上下文窗口（tokens）" name="contextWindow">
        <a-input-number
          v-model:value="contextWindowValue"
          :min="4096"
          :max="2000000"
          :controls="false"
          style="width: 100%"
        />
      </a-form-item>
    </a-form>
    <template #footer>
      <div class="model-editor-footer">
        <a-button :disabled="saving" @click="closeEditor">取消</a-button>
        <a-button type="primary" html-type="submit" form="model-editor-form" :loading="saving"
          >保存模型</a-button
        >
      </div>
    </template>
  </a-drawer>
</template>
