<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { usePlatform } from '../../stores/platform';
import { useConversation } from '../../stores/conversation';
import { remove } from '../../api/client';
import { formatDate, sessionMatches, sessionState } from '../../utils/presentation';
import type { Conversation } from '../../types/platform';
import Icon from '../../components/ForgeIcon.vue';
import DialogShell from '../../components/DialogShell.vue';

const app = usePlatform();
const chat = useConversation();
const router = useRouter();
const query = ref('');
const filter = ref('all');
const refreshing = ref(false);
const error = ref('');
const archiveTarget = ref<Conversation | null>(null);
const archiving = ref(false);
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
        <button class="button primary" @click="newChat"><Icon name="plus" :size="17" />新建会话</button>
      </div>
      <div class="preview-inline-note">
        <Icon name="info" :size="15" /><span
          >当前显示管理员账号的会话；员工身份与跨用户访问隔离尚未接入。</span
        >
      </div>
      <div class="collection-toolbar enterprise-collection-toolbar">
        <div class="collection-tabs" aria-label="会话状态筛选">
          <button
            v-for="item in filters"
            :key="item.id"
            :class="{ selected: filter === item.id }"
            :aria-pressed="filter === item.id"
            @click="filter = item.id"
          >
            {{ item.label }}<span>{{ item.count }}</span>
          </button>
        </div>
        <div class="collection-search-actions">
          <label class="search-field"
            ><Icon name="search" :size="17" /><input
              v-model="query"
              placeholder="搜索标题或场景"
              aria-label="搜索会话" /></label
          ><button
            class="icon-button"
            :disabled="refreshing"
            aria-label="刷新会话"
            title="刷新会话"
            @click="refresh"
          >
            <Icon name="refresh" :size="17" :class="{ spinning: refreshing }" />
          </button>
        </div>
      </div>
      <div v-if="error" class="form-alert error" role="alert">
        <Icon name="info" :size="18" />
        <div>
          <strong>未能读取会话</strong>
          <p>{{ error }}</p>
        </div>
        <button class="button secondary small" @click="refresh">重试</button>
      </div>
      <div v-if="refreshing && !app.regularConversations.length" class="loading-inline" role="status">
        <span class="loader"></span>正在读取会话…
      </div>
      <div v-else-if="!filtered.length && !error" class="enterprise-empty conversation-empty">
        <span class="enterprise-empty-symbol"
          ><Icon :name="query || filter !== 'all' ? 'search' : 'message'" :size="29"
        /></span>
        <h2>{{ query || filter !== 'all' ? '没有匹配的会话' : '新的工作，从第一次对话开始。' }}</h2>
        <p>
          {{
            query || filter !== 'all'
              ? '换一个关键词，或查看全部状态。'
              : '使用企业场景开始工作，对话、执行过程和文件会保留在会话中。'
          }}
        </p>
        <button
          v-if="query || filter !== 'all'"
          class="button secondary"
          @click="
            query = '';
            filter = 'all';
          "
        >
          清除筛选</button
        ><button v-else class="button primary" @click="newChat">
          开始会话 <Icon name="arrow" :size="16" />
        </button>
      </div>
      <div v-else-if="filtered.length" class="conversation-table">
        <div class="conversation-table-head">
          <span>会话 / 场景</span><span>状态</span><span>创建时间</span><span>操作</span>
        </div>
        <article v-for="item in filtered" :key="item.id" class="conversation-table-row">
          <RouterLink :to="`/agent/chat/${item.id}`" class="conversation-table-title"
            ><span class="conversation-table-icon"
              ><Icon
                :name="app.scenarios.find((s) => s.id === item.scenarioId)?.payload.icon ?? 'message'"
                :size="21"
            /></span>
            <div>
              <h2>{{ item.title }}</h2>
              <small>{{ item.scenarioName }}<i>·</i>v{{ item.scenarioVersion }}</small>
            </div></RouterLink
          ><span :class="['session-state', sessionState(item.status).tone]"
            ><span></span>{{ sessionState(item.status).label }}</span
          ><time :datetime="item.createdAt">{{ formatDate(item.createdAt, true) }}</time>
          <div class="conversation-table-actions">
            <RouterLink :to="`/agent/chat/${item.id}`" class="conversation-open"
              >打开 <Icon name="arrow" :size="14" /></RouterLink
            ><button
              class="icon-button"
              :disabled="item.status === 'running'"
              :aria-label="`归档会话 ${item.title}`"
              :title="item.status === 'running' ? '请先中止执行再归档' : '归档会话'"
              @click="archiveTarget = item"
            >
              <Icon name="archive" :size="16" />
            </button>
          </div>
        </article>
      </div>
      <div class="page-note">
        <Icon name="info" :size="14" /><span
          >“可继续”表示本轮结束，不代表业务任务已经完成。搜索与筛选作用于接口返回的最近会话（最多 150
          条），不含试运行记录。</span
        >
      </div>
    </div>
    <DialogShell
      v-if="archiveTarget"
      variant="modal"
      label="归档会话确认"
      panel-class="confirm-modal"
      @close="!archiving && (archiveTarget = null)"
      ><span class="confirm-icon"><Icon name="archive" :size="25" /></span>
      <h2>归档「{{ archiveTarget.title }}」？</h2>
      <p>会话将从最近记录中移出，消息、文件与审计记录仍保留。当前不提供取消归档操作。</p>
      <footer>
        <button class="button secondary" :disabled="archiving" @click="archiveTarget = null">取消</button
        ><button class="button primary" :disabled="archiving" @click="archive">
          <span v-if="archiving" class="loader small"></span>确认归档
        </button>
      </footer></DialogShell
    >
  </main>
</template>
