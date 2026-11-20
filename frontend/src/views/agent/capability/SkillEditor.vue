<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import { api, apiFetch, post, put } from '../../../api/client';
import Icon from '../../../components/ForgeIcon.vue';
import CatalogEmpty from '../../../components/catalog/CatalogEmpty.vue';
import Markdown from '../../../components/MarkdownContent.vue';
import CodeBlock from '../../../components/CodeBlock.vue';
import SkillSourceEditor from '../../../components/SkillSourceEditor.vue';
import { readSkillDocument, updateSkillMetadata, initialSkillDocument } from '../../../utils/skillDocument';
import { usePlatform } from '../../../stores/platform';
import { confirm } from '../../../utils/feedback';
import type {
  SkillAuthoringMessage,
  SkillAuthoringSession,
  SkillDetail,
  SkillRevision,
} from '../../../types/skill';

const route = useRoute();
const router = useRouter();
const isNew = computed(() => !route.params.id);
const app = usePlatform();
const skill = ref<SkillDetail | null>(null);
let loadRequest = 0;
const revisions = ref<SkillRevision[]>([]);
const session = ref<SkillAuthoringSession | null>(null);
const messages = ref<SkillAuthoringMessage[]>([]);
const loading = ref(true);
const saving = ref(false);
const publishing = ref(false);
const busy = ref(false);
const dirty = ref(false);
// 仅表示 Skill 无法打开（整页状态）；保存、发布等操作结果统一走全局 toast。
const error = ref('');
const prompt = ref('');
const streamingText = ref('');
const assistantChange = ref('');
const previewRevision = ref<SkillRevision | null>(null);
const promptInput = ref<{ focus: () => void } | null>(null);

const skillId = computed(() => Number(route.params.id));
const canPublish = computed(() =>
  Boolean(
    !isNew.value &&
    skill.value &&
    skill.value.status === 'draft' &&
    !dirty.value &&
    !saving.value &&
    !busy.value &&
    !publishing.value,
  ),
);
const saveState = computed(() => {
  if (saveError.value) return '保存失败';
  if (saving.value) return '保存中…';
  if (isNew.value) return '尚未保存';
  if (dirty.value) return '有未保存修改';
  return skill.value?.updatedAt ? `已保存 · ${formatDate(skill.value.updatedAt)}` : '草稿已保存';
});
function revisionSource(source: string) {
  if (source === 'assistant') return '助手更新';
  if (source === 'publish') return '正式发布';
  if (source === 'restore') return '恢复修订';
  return '手动编辑';
}
const starterPrompts = computed(() => {
  const label = skill.value?.name || '这个 Skill';
  const description = skill.value?.description ? `，用途是：${skill.value.description}` : '';
  return [
    `请根据“${label}”${description}，生成一份完整的工作方法草稿。`,
    '请补充输入检查、异常情况处理和需要向用户确认的边界。',
    '请将输出要求整理成可直接复用的清晰格式，并补充质量检查步骤。',
  ];
});

function formatDate(value: string | null) {
  if (!value) return '刚刚';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '最近';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
function roleLabel(role: string) {
  if (role === 'user') return '你';
  if (role === 'assistant') return '助手';
  return '记录';
}
async function loadSkill(options: { focusAssistant?: boolean; quiet?: boolean } = {}) {
  const request = ++loadRequest;
  if (isNew.value) {
    skill.value = {
      id: 0,
      name: '',
      description: '',
      status: 'draft',
      tags: [],
      currentRevisionId: null,
      publishedRevisionId: null,
      publishedVersion: null,
      revision: null,
      content: initialSkillDocument(),
      changeSummary: '',
      referenceFiles: [],
      createdAt: null,
      updatedAt: null,
    };
    revisions.value = [];
    session.value = null;
    messages.value = [];
    dirty.value = false;
    error.value = '';
    saveError.value = '';
    metadataError.value = '';
    prompt.value = '';
    streamingText.value = '';
    assistantChange.value = '';
    loading.value = false;
    await nextTick();
    promptInput.value?.focus();
    return;
  }
  const id = skillId.value;
  if (!Number.isInteger(id) || id < 1) {
    skill.value = null;
    error.value = 'Skill 地址无效。';
    loading.value = false;
    return;
  }
  if (!options.quiet) loading.value = true;
  error.value = '';
  try {
    const [detail, revisionResult, latestSession] = await Promise.all([
      api<SkillDetail>(`/skills/${id}`),
      api<{ items: SkillRevision[] }>(`/skills/${id}/revisions`),
      api<SkillAuthoringSession | null>(`/skills/${id}/authoring-session/latest`),
    ]);
    if (request !== loadRequest) return;
    skill.value = detail;
    saveError.value = '';
    metadataError.value = '';
    revisions.value = revisionResult.items;
    session.value = options.quiet ? latestSession : null;
    const latestMessages = latestSession?.messages ?? [];
    messages.value = options.quiet
      ? [
          ...messages.value.filter(
            (message) =>
              typeof message.id === 'number' && !latestMessages.some((latest) => latest.id === message.id),
          ),
          ...latestMessages,
        ]
      : latestMessages;
    dirty.value = false;
    if (options.focusAssistant || isNew.value || route.query.start === 'generate') {
      await nextTick();
      promptInput.value?.focus();
    }
  } catch (err) {
    if (request !== loadRequest) return;
    // 已打开的 Skill 刷新失败只提示一次，保留当前内容；首次打开失败才进入整页错误态。
    if (skill.value?.id === id) app.toast((err as Error).message, 'error');
    else {
      skill.value = null;
      error.value = (err as Error).message;
    }
  } finally {
    if (request === loadRequest) loading.value = false;
  }
}
async function refreshRevisions() {
  if (!skill.value) return;
  revisions.value = (await api<{ items: SkillRevision[] }>(`/skills/${skill.value.id}/revisions`)).items;
}
async function save() {
  if (
    !skill.value ||
    (!dirty.value && !isNew.value) ||
    saving.value ||
    busy.value ||
    publishing.value ||
    uploadingReference.value
  )
    return;
  clearTimeout(saveTimer);
  try {
    syncMetadata();
  } catch (err) {
    saveError.value = (err as Error).message;
    return;
  }
  saving.value = true;
  saveError.value = '';
  try {
    if (isNew.value) {
      const created = await post<SkillDetail>('/skills', {
        name: skill.value.name.trim(),
        description: skill.value.description.trim(),
        content: skill.value.content,
      });
      skill.value = created;
      dirty.value = false;
      await router.replace(`/agent/skills/${created.id}`);
      await refreshRevisions().catch((err: Error) =>
        app.toast(`草稿已保存，但历史读取失败：${err.message}`, 'error'),
      );
      return;
    }
    skill.value = await put<SkillDetail>(`/skills/${skill.value.id}/draft`, {
      content: skill.value.content,
      change_summary: '手动编辑草稿',
    });
    dirty.value = false;
    session.value = null; // 手动修改后重新建立携带最新文件的助手上下文
    await refreshRevisions().catch((err: Error) =>
      app.toast(`草稿已保存，但历史读取失败：${err.message}`, 'error'),
    );
  } catch (err) {
    saveError.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}
async function requestPublish() {
  if (dirty.value || isNew.value) await save();
  if (!canPublish.value) return;
  const ok = await confirm({
    title: '发布新的正式版本？',
    content: '将以当前草稿创建不可变版本。之后继续编辑会产生新的草稿，不会修改已发布版本。',
    okText: '确认发布',
  });
  if (ok) await publish();
}
async function publish() {
  if (!skill.value || publishing.value) return;
  publishing.value = true;
  try {
    skill.value = await post<SkillDetail>(`/skills/${skill.value.id}/publish`);
    app.toast(
      skill.value.publishedVersion ? `已发布 v${skill.value.publishedVersion}，新会话将使用此版本` : '已发布',
    );
    await refreshRevisions();
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    publishing.value = false;
  }
}
async function requestRestore(revision: SkillRevision) {
  const ok = await confirm({
    title: `恢复 r${revision.revision} 为草稿？`,
    content: '系统会基于这份修订创建新的草稿记录，不会覆盖当前版本或已经发布的版本。',
    okText: '恢复为草稿',
  });
  if (ok) await restore(revision);
}
async function restore(revision: SkillRevision) {
  if (!skill.value) return;
  saving.value = true;
  try {
    skill.value = await post<SkillDetail>(`/skills/${skill.value.id}/revisions/${revision.id}/restore`);
    dirty.value = false;
    previewRevision.value = null;
    session.value = null;
    lastChange.value = null;
    app.toast(`已将 r${revision.revision} 恢复为草稿`);
    await refreshRevisions();
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    saving.value = false;
  }
}
const uploadingReference = ref(false);
// a-upload 只负责选择文件；返回 false 阻止组件自行上传，内容读出后走技能接口
function beforeReferenceUpload(file: File) {
  void uploadReference(file);
  return false;
}
async function uploadReference(file: File) {
  if (!skill.value || uploadingReference.value || busy.value || saving.value || publishing.value) return;
  if (dirty.value || isNew.value) await save();
  if (dirty.value || isNew.value) return;
  uploadingReference.value = true;
  try {
    if (!/\.(md|txt)$/i.test(file.name)) throw new Error('参考资料仅支持 .md 或 .txt 文件');
    if (file.size > 120 * 1024) throw new Error('参考资料不能超过 120 KB');
    const content = await file.text();
    skill.value = await post<SkillDetail>(`/skills/${skill.value.id}/references`, {
      filename: file.name,
      content,
    });
    session.value = null;
    app.toast(`已添加参考资料 ${file.name}`);
    await refreshRevisions();
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    uploadingReference.value = false;
  }
}
// 拖放的文件不符合 accept 时组件会直接丢弃，这里补上同样的提示
function rejectReferenceFiles() {
  app.toast('参考资料仅支持 .md 或 .txt 文件', 'error');
}
function updateContent(value: string) {
  if (!skill.value) return;
  skill.value.content = value;
  dirty.value = true;
  try {
    syncMetadata();
    metadataError.value = '';
  } catch (err) {
    metadataError.value = (err as Error).message;
  }
  scheduleSave();
}
async function startSession(preserveMessages = false) {
  if (!skill.value) return;
  try {
    session.value = await post<SkillAuthoringSession>(`/skills/${skill.value.id}/authoring-sessions`);
    if (!preserveMessages) messages.value = session.value.messages ?? [];
  } catch (err) {
    app.toast((err as Error).message, 'error');
  }
}
function useStarterPrompt(text: string) {
  prompt.value = text;
  void nextTick(() => promptInput.value?.focus());
}
async function send() {
  if (
    !prompt.value.trim() ||
    busy.value ||
    saving.value ||
    publishing.value ||
    uploadingReference.value ||
    !skill.value
  )
    return;
  if (isNew.value && skill.value.name === '') {
    const title = prompt.value.trim().split('\n')[0]!.slice(0, 40);
    skill.value.content = updateSkillMetadata(skill.value.content, title, title, 'my-skill');
    dirty.value = true;
  }
  if (dirty.value || isNew.value) await save();
  if (dirty.value || isNew.value || saveError.value) return;
  busy.value = true;
  assistantChange.value = '';
  streamingText.value = '';
  const text = prompt.value;
  const previousRevision = skill.value.revision;
  const before = revisions.value.find((revision) => revision.id === skill.value?.currentRevisionId);
  prompt.value = '';
  try {
    if (!session.value) await startSession(true);
    if (!session.value || !skill.value) {
      if (!prompt.value) prompt.value = text;
      return;
    }
    messages.value.push({ id: `pending-${Date.now()}`, role: 'user', content: text });
    const response = await apiFetch(
      `/api/skills/${skill.value.id}/authoring-sessions/${session.value.id}/turns`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      },
    );
    if (!response.ok) throw new Error((await response.json()).message ?? '助手请求失败');
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const line = block.split('\n').find((item) => item.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.kind === 'message_delta') streamingText.value += String(event.payload?.text ?? '');
        else if (event.kind === 'error') throw new Error(event.payload?.message ?? 'Skill 助手执行失败');
      }
    }
    await loadSkill({ quiet: true });
    if (skill.value?.revision && skill.value.revision !== previousRevision) {
      assistantChange.value = '已更新 SKILL.md，尚未发布。';
      if (before)
        lastChange.value = { before, after: skill.value.content, afterId: skill.value.currentRevisionId };
    }
  } catch (err) {
    const message = (err as Error).message;
    if (skill.value) await loadSkill({ quiet: true });
    if (!prompt.value) prompt.value = text;
    app.toast(message, 'error');
  } finally {
    streamingText.value = '';
    busy.value = false;
  }
}

watch(
  () => route.params.id,
  () => {
    if (skill.value?.id === skillId.value && !isNew.value) return;
    void loadSkill();
  },
);
onMounted(() => {
  void loadSkill({ focusAssistant: route.query.start === 'generate' });
});
onBeforeRouteUpdate((to) => {
  if ((saving.value || busy.value || uploadingReference.value) && Number(to.params.id) !== skill.value?.id) {
    app.toast('请等待当前操作完成后再离开。', 'info');
    return false;
  }
  if (!dirty.value || Number(to.params.id) === skill.value?.id) return true;
  return confirm({ title: '当前草稿有未保存的修改，确定离开吗？', okText: '离开', cancelText: '留下' });
});
onBeforeRouteLeave(() => {
  if (saving.value || busy.value || uploadingReference.value) {
    app.toast('请等待当前操作完成后再离开。', 'info');
    return false;
  }
  if (!dirty.value) return true;
  return confirm({ title: '当前草稿有未保存的修改，确定离开吗？', okText: '离开', cancelText: '留下' });
});

const mode = ref<'preview' | 'source'>('preview');
const selectedFile = ref(-1);
const referenceContent = ref('');
const referenceLoading = ref(false);
const referenceError = ref('');
let referenceRequest = 0;
const treeOpen = ref(true);
const referencesOpen = ref(true);
const chatOpen = ref(true);
const mobilePanel = ref<'document' | 'chat'>('document');
const historyOpen = ref(false);
const infoOpen = ref(false);
const info = ref({ title: '', description: '', name: '' });
const infoError = ref('');
const metadataError = ref('');
const saveError = ref('');
const changesOpen = ref(false);
const lastChange = ref<{ before: SkillRevision; after: string; afterId: number | null } | null>(null);
const chatLog = ref<HTMLElement>();
const treeWidth = ref(210);
const chatWidth = ref(380);
const currentPath = computed(() =>
  selectedFile.value < 0
    ? 'SKILL.md'
    : `references/${skill.value?.referenceFiles[selectedFile.value]?.filename ?? ''}`,
);
const currentContent = computed(() =>
  selectedFile.value < 0 ? (skill.value?.content ?? '') : referenceContent.value,
);
const documentBody = computed(() => {
  if (selectedFile.value >= 0) return currentContent.value;
  try {
    return readSkillDocument(currentContent.value).body;
  } catch {
    return currentContent.value;
  }
});
const undoAvailable = computed(
  () =>
    lastChange.value &&
    skill.value?.currentRevisionId === lastChange.value.afterId &&
    !dirty.value &&
    !busy.value &&
    !saving.value,
);
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!busy.value) void save();
  }, 1200);
}
function syncMetadata() {
  if (!skill.value) return;
  const { data } = readSkillDocument(skill.value.content);
  skill.value.name = typeof data.title === 'string' ? data.title : skill.value.name || '未命名技能';
  skill.value.description = String(data.description);
}
function openInfo() {
  if (!skill.value) return;
  clearTimeout(saveTimer);
  try {
    const { data } = readSkillDocument(skill.value.content);
    info.value = {
      title: skill.value.name || '未命名技能',
      description: String(data.description),
      name: String(data.name),
    };
    infoError.value = '';
    infoOpen.value = true;
  } catch (err) {
    app.toast((err as Error).message, 'error');
  }
}
async function applyInfo() {
  if (!skill.value) return;
  try {
    updateContent(
      updateSkillMetadata(skill.value.content, info.value.title, info.value.description, info.value.name),
    );
    infoError.value = '';
    await save();
    if (!saveError.value) infoOpen.value = false;
  } catch (err) {
    infoError.value = (err as Error).message;
  }
}
async function closeInfo() {
  if (saving.value) return;
  const current = skill.value;
  if (
    current &&
    (info.value.title !== (current.name || '未命名技能') ||
      info.value.description !== current.description ||
      info.value.name !== String(readSkillDocument(current.content).data.name))
  ) {
    if (!(await confirm({ title: '放弃尚未应用的技能信息？', okText: '放弃修改' }))) return;
  }
  infoOpen.value = false;
}
async function selectFile(index: number) {
  selectedFile.value = index;
  const request = ++referenceRequest;
  referenceError.value = '';
  referenceContent.value = '';
  if (index < 0 || !skill.value) return;
  referenceLoading.value = true;
  try {
    const result = await api<{ content: string }>(
      `/skills/${skill.value.id}/references/${skill.value.currentRevisionId}/${index}`,
    );
    if (request === referenceRequest) referenceContent.value = result.content;
  } catch (err) {
    if (request === referenceRequest) referenceError.value = (err as Error).message;
  } finally {
    if (request === referenceRequest) referenceLoading.value = false;
  }
}
function onUnload(event: BeforeUnloadEvent) {
  if (dirty.value || saving.value || busy.value || uploadingReference.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
let stopDrag: (() => void) | undefined;
function resizePanel(event: PointerEvent, panel: 'tree' | 'chat') {
  event.preventDefault();
  stopDrag?.();
  const start = event.clientX;
  const initial = panel === 'tree' ? treeWidth.value : chatWidth.value;
  const move = (next: PointerEvent) => {
    const value = initial + (next.clientX - start) * (panel === 'tree' ? 1 : -1);
    if (panel === 'tree') treeWidth.value = Math.max(160, Math.min(300, value));
    else chatWidth.value = Math.max(300, Math.min(520, value));
  };
  stopDrag = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
  };
  const finish = () => stopDrag?.();
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish, { once: true });
}
watch([() => messages.value.length, streamingText], async () => {
  await nextTick();
  chatLog.value?.scrollTo({ top: chatLog.value.scrollHeight });
});
watch(
  () => route.params.id,
  () => {
    selectedFile.value = -1;
    lastChange.value = null;
    clearTimeout(saveTimer);
  },
);
onMounted(() => window.addEventListener('beforeunload', onUnload));
onBeforeUnmount(() => {
  clearTimeout(saveTimer);
  stopDrag?.();
  ++loadRequest;
  ++referenceRequest;
  window.removeEventListener('beforeunload', onUnload);
});
</script>

<template>
  <main class="skill-studio" :style="{ '--tree-width': `${treeWidth}px`, '--chat-width': `${chatWidth}px` }">
    <div v-if="loading" class="studio-loading"><a-spin size="small" />正在打开工作台…</div>
    <CatalogEmpty v-else-if="error && !skill" icon="book" title="无法打开技能" :description="error">
      <RouterLink to="/agent/skills">返回我的技能</RouterLink>
    </CatalogEmpty>
    <template v-else-if="skill">
      <header class="studio-topbar">
        <RouterLink to="/agent/skills" class="studio-back"
          ><Icon name="arrow-left-line" :size="16" /><span>我的技能</span></RouterLink
        >
        <span class="topbar-divider">/</span>
        <button
          class="studio-name"
          title="编辑技能信息"
          :disabled="busy || saving || uploadingReference"
          @click="openInfo"
        >
          {{ skill.name || '未命名技能' }}<Icon name="settings" :size="14" />
        </button>
        <span class="studio-status"
          >{{ skill.publishedVersion ? `已发布 v${skill.publishedVersion}` : '草稿'
          }}{{ skill.publishedVersion && (dirty || skill.status === 'draft') ? ' · 有新修改' : '' }}</span
        >
        <div class="topbar-actions">
          <span class="save-state" :class="{ failed: saveError }" role="status">{{ saveState }}</span>
          <a-button v-if="saveError" type="text" size="small" :loading="saving" @click="save"
            >重试保存</a-button
          >
          <a-button type="text" size="small" :disabled="isNew || busy || saving" @click="historyOpen = true"
            >历史</a-button
          >
          <a-button
            type="primary"
            size="small"
            :disabled="
              busy ||
              saving ||
              publishing ||
              uploadingReference ||
              !!metadataError ||
              (!isNew && !dirty && skill.status === 'published')
            "
            :loading="publishing"
            @click="requestPublish"
            >{{ skill.publishedVersion ? '发布新版本' : '发布' }}</a-button
          >
        </div>
      </header>
      <div v-if="saveError || metadataError" class="studio-error" role="alert">
        {{ saveError || metadataError }} · 修改仍保留在当前页面，请修正后重试。
      </div>
      <div class="studio-mobile-switch">
        <button :class="{ active: mobilePanel === 'document' }" @click="mobilePanel = 'document'">
          文件与内容
        </button>
        <button
          :class="{ active: mobilePanel === 'chat' }"
          @click="
            mobilePanel = 'chat';
            chatOpen = true;
          "
        >
          对话
        </button>
      </div>
      <div
        class="studio-workspace"
        :class="{ 'tree-hidden': !treeOpen, 'chat-hidden': !chatOpen, 'mobile-chat': mobilePanel === 'chat' }"
      >
        <aside v-if="treeOpen" class="studio-files" aria-label="技能文件">
          <header class="pane-header">
            <strong>文件</strong>
            <div>
              <a-upload
                accept=".md,.txt"
                :file-list="[]"
                :show-upload-list="false"
                :before-upload="beforeReferenceUpload"
                @reject="rejectReferenceFiles"
              >
                <button
                  class="icon-action"
                  title="上传参考资料（Markdown 或文本）"
                  aria-label="上传参考资料"
                  :disabled="busy || saving || uploadingReference"
                >
                  <Icon name="paperclip" :size="15" />
                </button>
              </a-upload>
              <button
                class="icon-action"
                aria-label="收起文件树"
                title="收起文件树"
                @click="treeOpen = false"
              >
                <Icon name="close" :size="14" />
              </button>
            </div>
          </header>
          <nav class="file-tree" aria-label="文件列表">
            <button
              :class="['file-row', { selected: selectedFile < 0 }]"
              :aria-current="selectedFile < 0 ? 'page' : undefined"
              @click="selectFile(-1)"
            >
              <Icon name="file" :size="16" /><span>SKILL.md</span><small v-if="assistantChange">已更新</small>
            </button>
            <button
              class="file-row folder-row"
              :aria-expanded="referencesOpen"
              @click="referencesOpen = !referencesOpen"
            >
              <span>{{ referencesOpen ? '⌄' : '›' }}</span><Icon name="folder-line" :size="15" /><span
                >references</span
              ><small>{{ skill.referenceFiles.length }}</small>
            </button>
            <template v-if="referencesOpen">
              <button
                v-for="(file, index) in skill.referenceFiles"
                :key="file.path"
                :class="['file-row', 'reference-row', { selected: selectedFile === index }]"
                :title="file.filename"
                @click="selectFile(index)"
              >
                <Icon name="file" :size="14" /><span>{{ file.filename }}</span>
              </button>
              <p v-if="!skill.referenceFiles.length" class="tree-empty">上传规范或素材，供助手参考</p>
            </template>
          </nav>
          <p class="files-note">主文档支持对话修改<br />参考资料只读</p>
        </aside>
        <div
          v-if="treeOpen"
          class="panel-resizer"
          role="separator"
          aria-label="调整文件区宽度"
          aria-orientation="vertical"
          tabindex="0"
          @pointerdown="resizePanel($event, 'tree')"
          @keydown.left.prevent="treeWidth = Math.max(160, treeWidth - 20)"
          @keydown.right.prevent="treeWidth = Math.min(300, treeWidth + 20)"
        />
        <section class="studio-document" aria-label="文件内容">
          <header class="pane-header document-header">
            <div>
              <button
                v-if="!treeOpen"
                class="icon-action"
                title="展开文件树"
                aria-label="展开文件树"
                @click="treeOpen = true"
              >
                <Icon name="folder-line" :size="16" /></button
              ><span class="file-path">{{ currentPath }}</span
              ><span v-if="selectedFile >= 0" class="readonly-label">只读</span>
            </div>
            <button
              v-if="!chatOpen"
              class="icon-action"
              title="展开助手"
              aria-label="展开助手"
              @click="
                chatOpen = true;
                mobilePanel = 'chat';
              "
            >
              <Icon name="sparkles" :size="16" />
            </button>
          </header>
          <div class="document-toolbar">
            <div class="view-switch" aria-label="内容展示方式">
              <button
                :class="{ active: mode === 'preview' }"
                :aria-pressed="mode === 'preview'"
                @click="mode = 'preview'"
              >
                预览
              </button>
              <button
                :class="{ active: mode === 'source' }"
                :aria-pressed="mode === 'source'"
                @click="mode = 'source'"
              >
                源码
              </button>
            </div>
            <span v-if="busy" class="document-hint">助手正在处理，主文档暂时只读</span
            ><span v-else-if="dirty" class="document-hint">等待自动保存…</span>
          </div>
          <div v-if="referenceLoading && selectedFile >= 0" class="studio-loading">
            <a-spin size="small" />读取文件…
          </div>
          <a-alert
            v-else-if="referenceError && selectedFile >= 0"
            type="error"
            :message="referenceError"
            show-icon
          />
          <div v-else-if="mode === 'preview'" class="document-preview">
            <div v-if="isNew && !dirty" class="document-empty">
              <Icon name="file" :size="28" />
              <h2>从一个想法开始</h2>
              <p>在右侧描述需求，助手会完善这份 Skill。</p>
              <button @click="mode = 'source'">直接编写 Markdown →</button>
            </div>
            <template v-else
              ><div v-if="selectedFile < 0" class="document-metadata">
                <h1>{{ skill.name || '未命名技能' }}</h1>
                <p>{{ skill.description }}</p>
              </div>
              <Markdown :text="documentBody"
            /></template>
          </div>
          <SkillSourceEditor
            v-else
            :model-value="currentContent"
            :readonly="selectedFile >= 0 || busy || saving || publishing || uploadingReference"
            @update:model-value="selectedFile < 0 && $event !== skill.content && updateContent($event)"
          />
        </section>
        <div
          v-if="chatOpen"
          class="panel-resizer"
          role="separator"
          aria-label="调整聊天区宽度"
          aria-orientation="vertical"
          tabindex="0"
          @pointerdown="resizePanel($event, 'chat')"
          @keydown.left.prevent="chatWidth = Math.min(520, chatWidth + 20)"
          @keydown.right.prevent="chatWidth = Math.max(300, chatWidth - 20)"
        />
        <aside v-if="chatOpen" class="studio-chat" aria-label="Skill 助手">
          <header class="pane-header">
            <strong class="chat-heading"><Icon name="sparkles" :size="16" />Skill 助手</strong>
            <div>
              <button
                class="icon-action"
                title="新建对话（保留当前草稿）"
                aria-label="新建对话"
                :disabled="busy || saving || isNew"
                @click="startSession()"
              >
                <Icon name="plus" :size="15" /></button
              ><button
                class="icon-action"
                title="收起助手"
                aria-label="收起助手"
                @click="
                  chatOpen = false;
                  mobilePanel = 'document';
                "
              >
                <Icon name="close" :size="14" />
              </button>
            </div>
          </header>
          <div ref="chatLog" class="chat-log" aria-live="polite">
            <div v-if="!messages.length && !busy" class="chat-empty">
              <h2>想{{ isNew ? '创建' : '修改' }}什么技能？</h2>
              <p>描述要求，我会更新草稿。发布由你确认。</p>
              <button v-for="text in starterPrompts.slice(0, 2)" :key="text" @click="useStarterPrompt(text)">
                {{ text }}
              </button>
            </div>
            <article v-for="message in messages" :key="message.id" :class="['chat-message', message.role]">
              <span class="message-role">{{ roleLabel(message.role) }}</span><Markdown
                :text="message.content"
              />
            </article>
            <article v-if="busy" class="chat-message assistant">
              <span class="message-role">助手</span
              ><Markdown v-if="streamingText" :text="streamingText" live /><span v-else class="thinking"
                ><a-spin size="small" />正在处理当前草稿…</span
              >
            </article>
            <div v-if="assistantChange && !busy" class="change-summary">
              <p>{{ assistantChange }}</p>
              <span>SKILL.md</span>
              <div>
                <button :disabled="!lastChange" @click="changesOpen = true">查看更改</button
                ><button :disabled="!undoAvailable" @click="lastChange && requestRestore(lastChange.before)">
                  撤销本次
                </button>
              </div>
            </div>
          </div>
          <form class="chat-composer" @submit.prevent="send">
            <a-textarea
              ref="promptInput"
              v-model:value="prompt"
              :auto-size="{ minRows: 3, maxRows: 8 }"
              :maxlength="8000"
              placeholder="描述你想创建或修改的内容…"
              aria-label="给 Skill 助手的要求"
              @keydown.ctrl.enter.prevent="send"
              @keydown.meta.enter.prevent="send"
            />
            <div>
              <span>{{ busy ? '完成后可继续发送' : 'Ctrl / ⌘ + Enter 发送' }}</span><a-button
                type="primary"
                size="small"
                html-type="submit"
                :loading="busy"
                :disabled="
                  !prompt.trim() || busy || saving || publishing || uploadingReference || !!metadataError
                "
                aria-label="发送"
                ><Icon name="arrow-up-line" :size="16"
              /></a-button>
            </div>
          </form>
        </aside>
      </div>
    </template>
    <a-modal
      :open="infoOpen"
      title="技能信息"
      ok-text="完成"
      cancel-text="取消"
      :confirm-loading="saving"
      :closable="!saving"
      :mask-closable="false"
      @ok="applyInfo"
      @cancel="closeInfo"
    >
      <a-form layout="vertical"
        ><a-form-item label="名称" required
          ><a-input v-model:value="info.title" :maxlength="120" :disabled="saving" /></a-form-item
        ><a-form-item label="用途说明" required
          ><a-textarea
            v-model:value="info.description"
            :rows="3"
            :maxlength="512"
            :disabled="saving" /></a-form-item
        ><a-form-item label="技能标识" extra="英文标识，对应 SKILL.md 中的 name；展示名称对应 title。"
          ><a-input v-model:value="info.name" :maxlength="64" :disabled="saving" /></a-form-item></a-form
      ><a-alert v-if="infoError || saveError" type="error" :message="infoError || saveError" show-icon />
    </a-modal>
    <a-drawer :open="historyOpen" title="版本历史" :width="480" @close="historyOpen = false"
      ><div v-for="revision in revisions" :key="revision.id" class="history-row">
        <strong
          >r{{ revision.revision }}
          {{ revision.publishedVersion ? `· v${revision.publishedVersion}` : '' }}</strong
        >
        <p>{{ revision.changeSummary }}</p>
        <small>{{ revisionSource(revision.source) }} · {{ formatDate(revision.createdAt) }}</small>
        <div>
          <a-button type="text" size="small" @click="previewRevision = revision">查看</a-button
          ><a-button
            type="text"
            size="small"
            :disabled="
              busy ||
              saving ||
              dirty ||
              publishing ||
              uploadingReference ||
              revision.id === skill?.currentRevisionId
            "
            @click="requestRestore(revision)"
            >恢复为草稿</a-button
          >
        </div>
      </div></a-drawer
    >
    <a-modal
      :open="!!previewRevision"
      title="修订内容"
      :width="800"
      :footer="null"
      @cancel="previewRevision = null"
      ><CodeBlock v-if="previewRevision" :code="previewRevision.content" lang="markdown"
    /></a-modal>
    <a-drawer :open="changesOpen" title="本次修改 · SKILL.md" :width="760" @close="changesOpen = false"
      ><template v-if="lastChange"
        ><h3>修改前 · r{{ lastChange.before.revision }}</h3>
        <CodeBlock :code="lastChange.before.content" lang="markdown" />
        <h3>修改后</h3>
        <CodeBlock :code="lastChange.after" lang="markdown" /></template
    ></a-drawer>
  </main>
</template>

<style scoped>
.skill-studio {
  flex: 1;
  min-height: 0;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--color-text-primary);
  background: var(--surface-content);
}
.studio-mobile-switch {
  display: none;
}
.studio-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 36px;
}
.studio-topbar {
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--border-default);
}
.studio-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-size: 13px;
  color: var(--color-text-secondary);
}
.studio-back:hover,
.studio-name:hover {
  color: var(--color-brand);
}
.topbar-divider {
  color: var(--color-text-tertiary);
}
.studio-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  max-width: 280px;
  text-align: left;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.studio-status,
.save-state {
  color: var(--color-text-tertiary);
  font-size: 12px;
}
.topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-shrink: 0;
}
.studio-error {
  padding: 8px 20px;
  color: var(--color-error);
  background: var(--color-error-bg);
  font-size: 12px;
}
.failed {
  color: var(--color-error);
}
.studio-workspace {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: grid;
  grid-template-columns: var(--tree-width) 1px minmax(280px, 1fr) 1px var(--chat-width);
}
.studio-workspace.tree-hidden {
  grid-template-columns: minmax(280px, 1fr) 1px var(--chat-width);
}
.studio-workspace.chat-hidden {
  grid-template-columns: var(--tree-width) 1px minmax(280px, 1fr);
}
.studio-workspace.tree-hidden.chat-hidden {
  grid-template-columns: minmax(0, 1fr);
}
.studio-files,
.studio-document,
.studio-chat {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pane-header {
  min-height: 44px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--border-default);
  font-size: 12px;
}
.pane-header > div {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.pane-header strong {
  font-weight: 600;
}
.icon-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--color-text-secondary);
  border-radius: 4px;
}
.icon-action:hover {
  background: var(--surface-shell);
  color: var(--color-brand);
}
.file-tree {
  flex: 1;
  overflow: auto;
  padding: 10px 6px;
}
.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  text-align: left;
  border-radius: 4px;
  font-size: 12px;
}
.file-row > span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.file-row svg {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
}
.file-row.selected {
  background: var(--color-brand-subtle);
  color: var(--color-brand-active);
}
.file-row.selected svg {
  color: var(--color-brand);
}
.file-row:hover:not(.selected) {
  background: var(--surface-shell);
}
.file-row small {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--color-text-tertiary);
  font-size: 10px;
}
.reference-row {
  padding-left: 28px;
}
.tree-empty,
.files-note {
  color: var(--color-text-tertiary);
  font-size: 11px;
  line-height: 1.8;
  padding: 10px;
}
.files-note {
  padding: 12px 16px;
  border-top: 1px solid var(--border-default);
}
.panel-resizer {
  background: var(--border-default);
  position: relative;
  cursor: col-resize;
  touch-action: none;
  z-index: 2;
}
.panel-resizer::after {
  content: '';
  position: absolute;
  inset: 0 -3px;
}
.panel-resizer:hover,
.panel-resizer:focus-visible {
  background: var(--color-brand);
}
.file-path {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.readonly-label {
  font-size: 10px;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}
.document-toolbar {
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--border-default);
  gap: 8px;
}
.view-switch {
  display: flex;
  align-self: stretch;
  gap: 18px;
}
.view-switch button {
  padding: 0 2px;
  font-size: 12px;
  color: var(--color-text-secondary);
  border-bottom: 2px solid transparent;
}
.view-switch button.active {
  color: var(--color-brand);
  border-bottom-color: var(--color-brand);
}
.document-hint {
  font-size: 11px;
  color: var(--color-text-tertiary);
}
.document-preview {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding: 32px clamp(20px, 4vw, 64px);
}
.document-metadata {
  margin-bottom: 28px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border-default);
}
.document-metadata h1 {
  font-size: 24px;
  margin: 0 0 10px;
}
.document-metadata p {
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.8;
}
.document-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 45vh;
  text-align: center;
  color: var(--color-text-tertiary);
  gap: 12px;
}
.document-empty h2 {
  color: var(--color-text-primary);
  font-size: 18px;
  font-weight: 500;
}
.document-empty p {
  font-size: 13px;
}
.document-empty button {
  color: var(--color-brand);
  font-size: 12px;
}
.chat-heading {
  display: flex;
  align-items: center;
  gap: 7px;
}
.chat-heading svg {
  color: var(--color-brand);
}
.chat-log {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 20px 18px;
}
.chat-empty {
  padding-top: clamp(20px, 12vh, 120px);
}
.chat-empty h2 {
  font-size: 16px;
  margin-bottom: 10px;
}
.chat-empty p {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.8;
  margin-bottom: 20px;
}
.chat-empty > button {
  display: block;
  width: 100%;
  padding: 10px 0;
  text-align: left;
  font-size: 12px;
  line-height: 1.8;
  color: var(--color-text-secondary);
  border-top: 1px solid var(--border-default);
}
.chat-empty > button:hover {
  color: var(--color-brand);
}
.chat-message {
  margin-bottom: 24px;
  overflow-wrap: anywhere;
  font-size: 13px;
}
.message-role {
  display: block;
  color: var(--color-text-tertiary);
  font-size: 11px;
  margin-bottom: 8px;
}
.chat-message.user {
  margin-left: 20px;
  padding: 12px 14px;
  background: var(--surface-shell);
  border-radius: 6px;
}
.chat-message :deep(.markdown-body) {
  font-size: 13px;
}
.thinking {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  color: var(--color-text-secondary);
  font-size: 12px;
}
.change-summary {
  border-left: 2px solid var(--color-brand);
  padding: 4px 0 4px 12px;
  font-size: 12px;
}
.change-summary p {
  margin-bottom: 8px;
}
.change-summary > span {
  color: var(--color-text-secondary);
  font-family: monospace;
}
.change-summary button {
  padding: 8px 12px 0 0;
  color: var(--color-brand);
  font-size: 12px;
}
.chat-composer {
  padding: 12px;
  border-top: 1px solid var(--border-default);
}
.chat-composer :deep(textarea.ant-input) {
  font-size: 13px;
  resize: none;
}
.chat-composer > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.chat-composer > div > span {
  color: var(--color-text-tertiary);
  font-size: 10px;
}
.history-row {
  padding: 16px 0;
  border-bottom: 1px solid var(--border-default);
  font-size: 13px;
}
.history-row p {
  margin: 6px 0;
}
.history-row small {
  color: var(--color-text-tertiary);
}
.history-row > div {
  margin-top: 8px;
}
@media (max-width: 1150px) {
  .studio-workspace {
    grid-template-columns: 160px 1px minmax(240px, 1fr) 1px 310px;
  }
  .studio-workspace.tree-hidden {
    grid-template-columns: minmax(240px, 1fr) 1px 310px;
  }
  .studio-status,
  .save-state {
    display: none;
  }
}
@media (max-width: 900px) {
  .studio-workspace {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .studio-mobile-switch {
    display: flex;
    gap: 16px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border-default);
  }
  .studio-mobile-switch button {
    padding: 10px 0;
    font-size: 12px;
    border-bottom: 2px solid transparent;
  }
  .studio-mobile-switch button.active {
    color: var(--color-brand);
    border-bottom-color: var(--color-brand);
  }
  .studio-files {
    max-height: 170px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border-default);
  }
  .files-note,
  .panel-resizer {
    display: none;
  }
  .studio-document {
    flex: 1;
    height: auto;
    min-height: 0;
  }
  .studio-chat {
    display: none;
    flex: 1;
    height: auto;
    min-height: 0;
    border-top: 1px solid var(--border-default);
  }
  .mobile-chat .studio-files,
  .mobile-chat .studio-document {
    display: none;
  }
  .mobile-chat .studio-chat {
    display: flex;
  }
  .studio-topbar {
    gap: 8px;
    padding-inline: 12px;
    flex-wrap: wrap;
  }
  .studio-name {
    max-width: 150px;
  }
  .document-hint {
    display: none;
  }
}
</style>
