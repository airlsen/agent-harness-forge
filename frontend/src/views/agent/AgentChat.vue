<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlatform } from '../../stores/platform';
import { useConversation } from '../../stores/conversation';
import { api, downloadResponse } from '../../api/client';
import { formatBytes, sessionState } from '../../utils/presentation';
import { trapTabKey } from '../../utils/focus';
import type { KernelEvent } from '../../types/platform';
import { buildTurns, type ToolCallView, type Turn } from '../../utils/turns';
import Icon from '../../components/ForgeIcon.vue';
import Markdown from '../../components/MarkdownContent.vue';
import ToolCallGroup from '../../components/ToolCallGroup.vue';
import TaskComposer from '../../components/TaskComposer.vue';
import ConversationStart from '../../components/ConversationStart.vue';
import DialogShell from '../../components/DialogShell.vue';

const app = usePlatform();
const chat = useConversation();
const route = useRoute();
const router = useRouter();
const messagesPane = ref<HTMLElement | null>(null);
const panelNode = ref<HTMLElement | null>(null);
const panelMedia = window.matchMedia('(max-width: 1280px)');
const overlayPanel = ref(panelMedia.matches);
let previousPanelFocus: HTMLElement | null = null;
function resizePanel() {
  overlayPanel.value = panelMedia.matches;
}
watch(
  () => chat.panelOpen && overlayPanel.value,
  async (open) => {
    if (open) {
      previousPanelFocus = document.activeElement as HTMLElement;
      await nextTick();
      panelNode.value?.focus();
    } else if (previousPanelFocus?.isConnected) {
      await nextTick();
      previousPanelFocus.focus();
    }
  },
);
function panelKeyboard(event: KeyboardEvent) {
  if (
    !chat.panelOpen ||
    (document.activeElement as HTMLElement)?.closest('.modal-backdrop, .drawer-backdrop')
  )
    return;
  if (event.key === 'Escape') chat.panelOpen = false;
  if (overlayPanel.value) trapTabKey(event, panelNode.value);
}
onMounted(() => {
  panelMedia.addEventListener('change', resizePanel);
  window.addEventListener('keydown', panelKeyboard);
});
const previewFile = ref<{ path: string; content: string } | null>(null);
const fileLoading = ref('');
const fileError = ref('');
let fileRequest = 0;
watch(
  () => chat.panelOpen,
  (open) => {
    if (!open) {
      ++fileRequest;
      fileLoading.value = '';
    }
  },
);
const approvalBusy = ref<number | null>(null);
const loadError = ref('');
const stickToBottom = ref(true);
const selected = computed(
  () => app.scenarios.find((s) => s.id === chat.selectedScenarioId) ?? app.availableScenarios[0],
);
const sceneIcon = computed(
  () => chat.current?.bundle?.meta?.scenarioIcon ?? selected.value?.payload.icon ?? 'sparkles',
);
const sceneDescription = computed(
  () => chat.current?.bundle?.meta?.scenarioDescription ?? selected.value?.payload.description ?? '',
);
const selectedTools = computed(() =>
  app.tools.filter((t) =>
    (
      chat.current?.bundle?.meta?.builtin_tools ??
      selected.value?.payload.capabilities.builtin_tool_names ??
      []
    ).includes(t.name),
  ),
);
const welcome = computed(() => !chat.messages.length && !loadError.value);
const processEvents = computed(() =>
  chat.events.filter((e) =>
    ['tool_use_start', 'tool_result', 'approval_required', 'approval_resolved', 'error', 'message'].includes(
      e.kind,
    ),
  ),
);
const rawEvents = computed(() => chat.events.filter((e) => e.kind === 'trajectory'));
const lastAnswer = computed(() =>
  [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim()),
);
const pendingTools = computed<ToolCallView[]>(() =>
  !chat.running
    ? []
    : chat.events
        .filter(
          (e) =>
            e.kind === 'tool_use_start' &&
            !chat.events.some(
              (r) => r.kind === 'tool_result' && r.payload.toolCallId === e.payload.toolCallId,
            ),
        )
        .map((e) => ({
          id: String(e.payload.toolCallId),
          tool: e.payload.tool,
          arguments: e.payload.arguments,
          pending: true,
        })),
);
const turns = computed(() =>
  buildTurns(chat.messages, {
    running: chat.running,
    reasoning: chat.liveReasoning,
    text: chat.liveText,
    activeTools: pendingTools.value,
  }),
);
function turnIdle(turn: Turn) {
  const last = turn.steps.at(-1);
  return (
    !last ||
    !(
      (last.kind === 'thinking' && last.live) ||
      (last.kind === 'text' && last.live) ||
      (last.kind === 'tools' && last.calls.some((call) => call.pending))
    )
  );
}
const status = computed(() =>
  chat.approvals.length
    ? { label: '等待确认', tone: 'warning', icon: 'shield' }
    : sessionState(chat.current?.status ?? 'idle'),
);
let routeGeneration = 0;
async function loadSession(value: unknown) {
  const generation = ++routeGeneration;
  loadError.value = '';
  previewFile.value = null;
  ++fileRequest;
  fileLoading.value = '';
  fileError.value = '';
  stickToBottom.value = true;
  if (value && (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)))) {
    chat.prepareStart();
    loadError.value = '会话地址无效，请从会话列表重新打开。';
    return;
  }
  try {
    if (value && Number(value) !== chat.current?.id) await chat.open(Number(value));
    else if (value && chat.current?.status === 'running')
      chat.follow(Number(value), chat.events.at(-1)?.seq ?? 0);
    else if (!value) chat.prepareStart();
    if (generation === routeGeneration) await scrollToBottom();
  } catch (error) {
    if (generation === routeGeneration) loadError.value = (error as Error).message;
  }
}
watch(() => route.params.sessionId, loadSession, { immediate: true });
// The start composer disappears as soon as the first turn is accepted. Keep
// routing in this persistent parent so unmounting it cannot swallow the receipt.
watch(
  () => (chat.messages.some((message) => message.role === 'user') ? chat.current?.id : null),
  (id) => {
    if (id && !route.params.sessionId) void router.replace(`/agent/chat/${id}`);
  },
);
watch(
  () => chat.liveText + chat.liveReasoning + chat.messages.length + chat.events.length,
  async () => {
    if (stickToBottom.value) await scrollToBottom();
  },
);
onBeforeUnmount(() => {
  ++routeGeneration;
  ++fileRequest;
  chat.disconnect();
  panelMedia.removeEventListener('change', resizePanel);
  window.removeEventListener('keydown', panelKeyboard);
});
async function scrollToBottom() {
  await nextTick();
  const pane = messagesPane.value;
  if (pane) pane.scrollTop = pane.scrollHeight;
}
function trackScroll() {
  const pane = messagesPane.value;
  if (pane) stickToBottom.value = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
}
function showPanel(panel: 'files' | 'trajectory' | 'context') {
  chat.panelOpen = chat.panel !== panel || !chat.panelOpen;
  chat.panel = panel;
}
function toolTitle(name: string) {
  return app.tools.find((t) => t.name === name)?.title ?? name;
}
function formatArgs(value: unknown) {
  try {
    return typeof value === 'string'
      ? JSON.stringify(JSON.parse(value), null, 2)
      : (JSON.stringify(value, null, 2) ?? '—');
  } catch {
    return String(value);
  }
}
function eventText(event: KernelEvent) {
  const tool = toolTitle(event.payload.tool ?? '工具');
  if (event.kind === 'tool_use_start') return `调用${tool}`;
  if (event.kind === 'tool_result') return `${tool} · ${event.payload.isError ? '未成功' : '执行完成'}`;
  if (event.kind === 'approval_required') return `${tool} · 等待确认`;
  if (event.kind === 'approval_resolved')
    return `操作确认 · ${event.payload.action === 'approve' ? '已批准' : '已处理'}`;
  if (event.kind === 'error') return '执行出现异常';
  return event.payload.partial ? '保留了部分输出' : '收到一条回复';
}
async function openFile(path: string) {
  if (!chat.current || fileLoading.value) return;
  const id = chat.current.id;
  const request = ++fileRequest;
  fileLoading.value = path;
  fileError.value = '';
  try {
    const data = await api<{ content: string }>(
      `/agent/sessions/${id}/file?path=${encodeURIComponent(path)}`,
    );
    if (request === fileRequest && chat.current?.id === id)
      previewFile.value = { path, content: data.content };
  } catch (error) {
    if (request === fileRequest) fileError.value = (error as Error).message;
  } finally {
    if (request === fileRequest) fileLoading.value = '';
  }
}
async function exportSession() {
  if (!chat.current) return;
  try {
    await downloadResponse(
      `/agent/sessions/${chat.current.id}/export`,
      `forge-session-${chat.current.id}.json`,
    );
  } catch (error) {
    app.toast((error as Error).message, 'error');
  }
}
function downloadFile() {
  if (!previewFile.value) return;
  const url = URL.createObjectURL(
    new Blob([previewFile.value.content], { type: 'text/plain;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = previewFile.value.path.split('/').at(-1) ?? 'artifact.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function decide(id: number, action: 'approve' | 'deny') {
  approvalBusy.value = id;
  try {
    await chat.resolveApproval(id, action);
    app.toast(action === 'approve' ? '已批准本次操作' : '已拒绝本次操作');
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    approvalBusy.value = null;
  }
}
async function copyMessage(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    app.toast('已复制到剪贴板');
  } catch {
    app.toast('剪贴板访问被浏览器拒绝，请手动选择内容复制', 'info');
  }
}
</script>
<template>
  <div :class="['chat-layout', 'enterprise-chat', { 'has-detail-panel': chat.panelOpen }]">
    <section class="chat-primary" :inert="chat.panelOpen && overlayPanel">
      <div class="chat-subbar">
        <div class="chat-title">
          <span class="session-icon"><Icon :name="sceneIcon" :size="18" /></span
          ><strong>{{ chat.current?.title ?? (loadError ? '会话读取失败' : '新会话') }}</strong
          ><span v-if="chat.current" :class="['session-state', status.tone]"
            ><span></span>{{ status.label }}</span
          >
        </div>
        <div class="chat-subbar-actions">
          <button
            :class="['session-panel-button', { selected: chat.panelOpen && chat.panel === 'files' }]"
            :aria-expanded="chat.panelOpen && chat.panel === 'files'"
            aria-label="查看结果"
            @click="showPanel('files')"
          >
            <Icon name="folder" :size="16" /><span>结果</span
            ><small v-if="chat.files.length">{{ chat.files.length }}</small></button
          ><button
            :class="['session-panel-button', { selected: chat.panelOpen && chat.panel === 'trajectory' }]"
            :aria-expanded="chat.panelOpen && chat.panel === 'trajectory'"
            aria-label="查看过程"
            @click="showPanel('trajectory')"
          >
            <Icon name="activity" :size="16" /><span>过程</span></button
          ><button
            v-if="chat.current"
            class="icon-button"
            title="导出会话与轨迹"
            aria-label="导出会话"
            @click="exportSession"
          >
            <Icon name="download" :size="17" />
          </button>
        </div>
      </div>
      <div
        ref="messagesPane"
        :class="['chat-scroll', { 'is-welcome': welcome && !chat.loading }]"
        @scroll="trackScroll"
      >
        <div v-if="chat.loading" class="loading-inline" role="status">
          <span class="loader"></span>正在读取会话…
        </div>
        <div v-else-if="loadError" class="enterprise-empty session-load-error" role="alert">
          <span class="enterprise-empty-symbol"><Icon name="info" :size="29" /></span>
          <h2>暂时无法打开这个会话</h2>
          <p>{{ loadError }}</p>
          <div>
            <button class="button secondary" @click="loadSession(route.params.sessionId)">重新读取</button
            ><RouterLink class="button primary" to="/agent/conversations">返回会话列表</RouterLink>
          </div>
        </div>
        <ConversationStart v-else-if="welcome" @submitted="(id) => router.replace(`/agent/chat/${id}`)" />
        <div v-else class="conversation-messages">
          <article v-for="turn in turns" :key="turn.key" class="turn-block">
            <div v-if="turn.user" class="message-row user">
              <div class="user-message-text">{{ turn.user.content }}</div>
            </div>
            <div class="message-row assistant">
              <span class="message-avatar agent"><Icon name="sparkles" :size="18" /></span>
              <div class="message-main">
                <div class="message-author">Agent<span v-if="turn.running">正在工作</span></div>
                <template v-for="(step, index) in turn.steps" :key="index">
                  <section v-if="step.kind === 'thinking'" class="step-thinking">
                    <template v-if="step.live">
                      <div class="step-label live">
                        <Icon name="think" :size="13" />正在思考<span class="thinking-dots"
                          ><i></i><i></i><i></i
                        ></span>
                      </div>
                      <div class="step-thinking-text">{{ step.text }}</div>
                    </template>
                    <details v-else class="thinking-done">
                      <summary class="step-label">
                        <Icon name="think" :size="13" />已思考<Icon
                          name="chevron"
                          :size="12"
                          class="step-chevron"
                        />
                      </summary>
                      <div class="step-thinking-text">{{ step.text }}</div>
                    </details>
                  </section>
                  <ToolCallGroup v-else-if="step.kind === 'tools'" :calls="step.calls" />
                  <section v-else class="step-text">
                    <Markdown :text="step.text" /><span v-if="step.live" class="stream-cursor"></span>
                    <div v-if="!step.live" class="step-actions">
                      <span v-if="step.partial" class="message-partial">执行未完成时保留的部分输出</span
                      ><button
                        class="message-copy"
                        aria-label="复制回复"
                        title="复制内容"
                        @click="copyMessage(step.text)"
                      >
                        <Icon name="copy" :size="13" />复制
                      </button>
                    </div>
                  </section>
                </template>
                <div v-if="turn.running && turnIdle(turn)" class="agent-working compact" role="status">
                  <span class="thinking-dots"><i></i><i></i><i></i></span
                  ><span>{{ turn.steps.length ? '正在继续…' : '正在处理这项工作' }}</span>
                </div>
                <div v-if="!turn.running && !turn.steps.length" class="turn-empty">（本轮没有输出）</div>
              </div>
            </div>
          </article>
          <div v-if="chat.runError" class="form-alert error" role="alert">
            <Icon name="info" :size="18" />
            <div>
              <strong>这次执行未完成</strong>
              <p>{{ chat.runError }}</p>
            </div>
          </div>
          <div v-if="chat.connectionWarning" class="form-alert" role="status">
            <Icon name="info" :size="16" />{{ chat.connectionWarning }}
          </div>
          <button
            v-if="chat.files.length && !chat.running"
            class="session-result-receipt"
            @click="
              chat.panel = 'files';
              chat.panelOpen = true;
            "
          >
            <span><Icon name="folder" :size="20" /></span>
            <div>
              <strong>{{ chat.files.length }} 个文件可查看</strong><small>当前会话实际生成的文本文件</small>
            </div>
            <span class="receipt-action">查看结果 <Icon name="arrow" :size="15" /></span>
          </button>
        </div>
      </div>
      <div v-if="!loadError && !welcome && !chat.loading" class="composer-area enterprise-composer-area">
        <button
          v-if="!stickToBottom && !welcome"
          class="jump-to-latest"
          @click="
            stickToBottom = true;
            scrollToBottom();
          "
        >
          <Icon name="arrowDown" :size="14" />回到最新
        </button>
        <div
          v-for="approval in chat.approvals"
          :key="approval.ticketId"
          class="approval-card"
          role="region"
          aria-label="操作确认"
        >
          <div class="approval-heading">
            <span class="approval-symbol"><Icon name="shield" :size="20" /></span>
            <div>
              <strong>这一步，需要你的确认</strong>
              <p>{{ approval.reason ?? '此操作会修改当前会话中的文件' }}</p>
            </div>
            <span class="tag warning">待确认</span>
          </div>
          <details>
            <summary>{{ toolTitle(approval.tool) }} <Icon name="chevron" :size="14" /></summary>
            <pre>{{ formatArgs(approval.arguments) }}</pre>
          </details>
          <div class="approval-actions">
            <small>仅限本次调用，超时默认拒绝。</small
            ><button
              class="button secondary"
              :disabled="approvalBusy !== null"
              @click="decide(approval.ticketId, 'deny')"
            >
              拒绝</button
            ><button
              class="button primary"
              :disabled="approvalBusy !== null"
              @click="decide(approval.ticketId, 'approve')"
            >
              <span v-if="approvalBusy === approval.ticketId" class="loader small"></span
              ><Icon v-else name="check" :size="14" />允许本次
            </button>
          </div>
        </div>
        <TaskComposer
          @submitted="(id) => router.replace(`/agent/chat/${id}`)"
          @capabilities="showPanel('context')"
        />
      </div>
    </section>
    <button
      v-if="chat.panelOpen"
      class="session-panel-backdrop"
      aria-label="关闭详情侧栏"
      @click="chat.panelOpen = false"
    ></button>
    <aside
      v-if="chat.panelOpen"
      ref="panelNode"
      class="context-panel enterprise-session-panel"
      aria-label="会话详情"
      :role="overlayPanel ? 'dialog' : undefined"
      :aria-modal="overlayPanel ? true : undefined"
      tabindex="-1"
    >
      <div class="context-tabs">
        <button :class="{ selected: chat.panel === 'files' }" @click="chat.panel = 'files'">
          结果<span v-if="chat.files.length">{{ chat.files.length }}</span></button
        ><button :class="{ selected: chat.panel === 'trajectory' }" @click="chat.panel = 'trajectory'">
          过程</button
        ><button :class="{ selected: chat.panel === 'context' }" @click="chat.panel = 'context'">能力</button
        ><button
          class="icon-button close-session-panel"
          aria-label="关闭会话详情"
          @click="chat.panelOpen = false"
        >
          <Icon name="close" :size="18" />
        </button>
      </div>
      <div v-if="chat.panel === 'context'" class="context-content">
        <div class="panel-eyebrow">CAPABILITIES IN THIS CONVERSATION</div>
        <span :class="['context-scene-icon', selected?.payload.icon]"
          ><Icon :name="sceneIcon" :size="24"
        /></span>
        <h2>{{ chat.current?.scenarioName ?? selected?.payload.name ?? '选择场景' }}</h2>
        <p>{{ sceneDescription }}</p>
        <div class="context-meta">
          <span>{{
            chat.current ? '已锁定本次引用' : selected?.status === 'draft' ? '维护草稿预览' : '引用平台场景'
          }}</span><span v-if="chat.current">v{{ chat.current.scenarioVersion }}</span>
        </div>
        <div class="context-section">
          <h3>
            授权工具 <span>{{ selectedTools.length }}</span>
          </h3>
          <p v-if="!selectedTools.length" class="small-text muted-text">本场景为纯对话，不调用工具。</p>
          <div v-for="tool in selectedTools" :key="tool.name" class="context-tool">
            <span><Icon :name="tool.icon" :size="16" /></span>
            <div>
              <strong>{{ tool.title }}</strong><small>{{
                tool.permission === 'approval' ? '写入 · 受策略门控' : '只读操作'
              }}</small>
            </div>
            <Icon :name="tool.permission === 'approval' ? 'shield' : 'check'" :size="13" />
          </div>
        </div>
        <div class="context-section">
          <h3>本次执行边界</h3>
          <ul class="boundary-list">
            <li><Icon name="check" :size="12" />文件访问限定当前会话目录</li>
            <li><Icon name="check" :size="12" />工具范围由场景与策略共同限制</li>
            <li><Icon name="check" :size="12" />消息与执行事件持久化记录</li>
            <li><Icon name="lock" :size="12" />不开放任意 Shell 命令</li>
          </ul>
        </div>
        <div class="context-section">
          <h3>模型连接</h3>
          <p class="small-text muted-text">
            {{ chat.current?.model || app.connection?.model || '尚未配置' }}
          </p>
          <p v-if="chat.current" class="small-text muted-text">
            累计 {{ (chat.current.tokensIn + chat.current.tokensOut).toLocaleString() }} tokens ·
            {{ chat.current.cost === null ? '费用未配置' : `¥${chat.current.cost.toFixed(4)}` }}
          </p>
        </div>
        <details v-if="chat.current" class="technical-detail">
          <summary>引用快照标识</summary>
          <code>{{ chat.current.bundleHash }}</code>
        </details>
        <div v-else class="context-tip">
          <Icon name="info" :size="15" />
          <p>提交后会记录场景、模型与策略快照，后续维护不会静默改变已有会话。</p>
        </div>
      </div>
      <div v-else-if="chat.panel === 'trajectory'" class="panel-scroll">
        <div class="panel-description">
          查看本次实际执行的关键步骤。<RouterLink
            v-if="chat.current"
            :to="`/agent/trajectory/${chat.current.id}`"
            >完整轨迹 <Icon name="arrow" :size="12"
          /></RouterLink>
        </div>
        <div v-if="!processEvents.length" class="panel-empty">
          <Icon name="activity" :size="29" /><strong>过程会在执行时出现</strong>
          <p>工具调用、确认与异常会按实际发生顺序记录。</p>
        </div>
        <ol v-else class="session-process-list">
          <li
            v-for="event in processEvents.slice(-100)"
            :key="event.seq"
            :class="{ 'process-error': event.kind === 'error' || event.payload.isError }"
          >
            <span class="process-event-icon"
              ><Icon
                :name="
                  event.kind === 'error'
                    ? 'info'
                    : event.kind.startsWith('approval')
                      ? 'shield'
                      : event.kind === 'message'
                        ? 'message'
                        : 'wrench'
                "
                :size="14"
            /></span>
            <details>
              <summary>
                <strong>{{ eventText(event) }}</strong><small>#{{ event.seq }}</small>
              </summary>
              <pre>{{ formatArgs(event.payload) }}</pre>
            </details>
          </li>
        </ol>
        <div v-if="processEvents.length > 100" class="panel-description">
          仅显示最近 100 项，完整记录请打开完整轨迹。
        </div>
        <div v-if="rawEvents.length" class="panel-description">
          已记录 {{ rawEvents.length }} 条底层轨迹事件，可在完整轨迹中检查。
        </div>
      </div>
      <div v-else class="panel-scroll">
        <div class="panel-description">实际生成的内容与文件，不自动发布到公共目录。</div>
        <div v-if="fileLoading" class="file-loading-state" role="status">
          <span class="loader small"></span>正在读取 {{ fileLoading }}…
        </div>
        <div v-if="fileError" class="form-alert error" role="alert">
          <Icon name="info" :size="16" />{{ fileError }}，可重新点击文件重试。
        </div>
        <h3 v-if="chat.files.length" class="result-section-title">
          文件 <span>{{ chat.files.length }}</span>
        </h3>
        <button
          v-for="file in chat.files"
          :key="file.path"
          class="artifact-file"
          :disabled="Boolean(fileLoading)"
          @click="openFile(file.path)"
        >
          <span class="file-icon"><Icon name="file" :size="19" /></span>
          <div>
            <strong>{{ file.path }}</strong><small>{{ formatBytes(file.bytes) }} · 文本文件</small>
          </div>
          <Icon name="arrow" :size="14" />
        </button>
        <div v-if="lastAnswer" class="latest-answer">
          <div class="latest-answer-heading">
            <h3>最近回复</h3>
            <button class="icon-button" aria-label="复制最近回复" @click="copyMessage(lastAnswer.content)">
              <Icon name="copy" :size="14" />
            </button>
          </div>
          <span v-if="lastAnswer.meta.partial" class="tag warning">部分输出 · 执行未完成</span
          ><Markdown :text="lastAnswer.content" />
        </div>
        <div v-if="!chat.files.length && !lastAnswer" class="panel-empty">
          <Icon name="folder" :size="31" /><strong>结果会留在这里</strong>
          <p>执行后的回复与实际生成文件，可以随时回来查看。</p>
        </div>
      </div>
    </aside>
    <DialogShell
      v-if="previewFile"
      variant="modal"
      label="产物预览"
      panel-class="file-preview"
      @close="previewFile = null"
      ><header>
        <div>
          <h2>{{ previewFile.path }}</h2>
          <p>当前会话 · 文本文件</p>
        </div>
        <button class="icon-button" aria-label="关闭产物" @click="previewFile = null">
          <Icon name="close" :size="20" />
        </button>
      </header>
      <pre>{{ previewFile.content }}</pre>
      <footer>
        <button class="button secondary" @click="downloadFile">
          <Icon name="download" :size="16" />下载文件</button
        ><button class="button primary" @click="previewFile = null">完成</button>
      </footer></DialogShell
    >
  </div>
</template>
