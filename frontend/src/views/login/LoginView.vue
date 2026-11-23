<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import type { Rule } from 'ant-design-vue/es/form';
import { usePlatform } from '../../stores/platform';
import { useSpace } from '../../stores/space';
import Icon from '../../components/base/ForgeIcon.vue';

const app = usePlatform();
const form = reactive({ username: '', password: '' });
const registration = reactive({ username: '', display_name: '', email: '', password: '', confirm: '' });
const mode = ref<'login' | 'register'>('login');
const busy = ref(false);
const error = ref('');
const notice = ref('');

// antd 表单校验规则：账号与密码均必填，提交时给出字段级错误提示。
const rules: Record<string, Rule[]> = {
  username: [{ required: true, whitespace: true, message: '请输入平台账号' }],
  password: [{ required: true, message: '请输入管理员密码' }],
};
const registrationRules: Record<string, Rule[]> = {
  username: [
    { required: true, message: '请输入账号' },
    { pattern: /^[A-Za-z][A-Za-z0-9_.-]{2,39}$/, message: '3–40 位字母、数字、下划线、点或横线，以字母开头' },
  ],
  email: [{ required: true, type: 'email', message: '请输入有效邮箱' }],
  password: [{ required: true, min: 12, message: '密码至少 12 位' }],
  confirm: [
    {
      validator: async (_rule, value) => {
        if (value !== registration.password) throw new Error('两次密码不一致');
      },
    },
  ],
};

function switchMode(value: 'login' | 'register') {
  mode.value = value;
  error.value = '';
  notice.value = '';
}

async function register() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await app.register({
      username: registration.username,
      email: registration.email,
      password: registration.password,
      display_name: registration.display_name,
    });
    form.username = registration.username;
    form.password = '';
    registration.password = '';
    registration.confirm = '';
    mode.value = 'login';
    notice.value = result.verificationRequired
      ? '注册成功，请前往邮箱完成验证，再登录。'
      : '注册成功，请使用新账号登录。';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('verify');
  if (!token) return;
  url.searchParams.delete('verify');
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  busy.value = true;
  try {
    await app.verifyEmail(token);
    notice.value = '邮箱验证成功，现在可以登录。';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
});

async function login() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await app.login(form.username, form.password);
    // 读取空间列表；记住的空间已被删除时回到公共空间
    await useSpace()
      .load()
      .catch(() => {});
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="login-layout">
    <section class="login-story">
      <a href="/" class="brand"
        ><span class="forge-symbol"><i></i><i></i><i></i><i></i></span
        ><span>forge<span class="brand-period">.</span></span></a
      >
      <div class="login-intro">
        <span class="eyebrow">SHARED CAPABILITIES. REAL WORK.</span>
        <h1><span class="login-headline-accent">让智能，</span><br />真正参与工作。</h1>
        <p>从一个想法，到一次可追溯的执行。<br />企业统一提供能力，让 Agent 成为工作的助力。</p>
        <div class="login-illustration">
          <div class="illustration-orbit orbit-one"></div>
          <div class="illustration-orbit orbit-two"></div>
          <span class="illustration-center"><Icon name="sparkles" :size="36" /></span
          ><span class="illustration-node node-code"><Icon name="code" :size="22" /><span>研发</span></span
          ><span class="illustration-node node-file"><Icon name="file" :size="22" /><span>文档</span></span
          ><span class="illustration-node node-shield"
            ><Icon name="shield" :size="22" /><span>治理</span></span
          ><span class="illustration-node node-chart"><Icon name="chart" :size="22" /><span>洞察</span></span>
        </div>
      </div>
      <div class="login-story-footer">
        POWERED BY DEEPSEEK HARNESS <span>MODEL AGNOSTIC · PLUGIN FIRST</span>
      </div>
    </section>
    <section class="login-form-area">
      <a-form
        v-if="mode === 'login'"
        class="login-form"
        :model="form"
        :rules="rules"
        layout="vertical"
        @finish="login"
      >
        <span class="tag soft">FORGE ENTERPRISE</span>
        <h2>欢迎回来</h2>
        <p>登录企业智能体平台，开始推进工作。</p>
        <div v-if="error" class="form-alert error" role="alert">
          <Icon name="info" :size="17" />{{ error }}
        </div>
        <div v-if="notice" class="form-alert" role="status">{{ notice }}</div>
        <a-form-item label="账号" name="username">
          <a-input
            v-model:value="form.username"
            autocomplete="username"
            size="large"
            placeholder="输入平台账号"
          />
        </a-form-item>
        <a-form-item label="密码" name="password">
          <a-input-password
            v-model:value="form.password"
            autocomplete="current-password"
            size="large"
            placeholder="输入密码"
          />
        </a-form-item>
        <button type="submit" class="button primary large" :disabled="busy">
          <span v-if="busy" class="loader small"></span>{{ busy ? '登录中…' : '登录' }}
        </button>
        <button
          v-if="app.registrationAvailable"
          type="button"
          class="button secondary large"
          @click="switchMode('register')"
        >
          注册账号
        </button>
        <div class="login-security">
          <Icon name="lock" :size="14" /><span>{{
            app.previewHeaderAuth ? 'Cookie 优先 · 支持预览兼容会话' : 'HttpOnly 会话保护'
          }}</span>
        </div>
        <div class="login-footnote">当前账号可独立登录；会话和空间的数据隔离将在下一阶段接入。</div>
      </a-form>
      <a-form
        v-else
        class="login-form"
        :model="registration"
        :rules="registrationRules"
        layout="vertical"
        @finish="register"
      >
        <span class="tag soft">FORGE ENTERPRISE</span>
        <h2>创建账号</h2>
        <p>注册后即可使用企业智能体平台。</p>
        <div v-if="error" class="form-alert error" role="alert">
          <Icon name="info" :size="17" />{{ error }}
        </div>
        <a-form-item label="账号" name="username"
          ><a-input
            v-model:value="registration.username"
            autocomplete="username"
            size="large"
            placeholder="3–40 位，以字母开头"
        /></a-form-item>
        <a-form-item label="显示名称" name="display_name"
          ><a-input v-model:value="registration.display_name" size="large" placeholder="选填"
        /></a-form-item>
        <a-form-item label="邮箱" name="email"
          ><a-input
            v-model:value="registration.email"
            autocomplete="email"
            size="large"
            placeholder="用于账号验证"
        /></a-form-item>
        <a-form-item label="密码" name="password"
          ><a-input-password
            v-model:value="registration.password"
            autocomplete="new-password"
            size="large"
            placeholder="至少 12 位"
        /></a-form-item>
        <a-form-item label="确认密码" name="confirm"
          ><a-input-password
            v-model:value="registration.confirm"
            autocomplete="new-password"
            size="large"
            placeholder="再次输入密码"
        /></a-form-item>
        <button type="submit" class="button primary large" :disabled="busy">
          <span v-if="busy" class="loader small"></span>{{ busy ? '注册中…' : '注册' }}
        </button>
        <button type="button" class="button secondary large" :disabled="busy" @click="switchMode('login')">
          返回登录
        </button>
        <div class="login-footnote">注册账号暂时共用平台内容；后续会按用户隔离会话和文件。</div>
      </a-form>
      <span class="login-version">AgentHarness Forge · 企业版前端预览</span>
    </section>
  </div>
</template>
