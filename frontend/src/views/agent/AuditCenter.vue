<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client';
import { usePlatform } from '../../stores/platform';
import type { Conversation } from '../../types/platform';
import Icon from '../../components/ForgeIcon.vue';
const app = usePlatform(),
  rows = ref<Conversation[]>([]),
  query = ref(''),
  filter = ref('all'),
  loading = ref(true);
const visible = computed(() =>
  rows.value.filter(
    (r) =>
      (filter.value === 'all' || r.status === filter.value) &&
      (r.title + r.scenarioName + r.id).toLowerCase().includes(query.value.toLowerCase()),
  ),
);
const tokens = computed(() => rows.value.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0));
async function load() {
  loading.value = true;
  try {
    rows.value = (await api('/audit/sessions')).items;
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    loading.value = false;
  }
}
onMounted(load);
function status(value: string) {
  return (
    (
      {
        idle: '可继续',
        running: '执行中',
        error: '执行异常',
        interrupted: '已中断',
        archived: '已归档',
      } as Record<string, string>
    )[value] ?? value
  );
}
</script>
<template>
  <main class="page-content enterprise-page">
    <div class="enterprise-page-inner">
      <div class="page-heading">
        <div>
          <h1>运行审计</h1>
          <p>从场景版本到工具结果，查看当前部署内实际发生的任务与事件。</p>
        </div>
        <button class="button secondary" :disabled="loading" @click="load">
          <Icon name="refresh" :size="16" />刷新记录
        </button>
      </div>
      <div class="audit-metrics">
        <article>
          <span>会话记录</span><strong>{{ rows.length }}<small>个</small></strong>
          <p>包含真实场景试运行</p>
        </article>
        <article>
          <span>模型用量</span><strong>{{ tokens.toLocaleString() }}<small>tokens</small></strong>
          <p>来自模型返回的 usage</p>
        </article>
        <article>
          <span>执行异常</span
          ><strong>{{ rows.filter((r) => r.status === 'error').length }}<small>个会话</small></strong>
          <p>失败也会保留事件记录</p>
        </article>
      </div>
      <section class="settings-card audit-table-card">
        <div class="audit-toolbar">
          <label class="search-field"
            ><Icon name="search" :size="17" /><input
              v-model="query"
              aria-label="搜索审计记录"
              placeholder="搜索会话、场景或 ID" /></label
          ><select v-model="filter" aria-label="筛选会话状态">
            <option value="all">全部状态</option>
            <option value="idle">可继续</option>
            <option value="running">执行中</option>
            <option value="error">执行异常</option>
            <option value="archived">已归档</option>
          </select>
        </div>
        <div v-if="loading" class="loading-inline"><span class="loader"></span>读取审计记录…</div>
        <div v-else-if="!visible.length" class="enterprise-empty">
          <span class="enterprise-empty-symbol"
            ><Icon :name="query ? 'search' : 'activity'" :size="29"
          /></span>
          <h2>{{ query ? '没有匹配的记录' : '真实工作，从第一项任务开始' }}</h2>
          <p>
            {{
              query
                ? '换一个关键词或状态，查找其他记录。'
                : '执行任务后，消息、工具调用与运行轨迹会显示在这里。'
            }}
          </p>
          <RouterLink v-if="!query" to="/agent/workbench" class="button primary"
            >前往工作台<Icon name="arrow" :size="14"
          /></RouterLink>
        </div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>会话</th>
                <th>场景版本</th>
                <th>状态</th>
                <th>Tokens</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in visible" :key="row.id">
                <td>
                  <strong>{{ row.title }}</strong><small
                    >#{{ row.id }}<span v-if="row.isTest"> · 场景试运行</span></small
                  >
                </td>
                <td>
                  {{ row.scenarioName }}<span class="tag neutral">v{{ row.scenarioVersion }}</span>
                </td>
                <td>
                  <span :class="['status-label', row.status]"
                    ><span class="dot"></span>{{ status(row.status) }}</span
                  >
                </td>
                <td class="mono">{{ (row.tokensIn + row.tokensOut).toLocaleString() }}</td>
                <td>{{ new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false }) }}</td>
                <td>
                  <RouterLink :to="`/agent/trajectory/${row.id}`" class="text-link"
                    >查看轨迹<Icon name="arrow" :size="13"
                  /></RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <div class="page-note">
        <Icon name="lock" :size="14" />当前审计数据保存在本地数据库，尚未配置生产级 WORM/S3 留存或企业 SIEM
        对接。
      </div>
    </div>
  </main>
</template>
