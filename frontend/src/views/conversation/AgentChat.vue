<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlatform } from '../../stores/platform';
import { useConversation } from '../../stores/conversation';
import { useSpace } from '../../stores/space';
import { downloadResponse } from '../../api/client';
import { formatBytes, sessionState } from '../../utils/presentation';
import { trapTabKey } from '../../utils/focus';
import { confirm } from '../../utils/feedback';
import { animateComposerArrival, captureComposerOrigin } from '../../utils/composerTransition';
import type { KernelEvent } from '../../types/platform';
import { useStickToBottom } from '../../utils/useStickToBottom';
import { buildTurns, latestUnavailable, type ToolCallView, type Turn } from '../../utils/turns';
import { missingSkillInfo } from '../../utils/skillLifecycle';
import Icon from '../../components/base/ForgeIcon.vue';
import Markdown from '../../components/markdown/MarkdownContent.vue';
import ProcessBlock from '../../components/message/ProcessBlock.vue';
import UserMessageText from '../../components/message/UserMessageText.vue';
import TaskComposer from '../../components/composer/TaskComposer.vue';
import ConversationStart from '../../components/composer/ConversationStart.vue';
import FileCard from '../../components/file/FileCard.vue';
import FilePreview from '../../components/file/FilePreview.vue';
import FileTree from '../../components/file/FileTree.vue';
import FileDiff from '../../components/file/FileDiff.vue';
import TurnChanges from '../../components/message/TurnChanges.vue';
import {
  builtinToolTitle,
  archiveUrl,
  fileName,
  previewable,
  rawFileUrl,
  withListing,
  type Deliverable,
  type FileChange,
  type FileRef,
} from '../../utils/files';

const app = usePlatform();
const chat = useConversation();
const space = useSpace();
const route = useRoute();
const router = useRouter();
const messagesPane = ref<HTMLElement | null>(null);
const composer = ref<InstanceType<typeof TaskComposer> | null>(null);
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
/** 正在预览的会话文件（预览弹窗自行读取原始字节） */
const previewFile = ref<FileRef | null>(null);
/** 正在下载的文件路径，用于按钮的加载态 */
const downloading = ref('');
/** 正在删除的文件路径 */
const deleting = ref('');
/** 正在打包下载的目录（'' 表示全部文件），null 表示空闲 */
const archiving = ref<string | null>(null);
/** 正在查看对比的改动记录 */
const diffChange = ref<FileChange | null>(null);
const approvalBusy = ref<number | null>(null);
const loadError = ref('');
// 跟随最新：只有用户自己往上翻才停止；内容高度变化时自动贴底
const {
  stick: stickToBottom,
  onScroll: trackScroll,
  jumpToLatest,
  scrollToBottom: pinToBottom,
} = useStickToBottom(messagesPane);
const selected = computed(
  () => app.scenarios.find((s) => s.id === chat.selectedScenarioId) ?? app.availableScenarios[0],
);
const sceneIcon = computed(
  () => chat.current?.bundle?.meta?.scenarioIcon ?? selected.value?.payload.icon ?? 'sparkles',
);
const sceneDescription = computed(
  () => chat.current?.bundle?.meta?.scenarioDescription ?? selected.value?.payload.description ?? '',
);
// Runner 为每个会话补齐基础能力（时间、文件列表/读取/写入），平台策略 allowedTools 仍是上限
const BASE_TOOLS = ['current_time', 'workspace_list', 'workspace_read', 'workspace_write'];
const selectedTools = computed(() => {
  const declared =
    chat.current?.bundle?.meta?.builtin_tools ??
    selected.value?.payload.capabilities.builtin_tool_names ??
    [];
  const ceiling = chat.current?.bundle?.meta?.policy?.allowedTools;
  const names = new Set(
    [...BASE_TOOLS, ...declared].filter((name) => !Array.isArray(ceiling) || ceiling.includes(name)),
  );
  return app.tools.filter((t) => names.has(t.name));
});
const welcome = computed(() => !chat.messages.length && !chat.outgoing && !loadError.value);
const processEvents = computed(() =>
  chat.events.filter((e) =>
    [
      'model_switched',
      'workspace_changes',
      'tool_use_start',
      'tool_result',
      'approval_required',
      'approval_resolved',
      'error',
      'message',
    ].includes(e.kind),
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
/** 已发出、尚未受理的消息在对话中的临时编号（受理后换成服务端记录） */
const OUTGOING_ID = 'outgoing';
const turns = computed(() =>
  buildTurns(
    chat.outgoing
      ? [...chat.messages, { id: OUTGOING_ID, role: 'user', content: chat.outgoing.content, meta: {} }]
      : chat.messages,
    {
      running: chat.running,
      reasoning: chat.liveReasoning,
      text: chat.liveText,
      activeTools: pendingTools.value,
    },
  ),
);
const isOutgoing = (turn: Turn) => turn.key === OUTGOING_ID;
const sendFailed = (turn: Turn) => isOutgoing(turn) && Boolean(chat.outgoing?.failed);
/** 最近一轮实际未生效的扩展能力：在「能力」面板逐项标记，并在面板按钮上提示数量 */
const lastUnavailable = computed(() =>
  chat.current ? latestUnavailable(turns.value.filter((turn) => !isOutgoing(turn))) : [],
);
function skippedItem(kind: 'skill' | 'mcp' | 'web', id: number | null = null) {
  return lastUnavailable.value.find((item) => item.kind === kind && (kind === 'web' || item.id === id));
}
function skippedLastTurn(kind: 'skill' | 'mcp' | 'web', id: number | null = null) {
  return Boolean(skippedItem(kind, id));
}
/** 右侧面板展示的关联代码：附带代码根目录中读到的分支与提交 */
const linkedCode = computed(() =>
  (chat.current ? chat.appliedCodeProjects : chat.codeProjects).map((name) => {
    const project = chat.codeProjectList?.projects.find((item) => item.name === name);
    const version =
      project?.branch && project.commit
        ? `${project.branch} @ ${project.commit.slice(0, 7)}`
        : (project?.branch ?? (project?.commit ? `@ ${project.commit.slice(0, 7)}` : ''));
    return {
      name,
      path: project?.path ?? '',
      version,
      missing: Boolean(chat.codeProjectList?.available) && !project,
    };
  }),
);
/**
 * 扩展能力 = 场景绑定 ∪ 聊天临时选择。已有会话的场景部分取会话快照（创建时冻结），
 * 新会话取所选场景当前版本；名称来自能力选项，读取前回退到快照里的名称或编号。
 */
const scenarioExtensions = computed(() => {
  const bound = chat.current?.scenarioCapabilities;
  if (chat.current)
    return {
      skills: bound?.skills ?? [],
      mcpServers: bound?.mcpServers ?? [],
      webSearch: Boolean(bound?.webSearch),
    };
  const caps = selected.value?.payload.capabilities;
  return {
    skills: (caps?.skill_ids ?? []).map((id) => ({ id, title: '', name: '' })),
    mcpServers: (caps?.mcp_server_ids ?? []).map((id) => ({ id, name: '' })),
    webSearch: Boolean(caps?.web_search),
  };
});
/** 面板展示已生效的选择（新会话为待提交的选择）；输入框中未发送的修改另行提示 */
const shownCapabilities = computed(() => (chat.current ? chat.appliedCapabilities : chat.capabilityChoice));
const extensionSkills = computed(() => {
  const options = chat.capabilityOptions?.skills ?? [];
  const scenario = scenarioExtensions.value.skills;
  const chatOnly = shownCapabilities.value.skillIds.filter(
    (id) => !scenario.some((skill) => skill.id === id),
  );
  return [
    ...scenario.map((skill) => ({ ...skill, source: 'scenario' as const })),
    ...chatOnly.map((id) => ({ id, title: '', name: '', source: 'chat' as const })),
  ].map((skill) => {
    const option = options.find((item) => item.id === skill.id);
    const name = skill.name || option?.name || '';
    // 上一轮实际未装配；或 Skill 已下线、已删除（场景绑定与临时选择都一样），下一轮将被跳过
    const skippedEntry = skippedItem('skill', skill.id);
    const skipped = Boolean(skippedEntry);
    const missing = skipped || (Boolean(chat.capabilityOptions) && !option);
    const origin = skill.source === 'scenario' ? '场景绑定' : '临时选用';
    const gone = missingSkillInfo(chat.capabilityOptions, skill.id);
    return {
      id: skill.id,
      title: skill.title || option?.title || gone.title,
      missing,
      note: skipped
        ? `上一轮未生效：${skippedEntry?.reason || gone.reason}`
        : missing
          ? `${gone.reason}，下一轮将跳过`
          : [origin, name ? `/${name}` : ''].filter(Boolean).join(' · '),
      icon: missing ? 'info' : skill.source === 'scenario' ? 'lock' : 'check',
    };
  });
});
const extensionServers = computed(() => {
  const options = chat.capabilityOptions?.mcpServers ?? [];
  const scenario = scenarioExtensions.value.mcpServers;
  const chatOnly = shownCapabilities.value.mcpServerIds.filter((id) => !scenario.some((s) => s.id === id));
  return [
    ...scenario.map((server) => ({ ...server, source: 'scenario' as const })),
    ...chatOnly.map((id) => ({ id, name: '', source: 'chat' as const })),
  ].map((server) => {
    const option = options.find((item) => item.id === server.id);
    const tools = option?.tools.length ?? 0;
    const approval = option?.tools.filter((tool) => tool.permission === 'approval').length ?? 0;
    // 上一轮实际未装配；或已停用、连接异常，下一轮不会装配
    const skipped = skippedLastTurn('mcp', server.id);
    const missing = skipped || (Boolean(chat.capabilityOptions) && !option);
    return {
      id: server.id,
      name: server.name || option?.name || `MCP #${server.id}`,
      approval,
      missing,
      note: skipped
        ? '上一轮未生效：已停用或连接异常'
        : missing
          ? '已停用或连接异常，下一轮将跳过'
          : [
              server.source === 'scenario' ? '场景绑定' : '临时选用',
              tools ? `${tools} 个工具` : '',
              approval ? `${approval} 个需确认` : '',
            ]
              .filter(Boolean)
              .join(' · '),
      icon: missing ? 'info' : server.source === 'scenario' ? 'lock' : 'check',
    };
  });
});
const extensionWeb = computed(() =>
  scenarioExtensions.value.webSearch ? 'scenario' : shownCapabilities.value.webSearch ? 'chat' : null,
);
/** 联网未生效：上一轮实际跳过，或平台当前已关闭（下一轮将跳过） */
const webIssue = computed(() => {
  if (!extensionWeb.value) return '';
  if (skippedLastTurn('web')) return '上一轮未生效：平台未开启联网搜索';
  if (chat.capabilityOptions && !chat.capabilityOptions.web.available)
    return chat.capabilityOptions.web.reason || '平台已关闭联网，下一轮将跳过';
  return '';
});
/** 面板列表里找不到对应条目的未生效项（如已从场景快照外删除），在面板中单独列出 */
const unlistedUnavailable = computed(() =>
  lastUnavailable.value
    .filter(
      (item) =>
        (item.kind === 'skill' && !extensionSkills.value.some((skill) => skill.id === item.id)) ||
        (item.kind === 'mcp' && !extensionServers.value.some((server) => server.id === item.id)),
    )
    .map((item) => item.title || `${item.kind === 'mcp' ? 'MCP' : 'Skill'} #${item.id ?? '?'}`),
);
/** 当前存在问题的扩展能力数量：显示在顶部「能力」按钮上，替代消息流中的提示条 */
const capabilityIssueCount = computed(
  () =>
    extensionSkills.value.filter((skill) => skill.missing).length +
    extensionServers.value.filter((server) => server.missing).length +
    (webIssue.value ? 1 : 0) +
    unlistedUnavailable.value.length,
);
const capabilityButtonLabel = computed(() =>
  capabilityIssueCount.value ? `查看能力，${capabilityIssueCount.value} 项扩展技能未生效` : '查看能力',
);
/** 整个会话的交付物：最近一轮声明的排在最前，同一路径只保留最新一次声明 */
const sessionDeliverables = computed<FileRef[]>(() => {
  const seen = new Set<string>();
  const out: Deliverable[] = [];
  for (const turn of [...turns.value].reverse())
    for (const file of turn.deliverables)
      if (!seen.has(file.path)) {
        seen.add(file.path);
        out.push(file);
      }
  return out.map((file) => withListing(file, chat.files));
});
const existingPaths = computed(() => new Set(chat.files.map((file) => file.path)));
/** 声明为交付物、但已被删除或按保留期限清理的文件 */
function missing(file: FileRef) {
  return chat.filesLoaded && !existingPaths.value.has(file.path);
}
/** 右侧面板只列出仍存在的交付物（已删除的仍留在原轮次下方作为记录） */
const panelDeliverables = computed(() => sessionDeliverables.value.filter((file) => !missing(file)));
/** 未被声明为交付物的其余文件（中间产物等），最近修改的在前 */
const otherFiles = computed<FileRef[]>(() => {
  const presented = new Set(sessionDeliverables.value.map((file) => file.path));
  return chat.files.filter((file) => !presented.has(file.path));
});
function turnFile(file: Deliverable) {
  return withListing(file, chat.files);
}
function openPreview(file: FileRef) {
  if (chat.current) previewFile.value = file;
}
async function downloadFile(file: FileRef) {
  if (!chat.current || downloading.value) return;
  downloading.value = file.path;
  try {
    await downloadResponse(rawFileUrl(chat.current.id, file.path), fileName(file.path));
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    downloading.value = '';
  }
}
/** 从改动记录打开文件：可预览的打开预览，其余直接下载 */
function openChangedFile(path: string) {
  const file = chat.files.find((item) => item.path === path);
  if (!file) return;
  if (previewable(file)) openPreview(file);
  else void downloadFile(file);
}
async function deleteFile(file: FileRef) {
  if (!chat.current || deleting.value || chat.running) return;
  if (
    !(await confirm({
      title: `确定删除“${file.path}”吗？`,
      content: '文件会同时从执行工作区和服务端存储中删除，无法恢复。',
      okText: '删除',
      danger: true,
    }))
  )
    return;
  deleting.value = file.path;
  try {
    await chat.deleteFile(file.path);
    if (previewFile.value?.path === file.path) previewFile.value = null;
    app.toast(`已删除 ${fileName(file.path)}`);
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    deleting.value = '';
  }
}
async function downloadArchive(dir = '') {
  if (!chat.current || archiving.value !== null) return;
  archiving.value = dir;
  const folder = dir.split('/').pop();
  try {
    await downloadResponse(
      archiveUrl(chat.current.id, dir),
      `forge-session-${chat.current.id}-${folder || 'files'}.zip`,
    );
  } catch (error) {
    app.toast((error as Error).message, 'error');
  } finally {
    archiving.value = null;
  }
}
/** 过程块之后的正文是否正在流式输出（过程块头部据此显示「正在回复」） */
function answerStreaming(turn: Turn) {
  return turn.running && turn.answer.some((step) => step.live);
}
/** 运行中、但没有过程块可承载进度提示时（尚无输出，或无过程的回答已结束、等待后续）显示等待提示 */
function turnWaiting(turn: Turn) {
  return turn.running && !turn.process.length && !turn.answer.some((step) => step.live);
}
// 完成信号：最后一轮正常结束（有正式正文、非部分输出、无错误）时给出明确的「已完成」标记
const lastTurnCompleted = computed(() => {
  if (chat.running || chat.runError) return false;
  const last = turns.value.at(-1);
  if (!last || last.running) return false;
  return last.answer.some((step) => !step.partial);
});
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
  diffChange.value = null;
  stickToBottom.value = true;
  if (value && (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)))) {
    chat.prepareStart();
    loadError.value = '会话地址无效，请从会话列表重新打开。';
    return;
  }
  try {
    if (value && Number(value) !== chat.current?.id) {
      await chat.open(Number(value));
      // 打开别的空间的会话（链接、全部空间列表）：自动切到会话所在空间，留在本页
      if (generation === routeGeneration && chat.current?.id === Number(value))
        await space.follow(chat.current.spaceId, '（会话所在空间）');
    } else if (value && chat.current?.status === 'running')
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
  async (id) => {
    if (!id || route.params.sessionId) return;
    const origin = captureComposerOrigin();
    try {
      await router.replace(`/agent/chat/${id}`);
      await nextTick();
      if (router.currentRoute.value.path === `/agent/chat/${id}` && chat.current?.id === id)
        animateComposerArrival(origin);
    } catch {
      // A failed or interrupted navigation must not affect the accepted turn.
    }
  },
);
// 在本页的新会话中发送：欢迎页立即换成对话（消息先显示），输入框随之移到底部。
watch(
  () => Boolean(chat.outgoing && !chat.outgoing.failed && !chat.current),
  async (sending) => {
    if (!sending || route.params.sessionId) return;
    const origin = captureComposerOrigin();
    await nextTick();
    animateComposerArrival(origin);
  },
);
// 发送消息后总是回到底部：即使之前向上翻看了历史，也要看到刚发出的消息与后续回复
watch(
  () => [chat.sending, turns.value.filter((turn) => turn.user).length] as const,
  async ([sending, users], [wasSending, previousUsers]) => {
    if ((sending && !wasSending) || users > previousUsers) {
      stickToBottom.value = true;
      await scrollToBottom();
    }
  },
);
// 打开「能力」面板时刷新扩展能力的名称与可用状态；读取失败只影响展示
watch(
  () => chat.panelOpen && chat.panel === 'context',
  (visible) => {
    if (visible) void chat.loadCapabilityOptions().catch(() => {});
  },
  { immediate: true },
);
// 打开「能力」面板时刷新关联代码的分支与提交；读取失败只影响版本展示
watch(
  () => chat.panelOpen && chat.panel === 'context' && linkedCode.value.map((p) => p.name).join('\n'),
  (visible) => {
    if (visible) void chat.loadCodeProjects().catch(() => {});
  },
  { immediate: true },
);
watch(
  () => chat.liveText + chat.liveReasoning + chat.messages.length + chat.events.length,
  async () => {
    if (stickToBottom.value) await scrollToBottom();
  },
);
onBeforeUnmount(() => {
  ++routeGeneration;
  chat.disconnect();
  panelMedia.removeEventListener('change', resizePanel);
  window.removeEventListener('keydown', panelKeyboard);
});
async function scrollToBottom() {
  await nextTick();
  pinToBottom();
}
function showPanel(panel: 'files' | 'trajectory' | 'context') {
  chat.panelOpen = chat.panel !== panel || !chat.panelOpen;
  chat.panel = panel;
}
function toolTitle(name: string) {
  return app.tools.find((t) => t.name === name)?.title ?? builtinToolTitle(name);
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
  if (event.kind === 'model_switched')
    return `模型切换 · ${event.payload.from?.name ?? '未记录'} → ${event.payload.to?.name ?? '未记录'}`;
  if (event.kind === 'error') return '执行出现异常';
  if (event.kind === 'workspace_changes') return `文件改动 · ${event.payload.total ?? 0} 个文件`;
  return event.payload.partial ? '保留了部分输出' : '收到一条回复';
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
async function quoteMessage(text: string) {
  const quote = text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const draft = `${chat.input.trimEnd()}${chat.input.trim() ? '\n\n' : ''}${quote}\n\n`;
  if (draft.length > 64000) {
    app.toast('引用内容过长，请选择较短的消息', 'info');
    return;
  }
  chat.input = draft;
  stickToBottom.value = true;
  await nextTick();
  await scrollToBottom();
  composer.value?.focus();
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
            :class="['session-panel-button', { selected: chat.panelOpen && chat.panel === 'context' }]"
            :aria-expanded="chat.panelOpen && chat.panel === 'context'"
            :aria-label="capabilityButtonLabel"
            :title="capabilityIssueCount ? capabilityButtonLabel : undefined"
            @click="showPanel('context')"
          >
            <Icon name="blocks" :size="16" /><span>能力</span
            ><small v-if="capabilityIssueCount" class="is-warning">{{ capabilityIssueCount }} 项未生效</small>
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
          <article v-for="(turn, turnIndex) in turns" :key="turn.key" class="turn-block">
            <div v-if="turn.user" class="message-row user">
              <div class="user-message-block">
                <div class="user-message-text"><UserMessageText :text="turn.user.content" /></div>
                <div class="message-action-bar user-message-actions" aria-label="用户消息操作">
                  <button
                    type="button"
                    aria-label="复制消息"
                    title="复制消息"
                    @click="copyMessage(turn.user.content)"
                  >
                    <Icon name="ri-file-copy-line" :size="16" />
                  </button>
                  <button
                    type="button"
                    :disabled="chat.running || chat.loading"
                    aria-label="引用消息"
                    title="引用到输入框"
                    @click="quoteMessage(turn.user.content)"
                  >
                    <Icon name="ri-chat-1-line" :size="16" />
                  </button>
                </div>
                <div v-if="sendFailed(turn)" class="message-send-failed" role="alert">
                  <Icon name="info" :size="14" />发送失败，内容已放回输入框
                </div>
              </div>
            </div>
            <div v-if="!sendFailed(turn)" class="message-row assistant">
              <span class="message-avatar agent"><Icon name="sparkles" :size="18" /></span>
              <div class="message-main">
                <div class="message-author">
                  Agent<span v-if="turn.running">正在工作</span
                  ><span v-else-if="turnIndex === turns.length - 1 && lastTurnCompleted" class="done"
                    ><Icon name="check" :size="11" />已完成</span
                  >
                </div>
                <ProcessBlock
                  v-if="turn.process.length"
                  :steps="turn.process"
                  :active="turn.running"
                  :waiting="chat.approvals.length > 0"
                  :writing="answerStreaming(turn)"
                />
                <section v-for="step in turn.answer" :key="step.key" class="step-text">
                  <Markdown :text="step.text" :live="step.live" /><span
                    v-if="step.live"
                    class="stream-cursor"
                  ></span>
                </section>
                <div v-if="turnWaiting(turn)" class="agent-working compact" role="status">
                  <span class="thinking-dots"><i></i><i></i><i></i></span
                  ><span>{{
                    isOutgoing(turn) ? '正在准备…' : turn.steps.length ? '正在继续…' : '正在处理这项工作'
                  }}</span>
                </div>
                <div
                  v-if="turn.deliverables.length"
                  class="turn-deliverables"
                  role="group"
                  aria-label="本轮交付文件"
                >
                  <FileCard
                    v-for="file in turn.deliverables"
                    :key="file.path"
                    :file="turnFile(file)"
                    :downloading="downloading === file.path"
                    :missing="missing(file)"
                    @preview="openPreview"
                    @download="downloadFile"
                  />
                </div>
                <TurnChanges
                  v-if="turn.changes && !turn.running"
                  :changes="turn.changes"
                  :existing="existingPaths"
                  @diff="diffChange = $event"
                  @open="openChangedFile"
                />
                <div
                  v-if="!turn.running && turn.answer.some((step) => step.text)"
                  class="message-action-bar assistant-message-actions"
                  aria-label="AI 回复操作"
                >
                  <span v-if="turn.answer.some((step) => step.partial)" class="message-partial"
                    >执行未完成时保留的部分输出</span
                  >
                  <button
                    type="button"
                    aria-label="复制整轮回复"
                    title="复制整轮回复"
                    @click="copyMessage(turn.answer.map((step) => step.text).join('\n\n'))"
                  >
                    <Icon name="ri-file-copy-line" :size="16" />
                  </button>
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
          <div v-if="chat.queue" class="form-alert" role="status">
            <Icon name="clock" :size="16" />排队中 · 第 {{ chat.queue.position }} 位，等待执行额度释放…
          </div>
        </div>
      </div>
      <div v-if="!loadError && !welcome && !chat.loading" class="composer-area enterprise-composer-area">
        <button v-if="!stickToBottom && !welcome" class="jump-to-latest" @click="jumpToLatest">
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
          <details :open="approval.tool === 'bash'">
            <summary>{{ toolTitle(approval.tool) }} <Icon name="chevron" :size="14" /></summary>
            <pre>{{ formatArgs(approval.arguments) }}</pre>
            <p v-if="approval.tool === 'bash'" class="approval-workdir-hint">
              未指定 workdir 时，在会话工作区执行。
            </p>
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
        <TaskComposer ref="composer" @submitted="(id) => router.replace(`/agent/chat/${id}`)" />
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
            基础工具 <span>{{ selectedTools.length }}</span>
          </h3>
          <p class="small-text muted-text">平台基础能力，始终开启；以平台策略为上限。</p>
          <div v-for="tool in selectedTools" :key="tool.name" class="context-tool">
            <span><Icon :name="tool.icon" :size="16" /></span>
            <div>
              <strong>{{ tool.title }}</strong><small>{{
                tool.permission === 'read' ? '只读操作' : '写入会话目录 · 无需确认'
              }}</small>
            </div>
            <Icon :name="tool.permission === 'read' ? 'check' : 'edit'" :size="13" />
          </div>
        </div>
        <div class="context-section">
          <h3>
            关联代码 <span>{{ linkedCode.length }}</span>
          </h3>
          <p v-if="!linkedCode.length" class="small-text muted-text">
            未关联。可在输入框「关联代码」中选择一个或多个项目，模型将只读搜索与分析。
          </p>
          <div
            v-for="project in linkedCode"
            :key="project.name"
            class="context-tool"
            :title="project.path || project.name"
          >
            <span><Icon name="code" :size="16" /></span>
            <div>
              <strong>{{ project.name }}</strong><small>{{
                project.missing ? '已不在代码根目录中' : project.version || '只读'
              }}</small>
            </div>
            <Icon name="lock" :size="13" />
          </div>
          <p v-if="chat.codePending" class="small-text pending-text">
            输入框中已修改关联代码，随下一条消息生效。
          </p>
        </div>
        <div v-if="unlistedUnavailable.length" class="context-section">
          <p class="small-text warning-text" role="note">
            <Icon name="info" :size="12" /><span
              >上一轮未生效（已下线或未开启）：{{ unlistedUnavailable.join('、') }}</span
            >
          </p>
        </div>
        <div class="context-section">
          <h3>
            Skill <span>{{ extensionSkills.length }}</span>
          </h3>
          <p v-if="!extensionSkills.length" class="small-text muted-text">
            未启用。可在输入框「扩展技能」中临时选用已发布的 Skill。
          </p>
          <div
            v-for="skill in extensionSkills"
            :key="`skill-${skill.id}`"
            :class="['context-tool', { 'is-unavailable': skill.missing }]"
          >
            <span><Icon name="book" :size="16" /></span>
            <div>
              <strong>{{ skill.title }}</strong><small>{{ skill.note }}</small>
            </div>
            <Icon :name="skill.icon" :size="13" />
          </div>
        </div>
        <div class="context-section">
          <h3>
            MCP 服务 <span>{{ extensionServers.length }}</span>
          </h3>
          <p v-if="!extensionServers.length" class="small-text muted-text">
            未连接。可在输入框「扩展技能」中临时选用管理员已启用的 MCP 服务。
          </p>
          <div
            v-for="server in extensionServers"
            :key="`mcp-${server.id}`"
            :class="['context-tool', { 'is-unavailable': server.missing }]"
          >
            <span><Icon name="plug" :size="16" /></span>
            <div>
              <strong>{{ server.name }}</strong><small>{{ server.note }}</small>
            </div>
            <Icon :name="server.icon" :size="13" />
          </div>
        </div>
        <div class="context-section">
          <h3>联网</h3>
          <p :class="['small-text', webIssue ? 'warning-text' : 'muted-text']">
            {{
              extensionWeb
                ? `${extensionWeb === 'scenario' ? '场景已开启' : '已临时开启'}：${
                    webIssue || '可搜索网络并读取网页，回答会注明来源'
                  }`
                : '未开启。可在输入框「扩展技能」中开启联网搜索。'
            }}
          </p>
          <p v-if="chat.capabilitiesPending" class="small-text pending-text">
            输入框中已修改扩展技能，随下一条消息生效。
          </p>
        </div>
        <div class="context-section">
          <h3>本次执行边界</h3>
          <ul class="boundary-list">
            <li>
              <Icon name="check" :size="12" />{{
                linkedCode.length ? '文件写入限定当前会话目录' : '文件访问限定当前会话目录'
              }}
            </li>
            <li v-if="linkedCode.length">
              <Icon name="check" :size="12" />关联代码只读，不读取 .git 与密钥文件
            </li>
            <li><Icon name="check" :size="12" />工具范围由场景、临时选择与平台策略共同限制</li>
            <li v-if="extensionServers.some((server) => server.approval)">
              <Icon name="check" :size="12" />未标注只读的 MCP 工具每次调用前需你确认
            </li>
            <li v-if="extensionWeb"><Icon name="check" :size="12" />网页抓取仅访问公网地址，搜索按次计费</li>
            <li><Icon name="check" :size="12" />消息与执行事件持久化记录</li>
            <li><Icon name="lock" :size="12" />不开放任意 Shell 命令</li>
          </ul>
        </div>
        <div class="context-section">
          <h3>模型</h3>
          <p v-if="chat.current" class="small-text muted-text" :title="chat.current.model">
            {{ chat.current.modelName || chat.current.model || '未记录'
            }}<template v-if="chat.current.modelName && chat.current.modelName !== chat.current.model">
              · {{ chat.current.model }}</template
            >
          </p>
          <p v-else class="small-text muted-text">
            {{ app.modelOptions.find((option) => option.id === chat.selectedModelId)?.name || '尚未配置' }}
          </p>
          <p v-if="chat.current" class="small-text muted-text">
            累计 {{ (chat.current.tokensIn + chat.current.tokensOut).toLocaleString() }} tokens ·
            {{
              chat.current.cost !== null
                ? `¥${chat.current.cost.toFixed(4)}`
                : (chat.current.models ?? []).some((segment) => segment.cost != null)
                  ? '部分模型未配置单价'
                  : '费用未配置'
            }}
          </p>
          <ul v-if="(chat.current?.models?.length ?? 0) > 1" class="model-usage-list" aria-label="各模型用量">
            <li v-for="(segment, index) in chat.current?.models" :key="index">
              <span :title="segment.model">{{ segment.name || segment.model }}</span>
              <small
                >{{ ((segment.tokensIn ?? 0) + (segment.tokensOut ?? 0)).toLocaleString() }} tokens ·
                {{ segment.cost == null ? '未配置单价' : `¥${segment.cost.toFixed(4)}` }}</small
              >
            </li>
          </ul>
        </div>
        <details v-if="chat.current" class="technical-detail">
          <summary>引用快照标识</summary>
          <code>{{ chat.current.bundleHash }}</code>
        </details>
        <div v-else class="context-tip">
          <Icon name="info" :size="15" />
          <p>
            提交后会记录场景与策略快照，后续维护不会静默改变已有会话；模型、关联代码与扩展技能在输入框中调整，随下一条消息生效。
          </p>
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
                        : event.kind === 'model_switched'
                          ? 'model'
                          : event.kind === 'workspace_changes'
                            ? 'folder'
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
        <div v-if="chat.files.length" class="result-toolbar">
          <span
            >{{ chat.files.length }} 个文件 ·
            {{ formatBytes(chat.files.reduce((sum, file) => sum + file.bytes, 0)) }}</span
          >
          <button
            type="button"
            class="button secondary small"
            :disabled="archiving !== null"
            @click="downloadArchive()"
          >
            <span v-if="archiving === ''" class="loader small"></span
            ><Icon v-else name="download" :size="14" />打包下载全部
          </button>
        </div>
        <template v-if="panelDeliverables.length">
          <h3 class="result-section-title">
            交付物 <span>{{ panelDeliverables.length }}</span>
          </h3>
          <div class="result-file-list">
            <FileCard
              v-for="file in panelDeliverables"
              :key="file.path"
              :file="file"
              compact
              :deletable="!chat.running"
              :downloading="downloading === file.path"
              :deleting="deleting === file.path"
              @preview="openPreview"
              @download="downloadFile"
              @delete="deleteFile"
            />
          </div>
        </template>
        <template v-if="otherFiles.length">
          <h3 class="result-section-title">
            {{ panelDeliverables.length ? '其他文件' : '文件' }} <span>{{ otherFiles.length }}</span>
          </h3>
          <FileTree
            :files="otherFiles"
            :downloading="downloading"
            :deleting="deleting"
            :archiving="archiving"
            :deletable="!chat.running"
            @preview="openPreview"
            @download="downloadFile"
            @delete="deleteFile"
            @archive="downloadArchive"
          />
        </template>
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
        <div v-if="!chat.files.length && !panelDeliverables.length && !lastAnswer" class="panel-empty">
          <Icon name="folder" :size="31" /><strong>结果会留在这里</strong>
          <p>执行后的回复与实际生成文件，可以随时回来查看。</p>
        </div>
      </div>
    </aside>
    <FilePreview
      v-if="previewFile && chat.current"
      :key="previewFile.path"
      :session-id="chat.current.id"
      :file="previewFile"
      @close="previewFile = null"
    />
    <FileDiff
      v-if="diffChange && chat.current"
      :key="diffChange.id"
      :session-id="chat.current.id"
      :change="diffChange"
      @close="diffChange = null"
    />
  </div>
</template>
