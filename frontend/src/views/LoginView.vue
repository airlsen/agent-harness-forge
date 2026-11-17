<script setup lang="ts">
import { ref } from 'vue';
import { usePlatform } from '../stores/platform';
import Icon from '../components/ForgeIcon.vue';
const app = usePlatform(),
  username = ref('admin'),
  password = ref(''),
  busy = ref(false),
  error = ref(''),
  reveal = ref(false);
async function login() {
  busy.value = true;
  error.value = '';
  try {
    await app.login(username.value, password.value);
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
        <h1>让智能，<br />真正参与工作。</h1>
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
      <form class="login-form" @submit.prevent="login">
        <span class="tag soft">FORGE ENTERPRISE</span>
        <h2>欢迎回来</h2>
        <p>登录企业智能体平台，开始推进工作。</p>
        <div v-if="error" class="form-alert error" role="alert">
          <Icon name="info" :size="17" />{{ error }}
        </div>
        <label for="username">账号</label
        ><input
          id="username"
          v-model="username"
          autocomplete="username"
          required
          placeholder="输入平台账号"
        /><label for="password">密码</label>
        <div class="password-input">
          <input
            id="password"
            v-model="password"
            :type="reveal ? 'text' : 'password'"
            autocomplete="current-password"
            required
            placeholder="输入管理员密码"
          /><button type="button" :aria-label="reveal ? '隐藏密码' : '显示密码'" @click="reveal = !reveal">
            <Icon :name="reveal ? 'eyeOff' : 'eye'" :size="18" />
          </button>
        </div>
        <button type="submit" class="button primary large" :disabled="busy">
          <span v-if="busy" class="loader small"></span>{{ busy ? '正在登录' : '进入企业平台'
          }}<Icon v-if="!busy" name="arrow" :size="17" />
        </button>
        <div class="login-security">
          <Icon name="lock" :size="14" /><span>{{
            app.previewHeaderAuth ? 'Cookie 优先 · 支持预览兼容会话' : '单管理员认证 · HttpOnly 会话保护'
          }}</span>
        </div>
        <div class="login-footnote">
          当前为单管理员业务预览，尚未接入员工身份与会话权限。<br />真实模型请在登录后进入「平台管理 →
          模型连接」配置。
        </div>
      </form>
      <span class="login-version">AgentHarness Forge · 企业版前端预览</span>
    </section>
  </div>
</template>
