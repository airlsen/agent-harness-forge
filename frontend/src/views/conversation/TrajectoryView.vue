<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, downloadResponse } from '../../api/client';
import { usePlatform } from '../../stores/platform';
import type { KernelEvent, SessionDetail } from '../../types/platform';
import Icon from '../../components/base/ForgeIcon.vue';
const app = usePlatform(),
  route = useRoute(),
  detail = ref<SessionDetail | null>(null),
  events = ref<KernelEvent[]>([]),
  source = ref('all'),
  query = ref(''),
  loading = ref(true);
const filtered = computed(() =>
  events.value.filter(
    (e) =>
      (source.value === 'all' || e.source === source.value) &&
      ((e.kind === 'trajectory' ? e.payload.type : e.kind) + JSON.stringify(e.payload))
        .toLowerCase()
        .includes(query.value.toLowerCase()),
  ),
);
async function load() {
  loading.value = true;
  try {
    const data = await api(`/audit/sessions/${route.params.sessionId}/replay`);
    detail.value = data;
    events.value = data.events;
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    loading.value = false;
  }
}
async function exportEvidence() {
  try {
    await downloadResponse(
      `/agent/sessions/${route.params.sessionId}/export`,
      `forge-session-${route.params.sessionId}.json`,
    );
  } catch (error) {
    app.toast((error as Error).message, 'error');
  }
}
onMounted(load);
</script>
<template>
  <main class="page-content trajectory-page">
    <div class="enterprise-page-inner">
      <RouterLink to="/agent/audit" class="back-link"
        ><Icon name="ri-arrow-go-back-fill" :size="15" />返回审计中心</RouterLink
      >
      <div class="page-heading">
        <div>
          <h1>{{ detail?.title ?? '执行轨迹' }}<span class="tag soft">只读</span></h1>
          <p>
            {{ detail?.scenarioName }} · v{{ detail?.scenarioVersion }}<span class="separator">/</span>会话
            #{{ route.params.sessionId }}
          </p>
        </div>
        <button @click="exportEvidence" class="button secondary">
          <Icon name="download" :size="16" />导出会话证据
        </button>
      </div>
      <section v-if="detail" class="snapshot-bar">
        <Icon name="layers" :size="18" />
        <div>
          <span>不可变 Bundle 快照</span><code>{{ detail.bundleHash }}</code>
        </div>
        <span>{{ events.length }} 个事件</span
        ><button class="icon-button" title="刷新轨迹" aria-label="刷新轨迹" @click="load">
          <Icon name="refresh" :size="16" />
        </button>
      </section>
      <section class="settings-card trajectory-card">
        <div class="trajectory-toolbar">
          <div class="collection-tabs">
            <button
              v-for="item in [
                { id: 'all', label: '全部' },
                { id: 'llm', label: '模型' },
                { id: 'tools', label: '工具' },
                { id: 'agent', label: 'Agent' },
                { id: 'system', label: '系统' },
              ]"
              :key="item.id"
              :class="{ selected: source === item.id }"
              @click="source = item.id"
            >
              {{ item.label }}
            </button>
          </div>
          <label class="search-field"
            ><Icon name="search" :size="16" /><input
              v-model="query"
              aria-label="搜索轨迹"
              placeholder="搜索事件类型或载荷"
          /></label>
        </div>
        <div v-if="loading" class="loading-inline"><span class="loader"></span>读取原始事件…</div>
        <div v-else-if="!filtered.length" class="enterprise-empty">
          <span class="enterprise-empty-symbol"
            ><Icon :name="events.length ? 'search' : 'activity'" :size="29"
          /></span>
          <h2>{{ events.length ? '没有匹配的事件' : '这次会话尚未执行任务' }}</h2>
          <p>
            {{
              events.length
                ? '换一个关键词或事件来源，查找其他轨迹。'
                : '任务开始后，模型与工具调用记录会显示在这里。'
            }}
          </p>
        </div>
        <details v-for="event in filtered" :key="event.seq" class="trajectory-event">
          <summary>
            <span class="trajectory-seq">{{ String(event.seq).padStart(3, '0') }}</span><span
              :class="['source-mark', event.source]"
              ><Icon
                :name="
                  event.source === 'tools'
                    ? 'wrench'
                    : event.source === 'llm'
                      ? 'model'
                      : event.source === 'agent'
                        ? 'sparkles'
                        : 'settings'
                "
                :size="15" /></span
            ><code>{{ event.kind === 'trajectory' ? event.payload.type : event.kind }}</code
            ><span class="trajectory-source">{{ event.source }}</span
            ><time>{{ new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false }) }}</time
            ><Icon name="chevron" :size="15" />
          </summary>
          <pre>{{ JSON.stringify(event.payload, null, 2) }}</pre>
        </details>
      </section>
    </div>
  </main>
</template>
