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
        <span class="eyebrow">YOUR AGENTS. YOUR WORKSPACE.</span>
        <h1>让智能，<br />真正参与工作。</h1>
        <p>从一个想法，到一次可追溯的执行。<br />连接模型、装配能力，让 Agent 成为你的工作伙伴。</p>
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
        <span class="tag soft">FORGE WORKSPACE</span>
        <h2>欢迎回来</h2>
        <p>登录你的 Agent 工作空间。</p>
        <div v-if="error" class="form-alert error" role="alert">
          <Icon name="info" :size="17" />{{ error }}
        </div>
        <label for="username">账号</label
        ><input
          id="username"
          v-model="username"
          autocomplete="username"
          required
          placeholder="输入工作空间账号"
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
          <span v-if="busy" class="loader small"></span>{{ busy ? '正在登录' : '进入工作空间'
          }}<Icon v-if="!busy" name="arrow" :size="17" />
        </button>
        <div class="login-security">
          <Icon name="lock" :size="14" /><span>本地工作空间认证 · HttpOnly 会话保护</span>
        </div>
        <div class="login-footnote">
          当前为单工作空间开发部署。<br />真实模型请在登录后进入「模型中心」配置。
        </div>
      </form>
      <span class="login-version">AgentHarness Forge · v0.2</span>
    </section>
  </div>
</template>
