<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { api } from '../../../api/client';
import { usePlatform } from '../../../stores/platform';
import type { PluginDetail, PluginPackage } from '../../../types/plugin';

const route = useRoute();
const app = usePlatform();
const detail = ref<PluginDetail | null>(null);
const loading = ref(false);
const error = ref('');
const busy = ref<number | null>(null);
const testTool = ref<Record<number, string>>({});
const testArgs = ref<Record<number, string>>({});
const testResults = ref<Record<number, string>>({});
const current = computed(() => detail.value?.releases.find((item) => item.isDefault));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    detail.value = await api<PluginDetail>(
      `/registry/plugins/${encodeURIComponent(String(route.params.id))}`,
    );
    for (const release of detail.value.releases) {
      testTool.value[release.id] ??= release.tools.find((tool) => tool.permission === 'read')?.name ?? '';
      testArgs.value[release.id] ??= '{}';
    }
  } catch (reason) {
    error.value = (reason as Error).message;
  } finally {
    loading.value = false;
  }
}
async function action(release: PluginPackage, path: string, body?: object) {
  busy.value = release.id;
  try {
    await api(`/registry/plugins/${release.id}/${path}`, {
      method: 'POST',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    await load();
    app.toast(path === 'default' ? '默认版本已切换；已有场景继续使用其已发布版本。' : '操作已完成');
  } catch (reason) {
    app.toast((reason as Error).message, 'error');
  } finally {
    busy.value = null;
  }
}
async function toggle(release: PluginPackage) {
  busy.value = release.id;
  try {
    await api(`/registry/plugins/${release.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !release.enabled }),
    });
    await load();
    app.toast(release.enabled ? '版本已停用，新会话将无法使用。' : '版本已启用，请按需设为默认。');
  } catch (reason) {
    app.toast((reason as Error).message, 'error');
  } finally {
    busy.value = null;
  }
}
async function test(release: PluginPackage) {
  let args: unknown;
  try {
    args = JSON.parse(testArgs.value[release.id] ?? '{}');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是 JSON 对象');
  } catch (reason) {
    testResults.value[release.id] = `参数无效：${(reason as Error).message}`;
    return;
  }
  busy.value = release.id;
  testResults.value[release.id] = '正在调用 Worker…';
  try {
    const result = await api<{ result: unknown }>(`/registry/plugins/${release.id}/test`, {
      method: 'POST',
      body: JSON.stringify({ tool: testTool.value[release.id], arguments: args }),
    });
    testResults.value[release.id] = JSON.stringify(result.result, null, 2);
    await load();
  } catch (reason) {
    testResults.value[release.id] = `试运行失败：${(reason as Error).message}`;
    await load();
  } finally {
    busy.value = null;
  }
}
watch(() => route.params.id, load, { immediate: true });
</script>

<template>
  <main class="plugin-detail-page">
    <RouterLink class="plugin-back" to="/agent/capabilities?tab=plugins">← 插件管理</RouterLink>
    <a-spin v-if="loading && !detail" />
    <a-alert v-else-if="error" type="error" :message="error" show-icon />
    <template v-if="detail">
      <header class="plugin-heading">
        <div>
          <small>受管业务插件 · {{ detail.id }}</small>
          <h1>{{ current?.displayName ?? detail.releases[0]?.displayName }}</h1>
          <p>{{ current?.description ?? detail.releases[0]?.description }}</p>
        </div>
        <a-tag :color="current ? 'success' : 'warning'">{{
          current ? `默认 v${current.version}` : '未设置默认版本'
        }}</a-tag>
      </header>

      <section class="plugin-section">
        <h2>
          版本 <small>{{ detail.releases.length }} 个</small>
        </h2>
        <article v-for="release in detail.releases" :key="release.id" class="plugin-release">
          <div class="plugin-release-head">
            <div>
              <strong>v{{ release.version }}</strong>
              <a-tag v-if="release.isDefault" color="success">默认</a-tag>
              <a-tag :color="release.auditStatus === 'approved' ? 'success' : 'warning'">{{
                release.auditStatus === 'approved'
                  ? release.enabled
                    ? '已启用'
                    : '已停用'
                  : release.auditStatus === 'pending'
                    ? '待审核'
                    : '已拒绝'
              }}</a-tag>
              <span class="muted">{{
                release.runtime === 'forge-remote-worker-v1' ? '远程 Worker' : '平台组件'
              }}</span>
            </div>
            <div class="plugin-actions">
              <a-button
                v-if="release.auditStatus === 'approved' && release.source.startsWith('uploaded:')"
                size="small"
                :loading="busy === release.id"
                @click="toggle(release)"
                >{{ release.enabled ? '停用' : '启用' }}</a-button
              >
              <a-button
                v-if="release.auditStatus === 'pending' && release.lastTestedAt"
                size="small"
                :loading="busy === release.id"
                @click="action(release, 'review', { action: 'approved' })"
                >批准</a-button
              >
              <a-button
                v-if="release.auditStatus === 'approved' && release.enabled && !release.isDefault"
                size="small"
                type="primary"
                :loading="busy === release.id"
                @click="action(release, 'default')"
                >设为默认</a-button
              >
            </div>
          </div>
          <p class="plugin-meta">
            {{ release.execution.endpoint ?? release.source }} · {{ release.tools.length }} 项工具 · SHA
            {{ release.artifactHash.slice(0, 12) }}
          </p>
          <p v-if="release.execution.authRef" class="plugin-meta">
            服务认证：{{ release.execution.authRef }}（仅在 Worker 进程读取）
          </p>
          <p v-if="release.lastTestError" class="plugin-error">最近试运行失败：{{ release.lastTestError }}</p>
          <p v-else-if="release.lastTestedAt" class="plugin-meta">
            试运行成功：{{ new Date(release.lastTestedAt).toLocaleString('zh-CN') }}
          </p>
          <div class="plugin-tools">
            <span v-for="tool in release.tools" :key="tool.name" :title="tool.description"
              >{{ tool.title }} <small>{{ tool.permission === 'read' ? '只读' : '需审批' }}</small></span
            >
          </div>
          <div v-if="release.runtime === 'forge-remote-worker-v1'" class="plugin-test">
            <label :for="`plugin-tool-${release.id}`">只读工具试运行</label>
            <div class="plugin-test-row">
              <a-select
                :id="`plugin-tool-${release.id}`"
                v-model:value="testTool[release.id]"
                class="plugin-tool-select"
                :options="
                  release.tools
                    .filter((tool) => tool.permission === 'read')
                    .map((tool) => ({ value: tool.name, label: tool.title }))
                "
              />
              <a-button
                :disabled="!testTool[release.id]"
                :loading="busy === release.id"
                @click="test(release)"
                >试运行</a-button
              >
            </div>
            <a-textarea
              v-model:value="testArgs[release.id]"
              :rows="2"
              aria-label="试运行 JSON 参数"
              spellcheck="false"
            />
            <pre v-if="testResults[release.id]" class="plugin-result">{{ testResults[release.id] }}</pre>
          </div>
        </article>
      </section>
      <section class="plugin-section">
        <h2>
          场景引用 <small>{{ detail.scenarios.length }} 个</small>
        </h2>
        <p v-if="!detail.scenarios.length" class="muted">暂无场景引用此插件。</p>
        <div v-for="scenario in detail.scenarios" :key="scenario.id" class="plugin-scenario">
          <RouterLink to="/agent/scenarios">{{ scenario.name }}</RouterLink>
          <span>v{{ scenario.version }} · {{ scenario.status === 'published' ? '已发布' : '草稿' }}</span>
        </div>
      </section>
      <section class="plugin-section">
        <h2>
          最近调用 <small>{{ detail.recentCalls.length }} 条</small>
        </h2>
        <p v-if="!detail.recentCalls.length" class="muted">暂无调用记录。</p>
        <div v-for="(call, index) in detail.recentCalls" :key="index" class="plugin-scenario">
          <span>{{ call.tool }} · v{{ call.version }}</span>
          <span :class="call.outcome === 'failed' ? 'plugin-error' : 'muted'"
            >{{ call.outcome === 'succeeded' ? '成功' : '失败' }} · {{ call.elapsedMs }} ms · 会话 #{{
              call.sessionId
            }}</span
          >
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.plugin-detail-page {
  max-width: 1060px;
  margin: 0 auto;
  padding: 36px 44px 80px;
  color: var(--color-text-primary);
}
.plugin-back {
  color: var(--color-text-secondary);
}
.plugin-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin: 32px 0 42px;
}
.plugin-heading small {
  color: var(--color-brand-active);
  letter-spacing: 0.12em;
}
.plugin-heading h1 {
  margin: 10px 0;
  font-size: 30px;
}
.plugin-heading p,
.muted,
.plugin-meta {
  color: var(--color-text-secondary);
}
.plugin-section {
  margin-top: 30px;
}
.plugin-section h2 {
  font-size: 20px;
  margin-bottom: 18px;
}
.plugin-section h2 small {
  margin-left: 8px;
  font-size: 14px;
  font-weight: 400;
  color: var(--color-text-secondary);
}
.plugin-release {
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 22px 24px;
  margin: 14px 0;
  background: var(--surface-card);
}
.plugin-release-head,
.plugin-actions,
.plugin-test-row,
.plugin-scenario {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.plugin-release-head strong {
  margin-right: 10px;
  font-size: 18px;
}
.plugin-meta {
  margin: 14px 0 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.plugin-tools {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
}
.plugin-tools > span {
  border-radius: 6px;
  background: var(--surface-muted);
  padding: 6px 10px;
  font-size: 13px;
}
.plugin-tools small {
  margin-left: 6px;
  color: var(--color-text-secondary);
}
.plugin-test {
  margin-top: 20px;
  display: grid;
  gap: 8px;
  max-width: 600px;
}
.plugin-test label {
  font-weight: 600;
}
.plugin-tool-select {
  flex: 1;
}
.plugin-result {
  padding: 12px;
  background: var(--surface-muted);
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
}
.plugin-error {
  color: var(--color-danger-text);
}
.plugin-scenario {
  padding: 12px 0;
  border-bottom: 1px solid var(--border-default);
}
@media (max-width: 700px) {
  .plugin-detail-page {
    padding: 20px;
  }
  .plugin-heading {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
