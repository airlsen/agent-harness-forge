<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlatform } from '../../stores/platform';
import { useConversation } from '../../stores/conversation';
import { api } from '../../api/client';
import Icon from '../../components/ForgeIcon.vue';
import Markdown from '../../components/MarkdownContent.vue';
const app = usePlatform(),
  chat = useConversation(),
  route = useRoute(),
  router = useRouter();
const scenarioPicker = ref(false),
  fileInput = ref<HTMLInputElement | null>(null),
  messagesPane = ref<HTMLElement | null>(null),
  previewFile = ref<{ path: string; content: string } | null>(null),
  approvalBusy = ref(false);
const selected = computed(
  () => app.scenarios.find((s) => s.id === chat.selectedScenarioId) ?? app.scenarios[0],
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
const welcome = computed(() => !chat.current && !chat.messages.length);
const rawEvents = computed(() => chat.events.filter((e) => e.kind === 'trajectory'));
const activeTools = computed(() =>
  !chat.running
    ? []
    : chat.events.filter(
        (e) =>
          e.kind === 'tool_use_start' &&
          !chat.events.some((r) => r.kind === 'tool_result' && r.payload.toolCallId === e.payload.toolCallId),
      ),
);
const suggestions = [
  {
    icon: 'code',
    title: '一起解决一个技术问题',
    description: '分析代码、排查故障、讨论架构',
    scenario: '代码与研发',
    text: '我想请你帮我分析一个技术问题：\n',
  },
  {
    icon: 'file',
    title: '把资料整理成清晰文档',
    description: '提炼要点、组织结构、生成报告',
    scenario: '文档与报告',
    text: '请帮我把下面的资料整理成一份结构清晰的文档：\n',
  },
  {
    icon: 'chart',
    title: '拆解一个业务问题',
    description: '建立分析框架，找到下一步行动',
    scenario: '分析与决策',
    text: '请帮我分析这个业务问题，并给出可执行的建议：\n',
  },
];
watch(
  () => route.params.sessionId,
  async (value) => {
    try {
      if (value && Number(value) !== chat.current?.id) await chat.open(Number(value));
      else if (value && chat.current?.status === 'running')
        chat.follow(Number(value), chat.events.at(-1)?.seq ?? 0);
      else if (!value && chat.current) chat.newConversation();
    } catch (e) {
      app.toast((e as Error).message, 'error');
    }
  },
  { immediate: true },
);
watch(
  () => chat.liveText + chat.messages.length + chat.events.length,
  async () => {
    await nextTick();
    if (messagesPane.value) messagesPane.value.scrollTop = messagesPane.value.scrollHeight;
  },
);
onBeforeUnmount(() => chat.disconnect());
function chooseSuggestion(item: (typeof suggestions)[number]) {
  const scene = app.scenarios.find((s) => s.payload.name === item.scenario);
  if (scene) chat.selectedScenarioId = scene.id;
  chat.input = item.text;
  document.getElementById('task-input')?.focus();
}
async function send() {
  if (!app.connection?.configured) {
    app.toast('先连接一个真实模型，再开始执行任务', 'info');
    await router.push('/agent/models');
    return;
  }
  try {
    const id = await chat.submit();
    if (id && route.params.sessionId !== String(id)) await router.replace(`/agent/chat/${id}`);
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
}
async function attach(event: Event) {
  const files = (event.target as HTMLInputElement).files;
  if (!files) return;
  for (const file of Array.from(files)) {
    if (file.size > 200000) {
      app.toast(`${file.name} 超过 200 KB，请精简后附加`, 'error');
      continue;
    }
    if (chat.draftAttachments.length >= 4) {
      app.toast('每轮最多附加 4 个文本文件', 'info');
      break;
    }
    chat.draftAttachments.push({ name: file.name, content: await file.text() });
  }
  (event.target as HTMLInputElement).value = '';
}
async function openFile(path: string) {
  if (!chat.current) return;
  try {
    const data = await api<{ content: string }>(
      `/agent/sessions/${chat.current.id}/file?path=${encodeURIComponent(path)}`,
    );
    previewFile.value = { path, content: data.content };
  } catch (e) {
    app.toast((e as Error).message, 'error');
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
  URL.revokeObjectURL(url);
}
async function decide(id: number, action: 'approve' | 'deny') {
  approvalBusy.value = true;
  try {
    await chat.resolveApproval(id, action);
    app.toast(action === 'approve' ? '已批准本次操作' : '已拒绝本次操作');
  } catch (e) {
    app.toast((e as Error).message, 'error');
  } finally {
    approvalBusy.value = false;
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
function formatArgs(value: unknown) {
  try {
    return typeof value === 'string'
      ? JSON.stringify(JSON.parse(value), null, 2)
      : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
</script>
<template>
  <div class="chat-layout">
    <section class="chat-primary">
      <div class="chat-subbar">
        <div class="chat-title">
          <span class="session-icon"><Icon :name="sceneIcon" :size="17" /></span
          ><strong>{{ chat.current?.title ?? '新会话' }}</strong
          ><span v-if="chat.current" class="tag soft">v{{ chat.current.scenarioVersion }}</span>
        </div>
        <div class="chat-subbar-actions">
          <a
            v-if="chat.current"
            :href="`/api/agent/sessions/${chat.current.id}/export`"
            class="icon-button"
            title="导出会话与轨迹"
            aria-label="导出会话"
            ><Icon name="download" :size="17" /></a
          ><button
            :class="['icon-button', { active: chat.panelOpen }]"
            title="会话上下文与执行轨迹"
            aria-label="切换会话侧栏"
            @click="chat.panelOpen = !chat.panelOpen"
          >
            <Icon name="panel" :size="18" />
          </button>
        </div>
      </div>
      <div ref="messagesPane" :class="['chat-scroll', { 'is-welcome': welcome }]">
        <div v-if="chat.loading" class="loading-inline"><span class="loader"></span>正在读取会话…</div>
        <template v-else-if="welcome"
          ><div class="welcome-content">
            <span class="welcome-emblem"><Icon name="sparkles" :size="31" /></span>
            <div class="eyebrow">A LITTLE INTELLIGENCE. A LOT OF POSSIBILITY.</div>
            <h1>你好，开发者。<br /><span>今天，一起完成什么？</span></h1>
            <p>
              选择一个场景，或者直接告诉我你的目标。<br class="mobile-break" />让 Agent 帮你把想法变成下一步。
            </p>
            <div class="suggestion-grid">
              <button v-for="item in suggestions" :key="item.title" @click="chooseSuggestion(item)">
                <span class="suggestion-icon"><Icon :name="item.icon" :size="20" /></span
                ><strong>{{ item.title }}</strong
                ><span>{{ item.description }}</span
                ><Icon class="suggestion-arrow" name="arrow" :size="15" />
              </button>
            </div>
            <div v-if="!app.connection?.configured" class="connect-model-prompt">
              <span class="connect-model-icon"><Icon name="plug" :size="20" /></span>
              <div>
                <strong>模型未配置，连接后开始第一个任务</strong
                ><span>支持 DeepSeek、企业模型网关及 OpenAI 兼容接口</span>
              </div>
              <RouterLink to="/agent/models">去配置 <Icon name="arrow" :size="14" /></RouterLink>
            </div></div
        ></template>
        <div v-else class="conversation-messages">
          <div class="conversation-start">
            <Icon name="shield" :size="12" />{{ chat.current?.scenarioName }} · v{{
              chat.current?.scenarioVersion
            }}<span>会话已锁定场景与策略快照</span>
          </div>
          <article v-for="message in chat.messages" :key="message.id" :class="['message-row', message.role]">
            <template v-if="message.role === 'user'"
              ><span class="message-avatar user">D</span>
              <div class="message-main">
                <div class="message-author">你</div>
                <div class="user-message-text">{{ message.content }}</div>
              </div></template
            ><template v-else-if="message.role === 'tool'"
              ><div class="tool-card">
                <details>
                  <summary>
                    <span :class="['tool-result-icon', { error: message.meta.isError }]"
                      ><Icon :name="message.meta.isError ? 'info' : 'check'" :size="15"
                    /></span>
                    <div>
                      <strong>{{ message.meta.tool ?? '工具调用' }}</strong><span>{{
                        message.meta.isError ? '调用未成功' : '执行完成'
                      }}</span>
                    </div>
                    <Icon name="chevron" :size="15" />
                  </summary>
                  <div class="tool-card-details">
                    <label>输入参数</label>
                    <pre>{{ formatArgs(message.meta.arguments) }}</pre>
                    <label>执行结果</label>
                    <pre>{{ message.content }}</pre>
                  </div>
                </details>
              </div></template
            ><template v-else
              ><span class="message-avatar agent"><Icon name="sparkles" :size="18" /></span>
              <div class="message-main">
                <div class="message-author">Forge <span>Agent</span></div>
                <Markdown :text="message.content" /><span v-if="message.meta.partial" class="message-partial"
                  >任务中断前的部分输出</span
                ><button class="message-copy" title="复制内容" @click="copyMessage(message.content)">
                  <Icon name="copy" :size="13" />复制
                </button>
              </div></template
            >
          </article>
          <div v-for="tool in activeTools" :key="tool.seq" class="active-tool">
            <span class="loader small"></span><strong>{{ tool.payload.tool }}</strong
            ><span>{{ chat.approvals.length ? '等待你的批准' : '正在调用工具…' }}</span>
          </div>
          <article v-if="chat.liveText" class="message-row assistant">
            <span class="message-avatar agent"><Icon name="sparkles" :size="18" /></span>
            <div class="message-main">
              <div class="message-author">Forge <span>正在输出</span></div>
              <Markdown :text="chat.liveText" /><span class="stream-cursor"></span>
            </div>
          </article>
          <div v-else-if="chat.running && !activeTools.length" class="agent-working">
            <span class="message-avatar agent"><Icon name="sparkles" :size="18" /></span
            ><span class="thinking-dots"><i></i><i></i><i></i></span><span>Agent 正在处理你的任务</span>
          </div>
          <div v-if="chat.runError" class="form-alert error">
            <Icon name="info" :size="18" />
            <div>
              <strong>这次执行未完成</strong>
              <p>{{ chat.runError }}</p>
            </div>
          </div>
          <div v-if="chat.connectionWarning" class="form-alert">
            <Icon name="info" :size="16" />{{ chat.connectionWarning }}
          </div>
        </div>
      </div>
      <div class="composer-area">
        <div v-for="approval in chat.approvals" :key="approval.ticketId" class="approval-card">
          <div class="approval-heading">
            <span class="approval-symbol"><Icon name="shield" :size="20" /></span>
            <div>
              <strong>Agent 需要你的批准</strong>
              <p>{{ approval.reason ?? '此工具将修改会话工作区内的文件' }}</p>
            </div>
            <span class="tag warning">待审批</span>
          </div>
          <details>
            <summary>{{ approval.tool }} <Icon name="chevron" :size="14" /></summary>
            <pre>{{ formatArgs(approval.arguments) }}</pre>
          </details>
          <div class="approval-actions">
            <small>仅对本次调用生效，超时默认拒绝。</small
            ><button
              class="button secondary"
              :disabled="approvalBusy"
              @click="decide(approval.ticketId, 'deny')"
            >
              拒绝</button
            ><button
              class="button primary"
              :disabled="approvalBusy"
              @click="decide(approval.ticketId, 'approve')"
            >
              <Icon name="check" :size="14" />允许本次
            </button>
          </div>
        </div>
        <div class="composer-box">
          <div v-if="chat.draftAttachments.length" class="attachment-chips">
            <span v-for="(file, index) in chat.draftAttachments" :key="index"
              ><Icon name="file" :size="14" />{{ file.name
              }}<button :aria-label="`移除附件 ${file.name}`" @click="chat.draftAttachments.splice(index, 1)">
                <Icon name="close" :size="12" /></button
            ></span>
          </div>
          <textarea
            id="task-input"
            v-model="chat.input"
            aria-label="任务输入"
            :placeholder="
              chat.current ? '继续对话，或给 Agent 一个新的任务…' : '描述你的任务，剩下的交给 Agent…'
            "
            :disabled="chat.running"
            rows="3"
            @keydown="
              (e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  send();
                }
              }
            "
          ></textarea>
          <div class="composer-toolbar">
            <div class="composer-tools">
              <div class="scenario-picker-wrap">
                <button
                  class="scenario-trigger"
                  :disabled="Boolean(chat.current)"
                  @click="scenarioPicker = !scenarioPicker"
                >
                  <Icon :name="sceneIcon" :size="15" /><span>{{
                    chat.current?.scenarioName ?? selected?.payload.name ?? '选择场景'
                  }}</span
                  ><Icon v-if="!chat.current" name="chevronDown" :size="12" />
                </button>
                <div v-if="scenarioPicker" class="scenario-popover">
                  <div class="popover-label">选择一个工作场景</div>
                  <button
                    v-for="scenario in app.scenarios"
                    :key="scenario.id"
                    :class="{ selected: selected?.id === scenario.id }"
                    @click="
                      chat.selectedScenarioId = scenario.id;
                      scenarioPicker = false;
                    "
                  >
                    <Icon :name="scenario.payload.icon" :size="17" />
                    <div>
                      <strong>{{ scenario.payload.name }}</strong><span>{{
                        scenario.payload.description
                      }}</span>
                    </div>
                    <Icon v-if="selected?.id === scenario.id" name="check" :size="15" /></button
                  ><RouterLink to="/agent/scenarios"
                    >管理全部场景 <Icon name="arrow" :size="13"
                  /></RouterLink>
                </div>
              </div>
              <span class="composer-divider"></span
              ><button
                class="icon-button"
                :disabled="chat.running"
                title="附加文本文件，内容随任务发送"
                aria-label="附加文本文件"
                @click="fileInput?.click()"
              >
                <Icon name="paperclip" :size="17" /></button
              ><input
                ref="fileInput"
                type="file"
                multiple
                accept=".txt,.md,.csv,.json,.ts,.js,.py,.html,.css,.yaml,.yml,.sql,.xml,.log"
                hidden
                @change="attach"
              /><span class="model-caption"
                ><span :class="['dot', { neutral: !app.connection?.configured }]"></span
                >{{
                  chat.current?.model || (app.connection?.configured ? app.connection.model : '模型未配置')
                }}</span
              >
            </div>
            <button
              v-if="chat.running"
              class="stop-button"
              @click="chat.interrupt().catch((e) => app.toast(e.message, 'error'))"
            >
              <span></span>中止</button
            ><button
              v-else
              class="send-button"
              :disabled="!chat.input.trim() && !chat.draftAttachments.length"
              aria-label="发送任务"
              title="发送任务"
              @click="send"
            >
              <Icon name="arrowUp" :size="19" />
            </button>
          </div>
        </div>
        <div class="composer-footnote">
          <span><Icon name="lock" :size="11" />仅使用场景授权的能力</span
          ><span v-if="chat.current"
            >{{ (chat.current.tokensIn + chat.current.tokensOut).toLocaleString() }} tokens<span
              class="separator"
              >·</span
            >{{ chat.current.cost === null ? '费用未配置' : `¥${chat.current.cost.toFixed(4)}` }}</span
          ><span v-else>Enter 发送<span class="separator">·</span>Shift + Enter 换行</span>
        </div>
      </div>
    </section>
    <aside v-if="chat.panelOpen" class="context-panel">
      <div class="context-tabs">
        <button :class="{ selected: chat.panel === 'context' }" @click="chat.panel = 'context'">上下文</button
        ><button :class="{ selected: chat.panel === 'trajectory' }" @click="chat.panel = 'trajectory'">
          轨迹<span v-if="rawEvents.length">{{ rawEvents.length }}</span></button
        ><button :class="{ selected: chat.panel === 'files' }" @click="chat.panel = 'files'">
          产物<span v-if="chat.files.length">{{ chat.files.length }}</span>
        </button>
      </div>
      <div v-if="chat.panel === 'context'" class="context-content">
        <div class="panel-eyebrow">SCENARIO CONTEXT</div>
        <span class="context-scene-icon"><Icon :name="sceneIcon" :size="24" /></span>
        <h2>{{ chat.current?.scenarioName ?? selected?.payload.name ?? '选择一个场景' }}</h2>
        <p>{{ sceneDescription }}</p>
        <div class="context-meta">
          <span>{{ selected?.space === 'official' ? '官方模板' : '我的场景' }}</span><span>Standard 模式</span
          ><span v-if="chat.current">v{{ chat.current.scenarioVersion }}</span>
        </div>
        <div class="context-section">
          <h3>
            已装配能力 <span>{{ selectedTools.length }}</span>
          </h3>
          <div v-if="!selectedTools.length" class="muted-text small-text">
            此场景未授权工具，使用纯对话模式。
          </div>
          <div v-for="tool in selectedTools" :key="tool.name" class="context-tool">
            <span><Icon :name="tool.icon" :size="16" /></span>
            <div>
              <strong>{{ tool.title }}</strong><small>{{
                tool.permission === 'approval' ? '写入 · 受策略门控' : '会话范围只读'
              }}</small>
            </div>
            <Icon :name="tool.permission === 'approval' ? 'shield' : 'check'" :size="13" />
          </div>
        </div>
        <div class="context-section">
          <h3>执行边界</h3>
          <ul class="boundary-list">
            <li><Icon name="check" :size="12" />工作区按会话隔离目录</li>
            <li><Icon name="check" :size="12" />工具调用由策略门控</li>
            <li><Icon name="check" :size="12" />消息与事件持久化留痕</li>
            <li><Icon name="lock" :size="12" />未开放任意 Shell 命令</li>
          </ul>
        </div>
        <div v-if="chat.current" class="bundle-info">
          <Icon name="layers" :size="15" />
          <div>
            <strong>不可变场景快照</strong><code>{{ chat.current.bundleHash.slice(0, 16) }}</code>
          </div>
        </div>
        <div v-else class="context-tip">
          <Icon name="info" :size="15" />
          <p>场景决定 Agent 如何工作。提交任务后，本次会话会锁定场景版本与安全策略。</p>
        </div>
      </div>
      <div v-else-if="chat.panel === 'trajectory'" class="panel-scroll">
        <div class="panel-description">
          来自 dsh Session Log 的实际事件。<RouterLink
            v-if="chat.current"
            :to="`/agent/trajectory/${chat.current.id}`"
            >完整轨迹 <Icon name="arrow" :size="12"
          /></RouterLink>
        </div>
        <div v-if="!rawEvents.length" class="panel-empty">
          <Icon name="activity" :size="30" /><strong>每一步，都有迹可循</strong>
          <p>任务执行后，这里会展示模型请求、工具调用和运行时事件。</p>
        </div>
        <details v-for="event in rawEvents" :key="event.seq" class="compact-event">
          <summary>
            <span class="event-point"></span><code>{{ event.payload.type }}</code
            ><small>#{{ event.payload.seq }}</small>
          </summary>
          <pre>{{ formatArgs(event.payload.data) }}</pre>
        </details>
      </div>
      <div v-else class="panel-scroll">
        <div class="panel-description">仅展示当前会话实际生成的文本产物。</div>
        <div v-if="!chat.files.length" class="panel-empty">
          <Icon name="folder" :size="31" /><strong>好的想法，值得交付</strong>
          <p>让 Agent 生成文档或代码文件，完成后会出现在这里。</p>
        </div>
        <button
          v-for="file in chat.files"
          :key="file.path"
          class="artifact-file"
          @click="openFile(file.path)"
        >
          <span class="file-icon"><Icon name="file" :size="19" /></span>
          <div>
            <strong>{{ file.path }}</strong><small>{{ (file.bytes / 1024).toFixed(1) }} KB · 文本产物</small>
          </div>
          <Icon name="arrow" :size="14" />
        </button>
      </div>
      <div class="context-footer">
        <Icon name="box" :size="13" />DeepSeek Harness <span>PLUGIN FIRST</span>
      </div>
    </aside>
    <div v-if="previewFile" class="modal-backdrop" @click.self="previewFile = null">
      <section class="modal file-preview" role="dialog" aria-modal="true" aria-label="产物预览">
        <header>
          <div>
            <h2>{{ previewFile.path }}</h2>
            <p>会话工作区 · 文本产物</p>
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
        </footer>
      </section>
    </div>
  </div>
</template>
