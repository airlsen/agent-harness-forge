<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { usePlatform } from '../../stores/platform';
import { useConversation } from '../../stores/conversation';
import { remove } from '../../api/client';
import { formatDate, sessionMatches, sessionState } from '../../utils/presentation';
import type { Conversation } from '../../types/platform';
import Icon from '../../components/ForgeIcon.vue';
import CatalogSearch from '../../components/catalog/CatalogSearch.vue';

const app = usePlatform();
const chat = useConversation();
const router = useRouter();
const query = ref('');
const filter = ref('all');
const refreshing = ref(false);
const error = ref('');
const archiveTarget = ref<Conversation | null>(null);
const archiving = ref(false);
const columns = [
  { title: '会话 / 场景', key: 'conversation', width: '48%' },
  { title: '状态', key: 'status', width: '16%' },
  { title: '创建时间', key: 'createdAt', width: '21%' },
  { title: '操作', key: 'actions', width: '15%' },
];
const filtered = computed(() =>
  app.regularConversations.filter(
    (item) =>
      sessionMatches(item, query.value) &&
      (filter.value === 'all' ||
        (filter.value === 'attention'
          ? ['error', 'interrupted'].includes(item.status)
          : item.status === filter.value)),
  ),
);
const filters = computed(() => [
  { id: 'all', label: '全部', count: app.regularConversations.length },
  {
    id: 'running',
    label: '执行中',
    count: app.regularConversations.filter((s) => s.status === 'running').length,
  },
  { id: 'idle', label: '可继续', count: app.regularConversations.filter((s) => s.status === 'idle').length },
  {
    id: 'attention',
    label: '异常 / 中止',
    count: app.regularConversations.filter((s) => ['error', 'interrupted'].includes(s.status)).length,
  },
]);
async function refresh() {
  refreshing.value = true;
  error.value = '';
  try {
    await app.refreshSessions();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    refreshing.value = false;
  }
}
function newChat() {
  if (chat.requestNewConversation()) void router.push('/agent/chat');
}
async function archive() {
  if (!archiveTarget.value || archiving.value) return;
  archiving.value = true;
  try {
    const id = archiveTarget.value.id;
    await remove(`/agent/sessions/${id}`);
    if (chat.current?.id === id) chat.prepareStart();
    archiveTarget.value = null;
    await app.refreshSessions();
    app.toast('会话已归档，历史消息与审计记录仍保留');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    archiving.value = false;
  }
}
onMounted(refresh);
</script>
<template>
  <main class="page-content enterprise-page conversations-page">
    <div class="enterprise-page-inner">
      <div class="page-heading">
        <div>
          <h1>我的会话</h1>
          <p>找回上下文、查看结果，或继续推进一项工作。</p>
        </div>
      </div>
      <a-tabs v-model:active-key="filter" class="conversations-tabs" aria-label="会话状态筛选">
        <a-tab-pane v-for="item in filters" :key="item.id">
          <template #tab
            >{{ item.label }} <span class="conversations-tab-count">{{ item.count }}</span></template
          >
        </a-tab-pane>
      </a-tabs>
      <div class="conversations-toolbar">
        <span class="conversations-results" aria-live="polite">共 {{ filtered.length }} 个会话</span>
        <div class="conversations-search-actions">
          <CatalogSearch v-model:value="query" placeholder="搜索标题或场景" aria-label="搜索会话" />
          <a-button
            class="conversations-refresh"
            :disabled="refreshing"
            aria-label="刷新会话"
            @click="refresh"
          >
            <Icon name="refresh" :size="16" :class="{ spinning: refreshing }" />刷新
          </a-button>
          <a-button type="primary" class="conversations-new" @click="newChat">
            <Icon name="plus" :size="16" />新建会话
          </a-button>
        </div>
      </div>
      <a-alert v-if="error" type="error" show-icon message="未能读取会话" :description="error" role="alert">
        <template #action><a-button size="small" @click="refresh">重试</a-button></template>
      </a-alert>
      <div v-if="refreshing && !app.regularConversations.length" class="loading-inline" role="status">
        <span class="loader"></span>正在读取会话…
      </div>
      <div v-else-if="!filtered.length && !error" class="conversation-empty">
        <a-empty :description="query || filter !== 'all' ? '没有匹配的会话' : '还没有会话'" />
        <a-button
          v-if="query || filter !== 'all'"
          @click="
            query = '';
            filter = 'all';
          "
          >清除筛选</a-button
        >
        <a-button v-else type="primary" @click="newChat">开始会话</a-button>
      </div>
      <a-table
        v-else-if="filtered.length"
        class="conversation-table"
        :columns="columns"
        :data-source="filtered"
        :row-key="(item: Conversation) => item.id"
        :scroll="{ x: 680 }"
        :pagination="{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }"
      >
        <template #bodyCell="{ column, record: item }">
          <RouterLink
            v-if="column.key === 'conversation'"
            :to="`/agent/chat/${item.id}`"
            class="conversation-table-title"
            ><span class="conversation-table-icon"
              ><Icon
                :name="app.scenarios.find((s) => s.id === item.scenarioId)?.payload.icon ?? 'message'"
                :size="21"
            /></span>
            <div>
              <h2>{{ item.title }}</h2>
              <small>{{ item.scenarioName }}<i>·</i>v{{ item.scenarioVersion }}</small>
            </div></RouterLink
          >
          <a-tooltip
            v-else-if="column.key === 'status'"
            :title="item.status === 'idle' ? '本轮已结束，可以继续对话；不代表业务任务已完成' : undefined"
          >
            <span :class="['session-state', sessionState(item.status).tone]"
              ><span></span>{{ sessionState(item.status).label }}</span
            >
          </a-tooltip>
          <time v-else-if="column.key === 'createdAt'" :datetime="item.createdAt">{{
            formatDate(item.createdAt, true)
          }}</time>
          <div v-else-if="column.key === 'actions'" class="conversation-table-actions">
            <a-button
              type="text"
              :disabled="item.status === 'running'"
              :aria-label="`归档会话 ${item.title}`"
              :title="item.status === 'running' ? '请先中止执行再归档' : '归档会话'"
              @click="archiveTarget = item as Conversation"
            >
              <Icon name="archive" :size="16" />
            </a-button>
          </div>
        </template>
      </a-table>
    </div>
    <a-modal
      :open="!!archiveTarget"
      title="归档会话"
      :closable="!archiving"
      :mask-closable="!archiving"
      :keyboard="!archiving"
      @cancel="archiveTarget = null"
    >
      <p>归档「{{ archiveTarget?.title }}」？归档后会话不再显示在最近记录中，暂不支持恢复。</p>
      <template #footer>
        <a-button :disabled="archiving" @click="archiveTarget = null">取消</a-button>
        <a-button type="primary" :loading="archiving" @click="archive">确认归档</a-button>
      </template>
    </a-modal>
  </main>
</template>
