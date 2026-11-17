<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { post, put } from '../../api/client';
import { usePlatform } from '../../stores/platform';
import Icon from '../../components/ForgeIcon.vue';
const app = usePlatform(),
  saving = ref(false),
  testing = ref(false),
  reveal = ref(false),
  formReady = ref(false);
const form = reactive({
  name: '默认模型连接',
  baseUrl: '',
  model: '',
  apiKey: '',
  clearKey: false,
  contextWindow: 64000,
  inputPrice: null as number | null,
  outputPrice: null as number | null,
});
onMounted(async () => {
  try {
    await app.refreshRuntime();
    if (app.connection)
      Object.assign(form, {
        name: app.connection.name || '默认模型连接',
        baseUrl: app.connection.baseUrl,
        model: app.connection.model,
        contextWindow: app.connection.contextWindow,
        inputPrice: app.connection.inputPrice,
        outputPrice: app.connection.outputPrice,
      });
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    formReady.value = true;
  }
});
function preset(name: string) {
  if (name === 'deepseek') {
    form.baseUrl = 'https://api.deepseek.com';
    form.model = 'deepseek-chat';
    form.name = 'DeepSeek API';
  } else if (name === 'openai') {
    form.baseUrl = 'https://api.openai.com/v1';
    form.model = '';
    form.name = 'OpenAI API';
  } else {
    form.baseUrl = '';
    form.model = '';
    form.name = '企业模型网关';
  }
}
async function save() {
  saving.value = true;
  try {
    await put('/models/connection', {
      ...form,
      apiKey: form.apiKey || null,
      inputPrice: form.inputPrice === ('' as any) ? null : form.inputPrice,
      outputPrice: form.outputPrice === ('' as any) ? null : form.outputPrice,
    });
    form.apiKey = '';
    form.clearKey = false;
    await app.refreshRuntime();
    app.toast('模型连接已保存，仅影响新建会话');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    saving.value = false;
  }
}
async function test() {
  testing.value = true;
  try {
    const result = await post('/models/connection/test');
    await app.refreshRuntime();
    app.toast(result.message, result.ok ? 'success' : 'error');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    testing.value = false;
  }
}
</script>
<template>
  <main class="page-content">
    <div class="page-heading">
      <div>
        <div class="eyebrow">MODEL CONNECTION</div>
        <h1>模型连接</h1>
        <p>统一配置平台模型出口，新会话共用连接，无需按账号重复设置。</p>
      </div>
      <span
        :class="[
          'tag',
          app.connection?.lastTest.ok ? 'success' : app.connection?.configured ? 'warm' : 'neutral',
        ]"
        ><span class="dot"></span
        >{{
          app.connection?.lastTest.ok
            ? '连接测试通过'
            : app.connection?.configured
              ? '已配置 · 待测试'
              : '模型未配置'
        }}</span
      >
    </div>
    <div class="settings-layout">
      <section class="settings-card model-form-card">
        <div class="settings-card-heading">
          <span class="scene-icon"><Icon name="cpu" :size="23" /></span>
          <div>
            <h2>默认模型连接</h2>
            <p>新会话的 default 路由使用此连接；已有会话保持原模型与价格快照。</p>
          </div>
          <span class="tag soft">OpenAI Compatible</span>
        </div>
        <div class="provider-presets">
          <button @click="preset('deepseek')"><Icon name="sparkles" :size="16" />DeepSeek</button
          ><button @click="preset('openai')"><Icon name="globe" :size="16" />OpenAI</button
          ><button @click="preset('private')"><Icon name="server" :size="16" />企业 / 私有网关</button>
        </div>
        <form v-if="formReady" id="model-form" @submit.prevent="save">
          <div class="form-grid">
            <div>
              <label for="connection-name">连接名称</label
              ><input
                id="connection-name"
                v-model="form.name"
                maxlength="100"
                placeholder="例如：企业 DeepSeek 网关"
                required
              />
            </div>
            <div>
              <label for="model-id">模型 ID <span class="required">*</span></label
              ><input
                id="model-id"
                v-model="form.model"
                maxlength="128"
                placeholder="填写网关提供的实际模型 ID"
                required
              />
            </div>
          </div>
          <label for="base-url">Base URL <span class="required">*</span></label
          ><input
            id="base-url"
            v-model="form.baseUrl"
            type="url"
            placeholder="https://your-gateway.example.com/v1"
            required
          />
          <p class="field-hint">
            填写 API 根路径，不包含 /chat/completions。支持企业网关、vLLM 和其他兼容服务。
          </p>
          <label for="api-key"
            >API Key
            <span v-if="app.connection?.apiKeyConfigured" class="key-saved"
              ><Icon name="lock" :size="12" />服务端已保存</span
            ></label
          >
          <div class="password-input">
            <input
              id="api-key"
              v-model="form.apiKey"
              :type="reveal ? 'text' : 'password'"
              autocomplete="new-password"
              :placeholder="
                app.connection?.apiKeyConfigured
                  ? '留空保留已存密钥；填写新值可替换'
                  : '输入 API Key，无鉴权的私有网关可留空'
              "
            /><button
              type="button"
              :aria-label="reveal ? '隐藏 API Key' : '显示 API Key'"
              @click="reveal = !reveal"
            >
              <Icon :name="reveal ? 'eyeOff' : 'eye'" :size="18" />
            </button>
          </div>
          <p class="field-hint">密钥仅通过当前同源 API 提交，在服务端加密存储；读取接口不返回原文。</p>
          <label v-if="app.connection?.apiKeyConfigured" class="inline-checkbox"
            ><input
              v-model="form.clearKey"
              type="checkbox"
            />保存时移除当前密钥（仅限无需鉴权的私有服务）</label
          >
          <div class="form-divider"></div>
          <div class="form-grid">
            <div>
              <label for="context-window">上下文窗口（tokens）</label
              ><input
                id="context-window"
                v-model.number="form.contextWindow"
                type="number"
                min="4096"
                max="2000000"
                required
              />
            </div>
            <div class="field-callout">
              <Icon name="info" :size="15" /><span>请以实际服务支持的容量为准，不会自动扩容模型上下文。</span>
            </div>
          </div>
          <details class="advanced-settings">
            <summary>
              计费信息 <span>可选，不填写则不显示费用估算</span><Icon name="chevronDown" :size="15" />
            </summary>
            <div class="form-grid">
              <div>
                <label for="input-price">输入价格（¥ / 百万 tokens）</label
                ><input
                  id="input-price"
                  v-model.number="form.inputPrice"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="未配置"
                />
              </div>
              <div>
                <label for="output-price">输出价格（¥ / 百万 tokens）</label
                ><input
                  id="output-price"
                  v-model.number="form.outputPrice"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="未配置"
                />
              </div>
            </div>
          </details>
          <div class="model-form-actions">
            <span><Icon name="lock" :size="13" />仅管理员可修改模型连接</span
            ><button type="submit" class="button primary" :disabled="saving">
              <span v-if="saving" class="loader small"></span><Icon v-else name="save" :size="16" />保存连接
            </button>
          </div>
        </form>
        <div v-else class="loading-inline"><span class="loader"></span>读取模型配置…</div>
      </section>
      <aside class="settings-aside">
        <section class="settings-card connection-test">
          <div class="settings-section-heading">
            <Icon name="activity" :size="18" />
            <h2>连接测试</h2>
          </div>
          <p>发送一次简短的真实模型请求，检查地址、模型名和凭据是否可用。</p>
          <div
            v-if="app.connection?.lastTest.at"
            :class="['connection-test-result', { ok: app.connection.lastTest.ok }]"
          >
            <Icon :name="app.connection.lastTest.ok ? 'check' : 'info'" :size="19" /><strong>{{
              app.connection.lastTest.ok ? '模型服务已响应' : '连接测试未通过'
            }}</strong>
            <p>{{ app.connection.lastTest.message }}</p>
            <span v-if="app.connection.lastTest.latencyMs"
              >耗时 {{ app.connection.lastTest.latencyMs }} ms</span
            >
          </div>
          <div v-else class="connection-test-idle">
            <Icon name="plug" :size="30" /><span>{{
              app.connection?.configured ? '已保存配置，等待测试' : '先保存你的第一个模型连接'
            }}</span>
          </div>
          <button
            class="button secondary full-width"
            :disabled="testing || !app.connection?.configured"
            @click="test"
          >
            <span v-if="testing" class="loader small"></span><Icon v-else name="bolt" :size="16" />{{
              testing ? '正在请求模型…' : '测试已保存的连接'
            }}</button
          ><small>测试会向所配服务发送少量请求，可能产生 token 费用。</small>
        </section>
        <section class="settings-card model-explanation">
          <Icon name="layers" :size="23" />
          <h3>统一出口，可替换模型</h3>
          <p>
            浏览器不直接调用模型。请求经过控制面与 dsh 插件，再由 Forge Gateway 适配器发送到你配置的服务。
          </p>
          <div class="mini-flow">
            <span>工作台</span><Icon name="arrow" :size="11" /><span>Harness</span
            ><Icon name="arrow" :size="11" /><span>你的模型</span>
          </div>
        </section>
      </aside>
    </div>
  </main>
</template>
