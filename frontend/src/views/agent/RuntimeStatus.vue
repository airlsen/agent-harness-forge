<script setup lang="ts">
import { computed, ref } from 'vue';
import { usePlatform } from '../../stores/platform';
import Icon from '../../components/ForgeIcon.vue';

const app = usePlatform();
const refreshing = ref(false);
const runnerOnline = computed(() => app.runtime?.runner.status === 'online');
const capacity = computed(() => app.runtime?.runner.capacity ?? 0);
const activeSessions = computed(() => app.runtime?.runner.sessions ?? 0);
const capacityLabel = computed(() => {
  if (!capacity.value) return '容量未知';
  return `${activeSessions.value} / ${capacity.value} 执行中`;
});
const capacityPercent = computed(() => {
  if (!capacity.value) return 0;
  return Math.min(100, Math.round((activeSessions.value / capacity.value) * 100));
});

async function refresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await app.refreshRuntime();
    app.toast('运行状态已刷新', 'success');
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <main class="page-content enterprise-page runtime-status-page">
    <div class="enterprise-page-inner">
      <div class="page-heading">
        <div>
          <h1>运行状态</h1>
          <p>查看当前部署的控制面、执行服务与存储状态；这里只呈现真实运行信息和部署边界。</p>
        </div>
        <button class="button secondary" :disabled="refreshing" @click="refresh">
          <span v-if="refreshing" class="loader small"></span><Icon v-else name="refresh" :size="16" />{{
            refreshing ? '正在刷新…' : '刷新状态'
          }}
        </button>
      </div>

      <section class="runtime-status-hero">
        <div>
          <span :class="['runtime-health-mark', { online: runnerOnline }]"
            ><Icon :name="runnerOnline ? 'check' : 'info'" :size="17"
          /></span>
          <div>
            <span class="runtime-status-kicker">执行服务</span>
            <h2>{{ runnerOnline ? 'Forge Runner 正在运行' : 'Forge Runner 当前不可用' }}</h2>
            <p>
              {{
                runnerOnline
                  ? '控制面可将已授权的新任务提交至当前执行服务。'
                  : '新任务可能无法启动；请检查执行服务和当前部署日志。'
              }}
            </p>
          </div>
        </div>
        <div class="runtime-capacity">
          <strong>{{ activeSessions }}</strong><span>活动会话</span>
          <div class="runtime-capacity-track" aria-label="执行容量">
            <i :style="{ width: `${capacityPercent}%` }"></i>
          </div>
          <small>{{ capacityLabel }}</small>
        </div>
      </section>

      <div class="runtime-status-grid">
        <section class="runtime-status-card">
          <header>
            <Icon name="server" :size="19" />
            <div>
              <h2>运行链路</h2>
              <p>当前工作负载依赖的核心服务。</p>
            </div>
          </header>
          <dl>
            <div>
              <dt>控制面</dt>
              <dd>{{ app.runtime?.controlPlane || '正在读取' }}</dd>
            </div>
            <div>
              <dt>执行内核</dt>
              <dd>
                {{ runnerOnline ? '在线' : '离线或不可达' }}
                <span :class="['runtime-dot', { offline: !runnerOnline }]"></span>
              </dd>
            </div>
            <div>
              <dt>Harness</dt>
              <dd>{{ app.runtime?.runner.dshVersion || '未报告版本' }}</dd>
            </div>
            <div>
              <dt>Node.js</dt>
              <dd>{{ app.runtime?.runner.node || '未报告版本' }}</dd>
            </div>
            <div>
              <dt>持久化存储</dt>
              <dd>{{ app.runtime?.storage || '正在读取' }}</dd>
            </div>
            <div>
              <dt>认证方式</dt>
              <dd>{{ app.runtime?.authMode || '正在读取' }}</dd>
            </div>
          </dl>
        </section>

        <section class="runtime-status-card runtime-model-status">
          <header>
            <Icon name="cpu" :size="19" />
            <div>
              <h2>默认模型连接</h2>
              <p>新会话使用的统一模型出口。</p>
            </div>
          </header>
          <div class="runtime-model-connection">
            <span
              :class="[
                'tag',
                app.connection?.lastTest.ok ? 'success' : app.connection?.configured ? 'warm' : 'neutral',
              ]"
            >
              {{
                app.connection?.lastTest.ok
                  ? '最近测试通过'
                  : app.connection?.configured
                    ? '已配置 · 待测试'
                    : '尚未配置'
              }}
            </span>
            <h3>{{ app.connection?.name || '默认模型连接' }}</h3>
            <p>{{ app.connection?.model || '尚未设置模型 ID' }}</p>
            <small v-if="app.connection?.lastTest.at">{{ app.connection.lastTest.message }}</small>
          </div>
          <RouterLink to="/agent/models" class="text-link"
            >配置模型连接 <Icon name="arrow" :size="14"
          /></RouterLink>
        </section>
      </div>

      <section class="runtime-boundaries">
        <header>
          <Icon name="info" :size="18" />
          <div>
            <h2>当前部署边界</h2>
            <p>这些说明描述当前环境的真实能力与未接入项，不构成生产级保证。</p>
          </div>
        </header>
        <ul v-if="app.runtime?.limitations?.length">
          <li v-for="limit in app.runtime.limitations" :key="limit">{{ limit }}</li>
        </ul>
        <p v-else class="runtime-boundary-empty">正在读取部署说明…</p>
      </section>
    </div>
  </main>
</template>
