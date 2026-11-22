<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import {
  isNavigationFailure,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from 'vue-router';
import { api, apiBlob, apiFetch, post, put, remove, saveBlob } from '../../api/client';
import Icon from '../../components/base/ForgeIcon.vue';
import CatalogEmpty from '../../components/catalog/CatalogEmpty.vue';
import Markdown from '../../components/markdown/MarkdownContent.vue';
import ProcessBlock from '../../components/message/ProcessBlock.vue';
import UserMessageText from '../../components/message/UserMessageText.vue';
import MarkdownPreview from '../../components/markdown/MarkdownPreview.vue';
import FilePreview from '../../components/file/FilePreview.vue';
import ChangeReview, { type ReviewFile } from '../../components/file/ChangeReview.vue';
import ModelSelect from '../../components/composer/ModelSelect.vue';
import { useCopy } from '../../utils/useCopy';
import MonacoEditor from '../../components/editor/MonacoEditor.vue';
import { loadMonaco } from '../../utils/monaco';
import { lexer } from 'marked';
import { readSkillDocument, updateSkillMetadata, initialSkillDocument } from '../../utils/skillDocument';
import { usePlatform } from '../../stores/platform';
import { PUBLIC_SPACE_ID, useSpace } from '../../stores/space';
import { confirm } from '../../utils/feedback';
import { deleteSkill, skillState, unpublishSkill } from '../../utils/skillLifecycle';
import {
  SKILL_FILE_DIRS,
  SKILL_MAIN_FILE,
  acceptFor,
  capacityError,
  editorLanguage,
  fileNameError,
  fileNameOf,
  initialFileContent,
  previewMarkdown,
  skillFileTree,
  suggestFileName,
  summarizeAssistantChanges,
  type AssistantFileChange,
  type SkillFileDir,
} from '../../utils/skillFiles';
import { formatBytes } from '../../utils/presentation';
import {
  fileDir,
  fileName,
  previewable,
  trialFileUrl,
  trialFilesUrl,
  trialRawUrl,
  type FileRef,
} from '../../utils/files';
import { buildTurns, type Turn } from '../../utils/turns';
import { useStickToBottom } from '../../utils/useStickToBottom';
import {
  applyAuthoringEvent,
  authoringChatMessages,
  authoringLiveTurn,
  emptyAuthoringLive,
} from '../../utils/skillAuthoring';
import type {
  SkillAuthoringMessage,
  SkillAuthoringSession,
  SkillDetail,
  SkillRevision,
} from '../../types/skill';

const route = useRoute();
const space = useSpace();
const router = useRouter();
const isNew = computed(() => !route.params.id);
const app = usePlatform();
const skill = ref<SkillDetail | null>(null);
let loadRequest = 0;
let creatingSkillNavigationId: number | null = null;
const revisions = ref<SkillRevision[]>([]);
const session = ref<SkillAuthoringSession | null>(null);
// 与工作台一致的模型选择：新对话用所选模型创建；已有对话从下一条消息起切换（只在两轮之间生效）
const authoringModelId = ref<number | null>(null);
const messages = ref<SkillAuthoringMessage[]>([]);
const loading = ref(true);
const saving = ref(false);
const publishing = ref(false);
// 正在下线或删除
const lifecycleBusy = ref(false);
const busy = ref(false);
const dirty = ref(false);
// 仅表示 Skill 无法打开（整页状态）；保存、发布等操作结果统一走全局 toast。
const error = ref('');
const prompt = ref('');
// 本轮进行中的思考、正文与工具调用；结算的回复和工具结果直接追加到 messages（与工作台一致）
const live = reactive(emptyAuthoringLive());
// 本轮用户消息已加入列表、正在等待或接收助手输出（busy 还包括发送前的保存与建会话）
const streaming = ref(false);
// 本轮已被助手接手（收到第一条事件，含排队）：发送按钮换成「中止执行」，与工作台一致
const turnStarted = ref(false);
// 消息已显示、正在保存草稿或启动编写会话（首轮约 1–2 秒），服务端尚未受理：显示「正在准备…」
const preparing = ref(false);
// 未受理就失败的消息：保留在对话里标为「发送失败」，内容已放回输入框；下次发送时移除
const failedMessageId = ref<string | null>(null);
const stopping = ref(false);
let stopRequested = false;
const assistantChange = ref('');
// 本轮排队等待并发额度的位次；0 表示未排队。
const queuePosition = ref(0);
type WorkbenchApproval = {
  ticketId: string;
  tool: string;
  arguments?: Record<string, unknown>;
  reason?: string;
};
const approvals = ref<WorkbenchApproval[]>([]);
const approvalBusy = ref<string | null>(null);
// 对话按轮展示（与工作台相同）：用户消息 + 过程块（思考、工具调用、中间说明）+ 最终回答
const turns = computed(() =>
  buildTurns(authoringChatMessages(messages.value), authoringLiveTurn(live, streaming.value)),
);
/** 过程块是否处于进行中：运行中且最终回答尚未开始流式输出 */
/** 过程块之后的正文是否正在流式输出（过程块头部据此显示「正在回复」） */
function answerStreaming(turn: Turn) {
  return turn.running && turn.answer.some((step) => step.live);
}
/** 运行中、但没有过程块可承载进度提示时（尚无输出，或回答已结束、等待后续）显示等待提示 */
function turnWaiting(turn: Turn) {
  return turn.running && !turn.process.length && !turn.answer.some((step) => step.live);
}
const previewRevision = ref<SkillRevision | null>(null);
const { copied: revisionCopied, copy: copyRevision } = useCopy();
const promptInput = ref<{ focus: () => void } | null>(null);

const skillId = computed(() => Number(route.params.id));
const canPublish = computed(() =>
  Boolean(
    !isNew.value &&
    skill.value &&
    skill.value.status === 'draft' &&
    !dirty.value &&
    !fileDirty.value &&
    !saving.value &&
    !busy.value &&
    !publishing.value,
  ),
);
const saveState = computed(() => {
  if (saveError.value) return '保存失败';
  if (saving.value || savingFile.value) return '保存中…';
  // 新 Skill 保存到当前空间（名称不能与本空间、公共空间的 Skill 重名）
  if (isNew.value) return `尚未保存 · 将放入「${space.current.name}」`;
  if (dirty.value || fileDirty.value) return '有未保存修改';
  return skill.value?.updatedAt ? `已保存 · ${formatDate(skill.value.updatedAt)}` : '草稿已保存';
});
function revisionSource(source: string) {
  if (source === 'assistant') return '助手更新';
  if (source === 'publish') return '正式发布';
  if (source === 'restore') return '恢复修订';
  return '手动编辑';
}
// 自然语言直接发给同一个工作台会话，助手自行选择编写、修改或试用。
// 点击只填入输入框不发送；新建时首行会作为临时名称，所以写成让用户接着补全的开头。
const starterPrompts = computed(() =>
  isNew.value
    ? ['我想把这项工作做成 Skill：', '帮我把下面这份流程整理成 Skill：']
    : [
        '帮我评审这个 Skill，按评分表指出问题，先不要修改。',
        '补充不适用的情况、需要找人确认的地方和输出样例。',
        '按当前草稿执行一次：我会给你具体任务，展示实际结果与问题。',
        '按我的要求修改：',
      ],
);

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
async function loadSkill(options: { focusAssistant?: boolean; quiet?: boolean } = {}) {
  const request = ++loadRequest;
  if (isNew.value) {
    skill.value = {
      id: 0,
      name: '',
      machineName: '',
      publishedMachineName: '',
      publishedName: '',
      publishedDescription: '',
      publishedFileCount: 0,
      description: '',
      status: 'draft',
      tags: [],
      currentRevisionId: null,
      publishedRevisionId: null,
      publishedVersion: null,
      revision: null,
      content: initialSkillDocument(),
      changeSummary: '',
      files: [],
      createdAt: null,
      updatedAt: null,
      publishedAt: null,
    };
    revisions.value = [];
    session.value = null;
    messages.value = [];
    dirty.value = false;
    error.value = '';
    saveError.value = '';
    metadataError.value = '';
    prompt.value = '';
    Object.assign(live, emptyAuthoringLive());
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
    // 附属信息并行读取，技能正文先显示，不必等待历史会话接口。
    const secondary = Promise.allSettled([
      api<{ items: SkillRevision[] }>(`/skills/${id}/revisions`),
      api<SkillAuthoringSession | null>(`/skills/${id}/authoring-session/latest`),
    ]);
    const detail = await api<SkillDetail>(`/skills/${id}`);
    if (request !== loadRequest) return;
    skill.value = detail;
    // 从链接打开别的空间的 Skill：自动切到它所在的空间（留在本页）
    if (detail.spaceId && detail.spaceId !== PUBLIC_SPACE_ID && detail.spaceId !== space.currentId)
      void space.follow(detail.spaceId, '（Skill 所在空间）');
    saveError.value = '';
    metadataError.value = '';
    if (!options.quiet) {
      revisions.value = [];
      session.value = null;
      messages.value = [];
    }
    dirty.value = false;
    const updateSecondary = async () => {
      const [revisionResult, sessionResult] = await secondary;
      if (request !== loadRequest || skill.value?.id !== id) return;
      if (revisionResult.status === 'fulfilled') revisions.value = revisionResult.value.items;
      if (sessionResult.status === 'fulfilled') {
        const latestSession = sessionResult.value;
        if (options.quiet) {
          // 服务端已分配正式消息 ID，直接替换本轮的临时消息。
          session.value = latestSession;
          messages.value = latestSession?.messages ?? [];
        } else if (!busy.value && !preparing.value && !session.value) {
          // 首次打开时恢复会话；发送过程中不让旧请求覆盖刚创建的新会话。
          session.value = latestSession;
          messages.value = latestSession?.messages ?? [];
        }
      }
      if (revisionResult.status === 'rejected' || sessionResult.status === 'rejected')
        app.toast('修订记录或历史会话暂时未能读取', 'error');
    };
    if (options.quiet) await updateSecondary();
    else void updateSecondary();
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
/** 保存当前所有未保存修改：先保存正在编辑的附加文件，再保存 SKILL.md。 */
async function save() {
  await saveFile();
  await saveDocument();
}
async function saveDocument() {
  if (
    !skill.value ||
    (!dirty.value && !isNew.value) ||
    saving.value ||
    busy.value ||
    publishing.value ||
    fileBusy.value
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
      // 创建成功但地址切换失败时，重试只切换地址，不能再次创建一份 Skill。
      const created = skill.value.id
        ? skill.value
        : await post<SkillDetail>('/skills', {
            name: skill.value.name.trim(),
            description: skill.value.description.trim(),
            content: skill.value.content,
          });
      skill.value = created;
      dirty.value = false;
      creatingSkillNavigationId = created.id;
      try {
        const failure = await router.replace(`/agent/skills/${created.id}`);
        if (isNavigationFailure(failure)) throw new Error('草稿已创建，但页面切换失败，请重试保存。');
      } finally {
        creatingSkillNavigationId = null;
      }
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
    // 助手会话保持不变：下一轮发送时服务端发现草稿已变化，会以最新草稿重启并接续同一段对话
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
  if (dirty.value || fileDirty.value || isNew.value) await save();
  if (!canPublish.value) return;
  const ok = await confirm(
    skill.value?.offline
      ? {
          title: '重新发布这个技能？',
          content: '将以当前草稿发布为新的正式版本，聊天和场景可以重新选用它。',
          okText: '确认发布',
        }
      : {
          title: '发布新的正式版本？',
          content: '将以当前草稿创建不可变版本。之后继续编辑会产生新的草稿，不会修改已发布版本。',
          okText: '确认发布',
        },
  );
  if (ok) await publish();
}
/** 当前状态的说明：草稿 / 已发布 vN / 已下线（曾发布 vN），之后有改动时追加「有新修改」 */
const statusText = computed(() => {
  if (!skill.value) return '';
  const state = skillState(skill.value);
  if (state === 'draft') return '草稿';
  const changed = dirty.value || state === 'changed' ? ' · 有新修改' : '';
  if (state === 'offline')
    return `已下线${skill.value.lastPublishedVersion ? `（曾发布 v${skill.value.lastPublishedVersion}）` : ''}`;
  return `已发布 v${skill.value.publishedVersion}${changed}`;
});
async function requestUnpublish() {
  if (!skill.value || lifecycleBusy.value) return;
  lifecycleBusy.value = true;
  try {
    const updated = await unpublishSkill(skill.value);
    if (!updated) return;
    skill.value = updated;
    app.toast('已下线，可以重新发布或删除');
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    lifecycleBusy.value = false;
  }
}
async function requestDelete() {
  if (!skill.value || lifecycleBusy.value) return;
  lifecycleBusy.value = true;
  try {
    if (!(await deleteSkill(skill.value))) return;
    app.toast('技能已删除');
    await router.replace('/agent/skills');
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    lifecycleBusy.value = false;
  }
}
async function publish() {
  if (!skill.value || publishing.value) return;
  publishing.value = true;
  try {
    skill.value = await post<SkillDetail>(`/skills/${skill.value.id}/publish`);
    app.toast(
      skill.value.publishedVersion
        ? `已发布 v${skill.value.publishedVersion}。聊天里新选用即为此版本，场景需重新发布后才会使用`
        : '已发布',
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
    fileDraft.value = null;
    previewRevision.value = null;
    lastChange.value = null;
    app.toast(`已将 r${revision.revision} 恢复为草稿`);
    await refreshRevisions();
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    saving.value = false;
  }
}
// —— 附加文件（references/、assets/、scripts/）——
// 正在新建、上传、保存或删除附加文件；期间不允许保存主文档或发送消息，避免修订交错。
const fileBusy = ref(false);
const savingFile = ref(false);
/** 修订内容不可变：按「修订 ID + 路径」缓存，切换文件或助手改完后只读取变化的部分。 */
const fileCache = reactive(new Map<string, string>());
const fileKey = (revisionId: number | null | undefined, path: string) => `${revisionId ?? 0}:${path}`;
/** 正在编辑的附加文件：path 与编辑中的内容；保存成功后清空。 */
const fileDraft = ref<{ path: string; content: string } | null>(null);
const fileDirty = computed(() => {
  const draft = fileDraft.value;
  if (!draft) return false;
  return draft.content !== fileCache.get(fileKey(skill.value?.currentRevisionId, draft.path));
});
const fileTree = computed(() => skillFileTree(skill.value?.files ?? []));
const openDirs = ref<Record<SkillFileDir, boolean>>({ references: true, assets: true, scripts: true });
/** 本轮助手改动过的文件（标 AI），发送下一条消息时清空。 */
const assistantFiles = ref<string[]>([]);
const fileDialog = ref({
  open: false,
  dir: 'references' as SkillFileDir,
  name: '',
  content: '',
  upload: false,
  error: '',
});
const fileDialogExists = computed(() =>
  Boolean(
    skill.value?.files.some(
      (file) => file.path === `${fileDialog.value.dir}/${fileDialog.value.name.trim()}`,
    ),
  ),
);

async function ensureSaved() {
  if (dirty.value || fileDirty.value || isNew.value) await save();
  return !(dirty.value || fileDirty.value || isNew.value || saveError.value);
}
function canEditFiles() {
  return Boolean(skill.value) && !busy.value && !saving.value && !publishing.value && !fileBusy.value;
}
function openNewFile(dir: SkillFileDir) {
  if (!canEditFiles()) return;
  openDirs.value[dir] = true;
  fileDialog.value = { open: true, dir, name: '', content: '', upload: false, error: '' };
}
// a-upload 只负责选择文件；返回 false 阻止组件自行上传，内容读出后走技能接口
function beforeFileUpload(dir: SkillFileDir) {
  return (file: File) => {
    void uploadFile(dir, file);
    return false;
  };
}
async function uploadFile(dir: SkillFileDir, file: File) {
  if (!canEditFiles()) return;
  const sizeError = capacityError([], '', file.size);
  if (sizeError) return app.toast(sizeError, 'error');
  let content: string;
  try {
    content = await file.text();
  } catch {
    return app.toast(`无法读取 ${file.name}`, 'error');
  }
  const name = suggestFileName(dir, file.name);
  const path = `${dir}/${name}`;
  // 文件名需要整理或与已有文件重名时，让用户确认最终名称
  if (!name || name !== file.name || skill.value?.files.some((item) => item.path === path)) {
    fileDialog.value = {
      open: true,
      dir,
      name,
      content,
      upload: true,
      error: name ? '' : '原文件名包含不支持的字符，请改成英文文件名',
    };
    return;
  }
  await writeFile(path, content, `上传文件：${path}`);
}
function rejectFiles(dir: SkillFileDir) {
  app.toast(`${dir}/ 只支持 ${acceptFor(dir).replaceAll(',', '、')} 文件`, 'error');
}
async function submitFileDialog() {
  const dialog = fileDialog.value;
  const name = dialog.name.trim();
  dialog.error = fileNameError(dialog.dir, name);
  if (dialog.error) return;
  if (fileDialogExists.value && !dialog.upload) {
    dialog.error = '已有同名文件';
    return;
  }
  const path = `${dialog.dir}/${name}`;
  const content = dialog.upload ? dialog.content : initialFileContent(path);
  if (await writeFile(path, content, dialog.upload ? `上传文件：${path}` : `新建文件：${path}`)) {
    dialog.open = false;
    if (!dialog.upload) mode.value = 'source';
  }
}
/** 新建、上传或覆盖一个附加文件，成功后选中它。 */
async function writeFile(path: string, content: string, summary: string) {
  if (!skill.value || !canEditFiles()) return false;
  const limit = capacityError(skill.value.files, path, new Blob([content]).size);
  if (limit) {
    app.toast(limit, 'error');
    return false;
  }
  if (!(await ensureSaved())) return false;
  fileBusy.value = true;
  try {
    const detail = await put<SkillDetail>(`/skills/${skill.value.id}/files`, {
      path,
      content,
      change_summary: summary,
    });
    fileCache.set(fileKey(detail.currentRevisionId, path), content);
    skill.value = detail;
    app.toast(`已保存 ${path}`);
    await selectFile(path);
    await refreshRevisions().catch(() => undefined);
    return true;
  } catch (err) {
    app.toast((err as Error).message, 'error');
    return false;
  } finally {
    fileBusy.value = false;
  }
}
/** 保存正在编辑的附加文件（自动保存与 Ctrl+S 共用）。 */
async function saveFile() {
  const draft = fileDraft.value;
  if (!skill.value || !draft || !fileDirty.value || savingFile.value || busy.value || publishing.value)
    return;
  clearTimeout(saveTimer);
  savingFile.value = true;
  fileBusy.value = true;
  saveError.value = '';
  const { path, content } = draft;
  try {
    const detail = await put<SkillDetail>(`/skills/${skill.value.id}/files`, {
      path,
      content,
      change_summary: `编辑文件：${path}`,
    });
    fileCache.set(fileKey(detail.currentRevisionId, path), content);
    // 保留主文档里尚未保存的修改
    skill.value = dirty.value ? { ...detail, content: skill.value.content } : detail;
    if (fileDraft.value?.path === path && fileDraft.value.content === content) fileDraft.value = null;
    await refreshRevisions().catch(() => undefined);
  } catch (err) {
    saveError.value = (err as Error).message;
  } finally {
    savingFile.value = false;
    fileBusy.value = false;
  }
  if (fileDirty.value && !saveError.value) scheduleSave();
}
function updateFileDraft(value: string) {
  const path = selectedPath.value;
  if (path === SKILL_MAIN_FILE || value === currentContent.value) return;
  fileDraft.value = { path, content: value };
  scheduleSave();
}
async function requestDeleteFile(path: string) {
  if (!skill.value || !canEditFiles()) return;
  const ok = await confirm({
    title: `删除 ${path}？`,
    content: 'SKILL.md 中引用这个文件的地方需要同步修改。删除会生成新的草稿修订，可以在版本历史中恢复。',
    okText: '删除',
    danger: true,
  });
  if (!ok || !(await ensureSaved())) return;
  fileBusy.value = true;
  try {
    skill.value = await remove(`/skills/${skill.value.id}/files?path=${encodeURIComponent(path)}`);
    if (fileDraft.value?.path === path) fileDraft.value = null;
    app.toast(`已删除 ${path}`);
    await refreshRevisions().catch(() => undefined);
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    fileBusy.value = false;
  }
}

// ---------- 试用文件：本次对话的会话工作区（试用产出、脚本输出 outputs/），不属于 Skill、不随发布 ----------
const trialFiles = ref<FileRef[]>([]);
const trialOpen = ref(true);
const trialBusy = ref('');
const trialPreview = ref<FileRef | null>(null);
let trialRequest = 0;
/** 按所在目录分组，最近更新的目录在前；脚本输出目录名形如 parse-20261122-101530 */
const trialGroups = computed(() => {
  const groups = new Map<string, { dir: string; files: FileRef[]; latest: string }>();
  for (const file of trialFiles.value) {
    const dir = fileDir(file.path);
    const group = groups.get(dir) ?? { dir, files: [], latest: '' };
    group.files.push(file);
    if ((file.modifiedAt ?? '') > group.latest) group.latest = file.modifiedAt ?? '';
    groups.set(dir, group);
  }
  return [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest) || a.dir.localeCompare(b.dir));
});
async function loadTrialFiles(refresh = false) {
  const current = session.value;
  if (!skill.value || !current) {
    trialFiles.value = [];
    return;
  }
  const request = ++trialRequest;
  try {
    const result = await api<{ items: FileRef[] }>(trialFilesUrl(skill.value.id, current.id, refresh));
    if (request === trialRequest && session.value?.id === current.id) trialFiles.value = result.items;
  } catch (err) {
    if (refresh && request === trialRequest) app.toast((err as Error).message, 'error');
  }
}
// 切换或新建对话时换成该对话的试用文件
watch(
  () => session.value?.id,
  () => {
    trialPreview.value = null;
    void loadTrialFiles();
  },
);
function trialUrl(path: string) {
  return trialRawUrl(skill.value?.id ?? 0, session.value?.id ?? 0, path);
}
function openTrialFile(file: FileRef) {
  if (previewable(file)) trialPreview.value = file;
  else void downloadTrialFile(file);
}
async function downloadTrialFile(file: FileRef) {
  trialBusy.value = file.path;
  try {
    saveBlob(await apiBlob(trialUrl(file.path)), fileName(file.path));
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    trialBusy.value = '';
  }
}
/** 存入 Skill 的目标目录：脚本放 scripts/，其余优先作为模板样例放 assets/ */
function trialTargetDir(path: string): SkillFileDir | null {
  const name = fileName(path).toLowerCase();
  const fits = (dir: SkillFileDir) =>
    SKILL_FILE_DIRS.find((item) => item.dir === dir)!.extensions.some((ext) => name.endsWith(ext));
  return (['scripts', 'assets', 'references'] as const).find(fits) ?? null;
}
/** 把试用文件存入 Skill：沿用上传流程（文件名整理、重名确认、容量校验），生成新的草稿修订 */
async function saveTrialToSkill(file: FileRef) {
  const dir = trialTargetDir(file.path);
  if (!dir || !canEditFiles()) return;
  trialBusy.value = file.path;
  try {
    const blob = await apiBlob(trialUrl(file.path));
    openDirs.value[dir] = true;
    await uploadFile(dir, new File([blob], fileName(file.path)));
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    trialBusy.value = '';
  }
}
async function deleteTrialFile(file: FileRef) {
  if (!skill.value || !session.value || busy.value) return;
  const ok = await confirm({
    title: `删除试用文件 ${fileName(file.path)}？`,
    content: '只删除本次对话工作区中的这个文件，不影响 Skill 文件。删除后无法恢复。',
    okText: '删除',
    danger: true,
  });
  if (!ok || !skill.value || !session.value) return;
  trialBusy.value = file.path;
  try {
    await remove(trialFileUrl(skill.value.id, session.value.id, file.path));
    trialFiles.value = trialFiles.value.filter((item) => item.path !== file.path);
    if (trialPreview.value?.path === file.path) trialPreview.value = null;
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    trialBusy.value = '';
  }
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
/** 对话当前实际使用且仍可用的模型；对话跟随平台默认时为默认模型，原模型已停用时为 null */
const sessionModelId = computed(() =>
  session.value?.model?.available ? (session.value.model.modelId ?? null) : null,
);
/** 对话原模型已停用：提示从下一条消息起改用所选模型 */
const staleModelName = computed(() =>
  session.value?.model && !session.value.model.available
    ? session.value.model.modelName || session.value.model.model
    : '',
);
function availableModel(id: number | null | undefined) {
  return id != null && app.modelOptions.some((option) => option.id === id) ? id : null;
}
function preferredModel(id: number | null) {
  return availableModel(id) ?? availableModel(app.defaultModelId) ?? app.modelOptions[0]?.id ?? null;
}
// 打开或切换对话、对话模型变化时，选择框回到对话当前模型
watch(
  () => [session.value?.id ?? null, sessionModelId.value] as const,
  () => (authoringModelId.value = preferredModel(sessionModelId.value)),
  { immediate: true },
);
// 可选模型变化（启停、删除、改默认）：只在当前选择失效时重新选择，不打断用户的切换
watch(
  () => [app.modelOptions, app.defaultModelId] as const,
  () => {
    if (availableModel(authoringModelId.value) === null)
      authoringModelId.value = preferredModel(sessionModelId.value);
  },
);
function refreshModels() {
  void app.refreshModelOptions().catch(() => {});
}
async function startSession(keep: SkillAuthoringMessage[] = []) {
  if (!skill.value) return;
  try {
    const modelId = availableModel(authoringModelId.value);
    session.value = await post<SkillAuthoringSession>(
      `/skills/${skill.value.id}/authoring-sessions`,
      modelId !== null ? { modelId } : undefined,
    );
    // keep：发送时已先显示的本轮消息，新会话的历史读回后仍排在最后
    messages.value = [...(session.value.messages ?? []), ...keep];
  } catch (err) {
    app.toast((err as Error).message, 'error');
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
/** 与工作台一致：把消息以 Markdown 引用块追加到输入框末尾 */
function quoteMessage(text: string) {
  const quote = text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  prompt.value = `${prompt.value.trimEnd()}${prompt.value.trim() ? '\n\n' : ''}${quote}\n\n`;
  void nextTick(() => promptInput.value?.focus());
}
function useStarterPrompt(text: string) {
  prompt.value = text;
  void nextTick(() => promptInput.value?.focus());
}
const canSend = computed(
  () =>
    !!prompt.value.trim() &&
    !!skill.value &&
    !busy.value &&
    !preparing.value &&
    !saving.value &&
    !publishing.value &&
    !fileBusy.value &&
    !metadataError.value,
);
function onPromptKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (canSend.value) void send();
}
async function send() {
  if (!canSend.value || !skill.value) return;
  const text = prompt.value;
  const pendingId = `pending-${Date.now()}`;
  // 先把消息显示出来（「正在准备…」）、清空输入框；保存草稿与启动会话在后台进行
  if (failedMessageId.value)
    messages.value = messages.value.filter((message) => message.id !== failedMessageId.value);
  failedMessageId.value = null;
  prompt.value = '';
  chatStick.value = true;
  messages.value.push({ id: pendingId, role: 'user', content: text });
  preparing.value = true;
  streaming.value = true;
  let accepted = false;
  /** 未受理：消息标为「发送失败」，文字放回输入框（输入框已有新内容时不覆盖） */
  const markFailed = () => {
    const failedId = `failed-${pendingId}`;
    messages.value = messages.value.filter(
      (message) => !String(message.id).startsWith(pendingId) && message.id !== failedId,
    );
    messages.value.push({ id: failedId, role: 'user', content: text });
    failedMessageId.value = failedId;
    if (!prompt.value) prompt.value = text;
  };
  if (isNew.value && skill.value.name === '') {
    const title = text.trim().split('\n')[0]!.slice(0, 40);
    skill.value.content = updateSkillMetadata(skill.value.content, title, title, 'my-skill');
    dirty.value = true;
  }
  if (!(await ensureSaved()) || !skill.value) {
    markFailed();
    preparing.value = false;
    streaming.value = false;
    return;
  }
  busy.value = true;
  turnStarted.value = false;
  stopRequested = false;
  assistantChange.value = '';
  assistantFiles.value = [];
  const changes: AssistantFileChange[] = [];
  Object.assign(live, emptyAuthoringLive());
  queuePosition.value = 0;
  approvals.value = [];
  // 本轮流式追加的消息使用临时 ID（以 pendingId 开头），结束后由服务端记录替换
  let liveSeq = 0;
  const nextId = () => `${pendingId}-${++liveSeq}`;
  const previousRevision = skill.value.revision;
  const before = revisions.value.find((revision) => revision.id === skill.value?.currentRevisionId);
  try {
    if (!session.value)
      await startSession(messages.value.filter((message) => String(message.id).startsWith(pendingId)));
    if (!session.value || !skill.value) return; // 在 finally 中标为「发送失败」
    // 所选模型与对话当前模型不同时随本条消息切换；服务端校验失败则本条不受理
    const switchTo = availableModel(authoringModelId.value);
    const modelId = switchTo !== null && switchTo !== sessionModelId.value ? switchTo : undefined;
    const response = await apiFetch(
      `/api/skills/${skill.value.id}/authoring-sessions/${session.value.id}/turns`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, ...(modelId !== undefined ? { modelId } : {}) }),
      },
    );
    if (!response.ok) throw new Error((await response.json()).message ?? '助手请求失败');
    accepted = true;
    preparing.value = false;
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
        turnStarted.value = true;
        if (applyAuthoringEvent(live, messages.value, event, nextId)) {
          queuePosition.value = 0;
        } else if (event.kind === 'queued') {
          queuePosition.value = Number(event.payload?.position ?? 0);
        } else if (event.kind === 'dequeued') {
          queuePosition.value = 0;
        } else if (event.kind === 'approval_required') {
          approvals.value.push(event.payload as WorkbenchApproval);
        } else if (event.kind === 'approval_resolved') {
          approvals.value = approvals.value.filter((item) => item.ticketId !== event.payload?.ticketId);
        } else if (event.kind === 'trial_files') {
          void loadTrialFiles();
        } else if (event.kind === 'skill_revision' && event.payload?.path) {
          changes.push({ action: event.payload.action ?? 'update_draft', path: String(event.payload.path) });
        } else if (event.kind === 'error') throw new Error(event.payload?.message ?? 'Skill 助手执行失败');
      }
    }
    await loadSkill({ quiet: true });
    void loadTrialFiles();
    if (skill.value?.revision && skill.value.revision !== previousRevision) {
      const summary = summarizeAssistantChanges(changes);
      assistantChange.value = summary.text || '已更新草稿，尚未发布。';
      assistantFiles.value = summary.written;
      if (before)
        lastChange.value = {
          before,
          after: skill.value.content,
          afterId: skill.value.currentRevisionId,
          files: { written: summary.written, deleted: summary.deleted },
        };
    }
  } catch (err) {
    const message = (err as Error).message;
    if (skill.value) await loadSkill({ quiet: true });
    void loadTrialFiles();
    // 用户主动中止：消息已发出并保留在对话里，不回填输入框，也不当作错误提示
    if (!stopRequested) {
      if (!prompt.value) prompt.value = text;
      app.toast(message, 'error');
    }
  } finally {
    // 请求失败或历史读取失败时也不能把临时消息永远留在列表里。
    messages.value = messages.value.filter((message) => !String(message.id).startsWith(pendingId));
    // 未受理的失败（含上面重新读取历史之后）：仍在对话里显示「发送失败」
    if (!accepted && !stopRequested) markFailed();
    preparing.value = false;
    Object.assign(live, emptyAuthoringLive());
    streaming.value = false;
    queuePosition.value = 0;
    approvals.value = [];
    turnStarted.value = false;
    busy.value = false;
  }
}

/** 中止当前这一轮（与工作台「中止执行」一致）；已输出的内容保留在对话里。 */
async function stop() {
  if (!skill.value || !session.value || !turnStarted.value || stopping.value) return;
  stopping.value = true;
  stopRequested = true;
  try {
    await post(`/skills/${skill.value.id}/authoring-sessions/${session.value.id}/interrupt`);
  } catch (err) {
    stopRequested = false;
    app.toast((err as Error).message, 'error');
  } finally {
    stopping.value = false;
  }
}

async function decideApproval(ticketId: string, action: 'approve' | 'deny') {
  if (!skill.value || !session.value) return;
  approvalBusy.value = ticketId;
  try {
    await post(
      `/skills/${skill.value.id}/authoring-sessions/${session.value.id}/approvals/${ticketId}/resolve`,
      { action },
    );
    approvals.value = approvals.value.filter((item) => item.ticketId !== ticketId);
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    approvalBusy.value = null;
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
  // 与技能详情请求同时加载，编辑器挂载时复用同一加载任务。
  void loadMonaco().catch(() => {});
  if (!app.modelOptions.length) refreshModels();
  void loadSkill({ focusAssistant: route.query.start === 'generate' });
});
function isCreatingSkillNavigation(to: { path: string }) {
  return creatingSkillNavigationId !== null && to.path === `/agent/skills/${creatingSkillNavigationId}`;
}
onBeforeRouteUpdate((to) => {
  if (
    isCreatingSkillNavigation(to) ||
    (skill.value &&
      (Number(to.params.id) === skill.value.id || to.path === `/agent/skills/${skill.value.id}`))
  ) {
    return true;
  }
  if (
    (saving.value || busy.value || preparing.value || fileBusy.value) &&
    Number(to.params.id) !== skill.value?.id
  ) {
    app.toast('请等待当前操作完成后再离开。', 'info');
    return false;
  }
  if ((!dirty.value && !fileDirty.value) || Number(to.params.id) === skill.value?.id) return true;
  return confirm({ title: '当前草稿有未保存的修改，确定离开吗？', okText: '离开', cancelText: '留下' });
});
onBeforeRouteLeave((to) => {
  if (
    isCreatingSkillNavigation(to) ||
    (skill.value &&
      (Number(to.params.id) === skill.value.id || to.path === `/agent/skills/${skill.value.id}`))
  ) {
    return true;
  }
  if (saving.value || busy.value || preparing.value || fileBusy.value) {
    app.toast('请等待当前操作完成后再离开。', 'info');
    return false;
  }
  if (!dirty.value && !fileDirty.value) return true;
  return confirm({ title: '当前草稿有未保存的修改，确定离开吗？', okText: '离开', cancelText: '留下' });
});

const mode = ref<'preview' | 'source'>('source');
const selectedPath = ref<string>(SKILL_MAIN_FILE);
const isMainFile = computed(() => selectedPath.value === SKILL_MAIN_FILE);
const sourceOpened = ref(true);
const previewPane = ref<HTMLElement>();
const previewScroll = new Map<string, number>();
const fileContent = ref('');
const fileLoading = ref(false);
const fileError = ref('');
let fileRequest = 0;
const treeOpen = ref(true);
const chatOpen = ref(true);
const mobilePanel = ref<'document' | 'chat'>('document');
const historyOpen = ref(false);
const infoOpen = ref(false);
const info = ref({ title: '', description: '', name: '' });
const infoError = ref('');
const metadataError = ref('');
const saveError = ref('');
const changesOpen = ref(false);
const lastChange = ref<{
  before: SkillRevision;
  after: string;
  afterId: number | null;
  files: { written: string[]; deleted: string[] };
} | null>(null);
const chatLog = ref<HTMLElement>();
// 跟随最新：与工作台相同，只有用户自己往上翻才停止，内容高度变化时自动贴底
const {
  stick: chatStick,
  onScroll: trackChatScroll,
  follow: followChat,
  jumpToLatest: jumpChatToLatest,
} = useStickToBottom(chatLog);
const treeWidth = ref(240);
const chatWidth = ref(380);
const totalFiles = computed(() => 1 + (skill.value?.files.length ?? 0));
const currentPath = computed(() => selectedPath.value);
/** 附加文件读取中或读取失败：编辑器只读，内容区显示状态 */
const fileUnavailable = computed(() => !isMainFile.value && (fileLoading.value || !!fileError.value));
const currentContent = computed(() => {
  if (isMainFile.value) return skill.value?.content ?? '';
  const draft = fileDraft.value;
  return draft && draft.path === selectedPath.value ? draft.content : fileContent.value;
});
const documentBody = computed(() => {
  if (!isMainFile.value) return previewMarkdown(selectedPath.value, currentContent.value);
  try {
    return readSkillDocument(currentContent.value).body;
  } catch {
    return currentContent.value;
  }
});
const needsDocumentTitle = computed(
  () =>
    isMainFile.value &&
    !lexer(documentBody.value).some((token) => token.type === 'heading' && token.depth === 1),
);
const previewContent = computed(() =>
  needsDocumentTitle.value
    ? `# ${skill.value?.name || '未命名技能'}\n\n${documentBody.value}`
    : documentBody.value,
);
watch(
  [currentPath, mode, fileLoading],
  async ([path, view, loading], [previousPath, previousView, wasLoading]) => {
    if (previewPane.value && previousView === 'preview' && !wasLoading) {
      previewScroll.set(previousPath, previewPane.value.scrollTop);
    }
    await nextTick();
    if (previewPane.value && view === 'preview' && !loading) {
      previewPane.value.scrollTop = previewScroll.get(path) ?? 0;
    }
  },
);
/** 本次修改的逐文件对比：SKILL.md 直接用修改前后的正文，其他文件按修改前后两个修订读取 */
const reviewFiles = ref<ReviewFile[]>([]);
const reviewMode = ref<'unified' | 'split'>('unified');
async function revisionFile(skillId: number, revisionId: number, path: string) {
  const key = fileKey(revisionId, path);
  const cached = fileCache.get(key);
  if (cached !== undefined) return cached;
  const result = await api<{ content: string }>(
    `/skills/${skillId}/files/${revisionId}?path=${encodeURIComponent(path)}`,
  );
  fileCache.set(key, result.content);
  return result.content;
}
function openChanges() {
  const change = lastChange.value;
  const skillId = skill.value?.id;
  if (!change || !skillId) return;
  const afterId = change.afterId ?? skill.value?.currentRevisionId ?? null;
  const existed = new Set(change.before.files.map((file) => file.path));
  const files: ReviewFile[] = [];
  if (change.before.content !== change.after || change.files.written.includes(SKILL_MAIN_FILE))
    files.push({
      path: SKILL_MAIN_FILE,
      action: 'modified',
      load: async () => ({ before: change.before.content, after: change.after }),
    });
  for (const path of change.files.written) {
    if (path === SKILL_MAIN_FILE) continue;
    files.push({
      path,
      action: existed.has(path) ? 'modified' : 'added',
      load: async () => {
        if (!afterId) throw new Error('修改后的版本不存在');
        const [before, after] = await Promise.all([
          existed.has(path) ? revisionFile(skillId, change.before.id, path) : '',
          revisionFile(skillId, afterId, path),
        ]);
        return { before, after };
      },
    });
  }
  for (const path of change.files.deleted)
    if (existed.has(path))
      files.push({
        path,
        action: 'deleted',
        load: async () => ({ before: await revisionFile(skillId, change.before.id, path), after: '' }),
      });
  reviewFiles.value = files;
  changesOpen.value = true;
}
function undoFromChanges() {
  if (!lastChange.value) return;
  changesOpen.value = false;
  void requestRestore(lastChange.value.before);
}
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
function closeInfo() {
  if (saving.value) return;
  infoOpen.value = false;
}
async function selectFile(path: string) {
  // 切换前先保存正在编辑的附加文件，保存失败时留在原文件
  if (fileDraft.value && fileDraft.value.path !== path) {
    await saveFile();
    if (fileDirty.value) return;
  }
  selectedPath.value = path;
  await loadFileContent();
}
async function loadFileContent() {
  const path = selectedPath.value;
  const request = ++fileRequest;
  fileError.value = '';
  if (path === SKILL_MAIN_FILE || !skill.value) {
    fileLoading.value = false;
    return;
  }
  const revisionId = skill.value.currentRevisionId;
  const key = fileKey(revisionId, path);
  if (fileCache.has(key)) {
    fileContent.value = fileCache.get(key)!;
    fileLoading.value = false;
    return;
  }
  fileContent.value = '';
  fileLoading.value = true;
  try {
    const result = await api<{ content: string }>(
      `/skills/${skill.value.id}/files/${revisionId}?path=${encodeURIComponent(path)}`,
    );
    fileCache.set(key, result.content);
    if (request === fileRequest) fileContent.value = result.content;
  } catch (err) {
    if (request === fileRequest) fileError.value = (err as Error).message;
  } finally {
    if (request === fileRequest) fileLoading.value = false;
  }
}
// 修订变化（助手修改、恢复版本、其他文件保存）后：选中的文件被删除就回到 SKILL.md，否则按新修订重新读取
watch(
  () => [skill.value?.currentRevisionId, skill.value?.files] as const,
  () => {
    if (isMainFile.value || !skill.value) return;
    if (!skill.value.files.some((file) => file.path === selectedPath.value)) {
      if (fileDraft.value?.path === selectedPath.value) fileDraft.value = null;
      selectedPath.value = SKILL_MAIN_FILE;
      return;
    }
    void loadFileContent();
  },
);
function onUnload(event: BeforeUnloadEvent) {
  if (dirty.value || fileDirty.value || saving.value || busy.value || fileBusy.value) {
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
watch(
  [() => messages.value.length, () => live.text, () => live.reasoning, () => live.tools.length],
  async () => {
    await nextTick();
    followChat();
  },
);
watch(
  () => route.params.id,
  () => {
    chatStick.value = true;
    selectedPath.value = SKILL_MAIN_FILE;
    fileDraft.value = null;
    fileCache.clear();
    assistantFiles.value = [];
    lastChange.value = null;
    clearTimeout(saveTimer);
  },
);
onMounted(() => window.addEventListener('beforeunload', onUnload));
onBeforeUnmount(() => {
  clearTimeout(saveTimer);
  stopDrag?.();
  ++loadRequest;
  ++fileRequest;
  window.removeEventListener('beforeunload', onUnload);
});
</script>

<template>
  <main
    class="skill-studio"
    :style="skill ? { '--tree-width': `${treeWidth}px`, '--chat-width': `${chatWidth}px` } : {}"
  >
    <div v-if="loading" class="studio-loading"><a-spin size="small" />正在打开工作台…</div>
    <CatalogEmpty v-else-if="error && !skill" icon="book" title="无法打开技能" :description="error">
      <RouterLink to="/agent/skills">返回我的技能</RouterLink>
    </CatalogEmpty>
    <template v-else-if="skill">
      <header class="studio-topbar">
        <RouterLink to="/agent/skills" class="studio-back"
          ><Icon name="ri-arrow-go-back-fill" :size="16" /><span>我的技能</span></RouterLink
        >
        <span class="topbar-divider">/</span>
        <button
          class="studio-name"
          title="编辑技能信息"
          :disabled="busy || saving || fileBusy"
          @click="openInfo"
        >
          {{ skill.name || '未命名技能' }}<Icon name="settings" :size="14" />
        </button>
        <span class="studio-status">{{ statusText }}</span>
        <div class="topbar-actions">
          <span class="save-state" :class="{ failed: saveError }" role="status">{{ saveState }}</span>
          <a-button v-if="saveError" type="text" size="small" :loading="saving" @click="save"
            >重试保存</a-button
          >
          <a-button type="text" size="small" :disabled="isNew || busy || saving" @click="historyOpen = true"
            >历史</a-button
          >
          <a-button
            v-if="!isNew && skill.publishedRevisionId != null"
            type="text"
            size="small"
            danger
            :disabled="busy || saving || publishing || fileBusy"
            :loading="lifecycleBusy"
            title="撤下线上版本：聊天和场景从下一条消息起不再使用，历史版本保留"
            @click="requestUnpublish"
            >下线</a-button
          >
          <a-button
            v-if="!isNew && skill.offline"
            type="text"
            size="small"
            danger
            :disabled="busy || saving || publishing || fileBusy || dirty || fileDirty"
            :loading="lifecycleBusy"
            title="永久删除这个已下线的技能"
            @click="requestDelete"
            >删除</a-button
          >
          <a-button
            type="primary"
            :disabled="
              busy ||
              saving ||
              publishing ||
              lifecycleBusy ||
              fileBusy ||
              !!metadataError ||
              (!isNew && !dirty && skill.status === 'published')
            "
            :loading="publishing"
            @click="requestPublish"
          >
            <template #icon><Icon name="bolt" :size="14" /></template>
            {{ skill.publishedVersion ? '发布新版本' : skill.offline ? '重新发布' : '发布' }}
          </a-button>
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
          <nav class="skill-file-tree" aria-label="文件列表">
            <button
              :class="['file-row', { selected: isMainFile }]"
              :aria-current="isMainFile ? 'page' : undefined"
              @click="selectFile(SKILL_MAIN_FILE)"
            >
              <Icon name="file" :size="16" /><span>SKILL.md</span
              ><small v-if="assistantFiles.includes(SKILL_MAIN_FILE)">已更新</small>
            </button>
            <template v-for="folder in fileTree" :key="folder.dir">
              <div class="folder-line">
                <button
                  class="file-row folder-row"
                  :aria-expanded="openDirs[folder.dir]"
                  :title="folder.hint"
                  @click="openDirs[folder.dir] = !openDirs[folder.dir]"
                >
                  <span class="folder-caret">{{ openDirs[folder.dir] ? '⌄' : '›' }}</span><Icon
                    name="folder-line"
                    :size="15"
                  /><span>{{ folder.dir }}</span
                  ><small v-if="folder.files.length" class="folder-count">{{ folder.files.length }}</small>
                </button>
                <div class="folder-actions">
                  <button
                    class="icon-action"
                    :title="`在 ${folder.dir}/ 新建文件`"
                    :aria-label="`在 ${folder.dir} 新建文件`"
                    :disabled="isNew || busy || saving || publishing || fileBusy"
                    @click="openNewFile(folder.dir)"
                  >
                    <Icon name="add-line" :size="14" />
                  </button>
                  <a-upload
                    :accept="acceptFor(folder.dir)"
                    :file-list="[]"
                    :show-upload-list="false"
                    :disabled="isNew || busy || saving || publishing || fileBusy"
                    :before-upload="beforeFileUpload(folder.dir)"
                    @reject="rejectFiles(folder.dir)"
                  >
                    <button
                      class="icon-action"
                      :title="`上传到 ${folder.dir}/（${acceptFor(folder.dir)}）`"
                      :aria-label="`上传到 ${folder.dir}`"
                      :disabled="isNew || busy || saving || publishing || fileBusy"
                    >
                      <Icon name="paperclip" :size="14" />
                    </button>
                  </a-upload>
                </div>
              </div>
              <template v-if="openDirs[folder.dir]">
                <div v-for="file in folder.files" :key="file.path" class="file-line">
                  <button
                    :class="['file-row', 'reference-row', { selected: selectedPath === file.path }]"
                    :aria-current="selectedPath === file.path ? 'page' : undefined"
                    :title="`${file.path} · ${formatBytes(file.bytes)}`"
                    @click="selectFile(file.path)"
                  >
                    <Icon name="file" :size="14" /><span>{{ fileNameOf(file.path) }}</span
                    ><small
                      v-if="assistantFiles.includes(file.path)"
                      class="file-ai-tag"
                      title="本轮由助手写入"
                      >AI</small
                    >
                  </button>
                  <button
                    class="icon-action file-delete"
                    :title="`删除 ${file.path}`"
                    :aria-label="`删除 ${file.path}`"
                    :disabled="busy || saving || publishing || fileBusy"
                    @click="requestDeleteFile(file.path)"
                  >
                    <Icon name="delete-bin-line" :size="13" />
                  </button>
                </div>
                <p v-if="!folder.files.length" class="tree-empty folder-empty">{{ folder.hint }}</p>
              </template>
            </template>
          </nav>
          <section v-if="session" class="trial-files" aria-label="试用文件">
            <div class="folder-line">
              <button
                class="file-row folder-row"
                :aria-expanded="trialOpen"
                title="本次对话中试用、运行脚本产生的文件，不属于 Skill，不随发布"
                @click="trialOpen = !trialOpen"
              >
                <span class="folder-caret">{{ trialOpen ? '⌄' : '›' }}</span><Icon
                  name="folder-line"
                  :size="15"
                /><span>试用文件 · 本次对话</span
                ><small v-if="trialFiles.length" class="folder-count">{{ trialFiles.length }}</small>
              </button>
              <div class="folder-actions">
                <button
                  class="icon-action"
                  title="刷新试用文件"
                  aria-label="刷新试用文件"
                  @click="loadTrialFiles(true)"
                >
                  <Icon name="refresh-line" :size="14" />
                </button>
              </div>
            </div>
            <template v-if="trialOpen">
              <template v-for="group in trialGroups" :key="group.dir">
                <p v-if="group.dir" class="trial-dir" :title="group.dir">{{ group.dir }}/</p>
                <div v-for="file in group.files" :key="file.path" class="file-line trial-line">
                  <button
                    class="file-row reference-row"
                    :title="`${file.path} · ${formatBytes(file.bytes)}${previewable(file) ? '' : ' · 点击下载'}`"
                    :disabled="trialBusy === file.path"
                    @click="openTrialFile(file)"
                  >
                    <Icon name="file" :size="14" /><span>{{ fileName(file.path) }}</span>
                  </button>
                  <div class="trial-actions">
                    <button
                      class="icon-action"
                      :title="`下载 ${fileName(file.path)}`"
                      :aria-label="`下载 ${file.path}`"
                      :disabled="trialBusy === file.path"
                      @click="downloadTrialFile(file)"
                    >
                      <Icon name="download" :size="13" />
                    </button>
                    <button
                      v-if="trialTargetDir(file.path)"
                      class="icon-action"
                      :title="`存入 Skill 的 ${trialTargetDir(file.path)}/`"
                      :aria-label="`把 ${file.path} 存入 Skill`"
                      :disabled="isNew || busy || saving || publishing || fileBusy || trialBusy === file.path"
                      @click="saveTrialToSkill(file)"
                    >
                      <Icon name="save-line" :size="13" />
                    </button>
                    <button
                      class="icon-action"
                      :title="`删除 ${fileName(file.path)}`"
                      :aria-label="`删除试用文件 ${file.path}`"
                      :disabled="busy || trialBusy === file.path"
                      @click="deleteTrialFile(file)"
                    >
                      <Icon name="delete-bin-line" :size="13" />
                    </button>
                  </div>
                </div>
              </template>
              <p v-if="!trialFiles.length" class="tree-empty folder-empty">
                试用和运行脚本的产出会出现在这里
              </p>
            </template>
          </section>
          <div class="files-footer">
            <span class="files-count">共 {{ totalFiles }} 个文件</span>
          </div>
          <p class="files-note">助手可读写全部文件<br />业务会话中只读</p>
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
              ><button
                v-if="!isMainFile"
                class="icon-action"
                :title="`删除 ${currentPath}`"
                :aria-label="`删除 ${currentPath}`"
                :disabled="busy || saving || publishing || fileBusy"
                @click="requestDeleteFile(currentPath)"
              >
                <Icon name="delete-bin-line" :size="14" />
              </button>
            </div>
            <div class="document-actions">
              <span v-if="busy" class="readonly-label">助手正在修改</span>
              <div class="view-switch" role="group" aria-label="内容展示方式">
                <button
                  type="button"
                  :class="{ active: mode === 'preview' }"
                  :aria-pressed="mode === 'preview'"
                  @click="mode = 'preview'"
                >
                  预览
                </button>
                <button
                  type="button"
                  :class="{ active: mode === 'source' }"
                  :aria-pressed="mode === 'source'"
                  @click="mode = 'source'"
                >
                  编辑
                </button>
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
            </div>
          </header>
          <div v-if="fileLoading && !isMainFile" class="studio-loading"><a-spin size="small" />读取文件…</div>
          <a-alert v-else-if="fileError && !isMainFile" type="error" :message="fileError" show-icon />
          <div v-show="mode === 'preview' && !fileUnavailable" ref="previewPane" class="document-preview">
            <div v-if="isNew && !dirty" class="document-empty">
              <Icon name="file" :size="28" />
              <h2>从一个想法开始</h2>
              <p>在右侧描述需求，助手会完善这份 Skill。</p>
              <button @click="mode = 'source'">直接编辑 →</button>
            </div>
            <template v-else>
              <MarkdownPreview :content="previewContent" />
            </template>
          </div>
          <div v-if="sourceOpened" v-show="mode === 'source' && !fileUnavailable" class="document-source">
            <MonacoEditor
              :model-value="currentContent"
              :model-key="currentPath"
              :language="editorLanguage(currentPath)"
              theme="vs-dark"
              :active="mode === 'source' && !fileUnavailable"
              :loading="fileUnavailable"
              :read-only="busy || saving || publishing || (fileBusy && !savingFile)"
              aria-label="Skill 文件编辑"
              @shortcut-save="save"
              @update:model-value="
                isMainFile ? $event !== skill.content && updateContent($event) : updateFileDraft($event)
              "
            />
          </div>
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
                :disabled="busy || preparing || saving || isNew"
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
          <div ref="chatLog" class="chat-log process-host" aria-live="polite" @scroll="trackChatScroll">
            <div v-if="!messages.length && !busy" class="chat-empty">
              <h2>想{{ isNew ? '创建' : '修改' }}什么技能？</h2>
              <p>
                {{
                  isNew
                    ? '说说这项工作平时怎么做，我会先问几个关键问题再起草。发布由你确认。'
                    : '告诉我想修改什么，或给我一个具体任务试用当前草稿。发布由你确认。'
                }}
              </p>
              <button v-for="text in starterPrompts" :key="text" @click="useStarterPrompt(text)">
                {{ text }}
              </button>
            </div>
            <template v-for="turn in turns" :key="turn.key">
              <div v-if="turn.user" class="chat-user">
                <article class="chat-message user">
                  <UserMessageText :text="turn.user.content" />
                </article>
                <div v-if="turn.key === failedMessageId" class="message-send-failed" role="alert">
                  <Icon name="info" :size="14" />发送失败，内容已放回输入框
                </div>
                <div class="message-action-bar" aria-label="用户消息操作">
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
                    aria-label="引用消息"
                    title="引用到输入框"
                    @click="quoteMessage(turn.user.content)"
                  >
                    <Icon name="ri-chat-1-line" :size="16" />
                  </button>
                </div>
              </div>
              <article v-if="turn.steps.length || turn.running" class="chat-message assistant">
                <div class="assistant-label">
                  <span class="assistant-icon"><Icon name="sparkles" :size="14" /></span>助手
                </div>
                <ProcessBlock
                  v-if="turn.process.length"
                  :steps="turn.process"
                  :active="turn.running"
                  :waiting="approvals.length > 0"
                  :writing="answerStreaming(turn)"
                />
                <section v-for="step in turn.answer" :key="step.key" class="step-text">
                  <Markdown :text="step.text" :live="step.live" /><span
                    v-if="step.live"
                    class="stream-cursor"
                  ></span>
                </section>
                <div
                  v-if="!turn.running && turn.answer.some((step) => step.text)"
                  class="message-action-bar"
                  aria-label="助手回复操作"
                >
                  <span v-if="turn.answer.some((step) => step.partial)" class="message-partial"
                    >执行未完成时保留的部分输出</span
                  >
                  <button
                    type="button"
                    aria-label="复制回复"
                    title="复制回复"
                    @click="copyMessage(turn.answer.map((step) => step.text).join('\n\n'))"
                  >
                    <Icon name="ri-file-copy-line" :size="16" />
                  </button>
                </div>
                <div v-if="turnWaiting(turn)" class="agent-working compact" role="status">
                  <span class="thinking-dots"><i></i><i></i><i></i></span
                  ><span>{{
                    preparing
                      ? '正在准备…'
                      : queuePosition
                        ? `排队中 · 第 ${queuePosition} 位，等待执行额度…`
                        : turn.steps.length
                          ? '正在继续…'
                          : '正在处理当前草稿…'
                  }}</span>
                </div>
              </article>
            </template>
            <div v-if="assistantChange && !busy" class="change-summary">
              <p>{{ assistantChange }}</p>
              <span>SKILL.md</span>
              <div>
                <button :disabled="!lastChange" @click="openChanges">查看更改</button
                ><button :disabled="!undoAvailable" @click="lastChange && requestRestore(lastChange.before)">
                  撤销本次
                </button>
              </div>
            </div>
          </div>
          <div v-if="!chatStick && messages.length" class="chat-jump-anchor">
            <button type="button" class="jump-to-latest" @click="jumpChatToLatest">
              <Icon name="arrowDown" :size="14" />回到最新
            </button>
          </div>
          <div v-for="approval in approvals" :key="approval.ticketId" class="skill-approval" role="alert">
            <strong>{{ approval.tool }} · 等待确认</strong>
            <p>{{ approval.reason || '执行此操作需要你确认。' }}</p>
            <pre>{{ JSON.stringify(approval.arguments ?? {}, null, 2) }}</pre>
            <div>
              <button
                type="button"
                :disabled="!!approvalBusy"
                @click="decideApproval(approval.ticketId, 'deny')"
              >
                拒绝
              </button>
              <button
                type="button"
                :disabled="!!approvalBusy"
                @click="decideApproval(approval.ticketId, 'approve')"
              >
                允许本次
              </button>
            </div>
          </div>
          <form class="chat-composer" @submit.prevent="send">
            <div class="composer-box">
              <a-textarea
                ref="promptInput"
                v-model:value="prompt"
                :auto-size="{ minRows: 2, maxRows: 6 }"
                :maxlength="8000"
                placeholder="描述想创建、修改或试用的内容…"
                aria-label="给 Skill 助手的要求"
                @keydown="onPromptKeydown"
              />
              <div class="composer-actions">
                <div class="composer-tools">
                  <a-upload
                    :accept="acceptFor('references')"
                    :file-list="[]"
                    :show-upload-list="false"
                    :disabled="isNew || busy || saving || publishing || fileBusy"
                    :before-upload="beforeFileUpload('references')"
                    @reject="rejectFiles('references')"
                  >
                    <button
                      type="button"
                      class="composer-attach"
                      :disabled="isNew || busy || saving || publishing || fileBusy"
                      :title="isNew ? '创建技能后可添加参考资料' : '把 Markdown 或文本资料添加到 references/'"
                      aria-label="添加参考资料"
                    >
                      <Icon name="paperclip" :size="18" />
                    </button>
                  </a-upload>
                  <ModelSelect
                    v-model="authoringModelId"
                    :disabled="busy || preparing || streaming"
                    :stale-name="staleModelName"
                    @opened="refreshModels"
                  />
                </div>
                <button
                  v-if="busy && turnStarted"
                  type="button"
                  class="stop-button"
                  :disabled="stopping"
                  aria-label="中止执行"
                  title="中止执行"
                  @click="stop"
                >
                  <span aria-hidden="true"></span>
                </button>
                <a-button
                  v-else
                  class="task-send"
                  type="primary"
                  shape="circle"
                  html-type="submit"
                  :loading="busy || preparing"
                  :disabled="!canSend && !busy && !preparing"
                  aria-label="发送"
                  title="发送 · Enter"
                >
                  <Icon v-if="!busy && !preparing" name="ri-arrow-up-line" :size="18" />
                </a-button>
              </div>
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
    <a-drawer :open="historyOpen" title="版本历史" :width="480" @close="historyOpen = false">
      <div v-if="!revisions.length" class="history-empty">暂无版本记录</div>
      <div v-else class="history-list">
        <div v-for="revision in revisions" :key="revision.id" class="history-row">
          <div class="history-heading">
            <div class="history-identity">
              <strong>r{{ revision.revision }}</strong>
              <span v-if="revision.id === skill?.currentRevisionId" class="history-tag">当前</span>
              <span v-if="revision.publishedVersion" class="history-tag history-tag-published">
                发布 v{{ revision.publishedVersion }}
              </span>
            </div>
            <time class="history-time">{{ formatDate(revision.createdAt) }}</time>
          </div>
          <p class="history-summary">{{ revision.changeSummary }}</p>
          <div class="history-footer">
            <span class="history-source">{{ revisionSource(revision.source) }}</span>
            <div class="history-actions">
              <a-button type="text" size="small" @click="previewRevision = revision">查看</a-button>
              <a-button
                v-if="revision.id !== skill?.currentRevisionId"
                class="history-restore"
                type="text"
                size="small"
                :disabled="busy || saving || dirty || fileDirty || publishing || fileBusy"
                @click="requestRestore(revision)"
                >恢复为草稿</a-button
              >
            </div>
          </div>
        </div>
      </div>
    </a-drawer>
    <a-modal
      :open="!!previewRevision"
      :title="previewRevision ? `r${previewRevision.revision} · 版本内容` : '版本内容'"
      :width="840"
      :footer="null"
      class="history-preview-modal"
      @cancel="previewRevision = null"
    >
      <div v-if="previewRevision" class="history-preview">
        <div class="history-preview-header">
          <div class="history-preview-info">
            <span v-if="previewRevision.publishedVersion" class="history-tag history-tag-published">
              发布 v{{ previewRevision.publishedVersion }}
            </span>
            <span>{{ revisionSource(previewRevision.source) }}</span>
            <span>{{ formatDate(previewRevision.createdAt) }}</span>
          </div>
          <a-button type="text" size="small" @click="copyRevision(previewRevision.content)">
            {{ revisionCopied ? '已复制' : '复制源码' }}
          </a-button>
        </div>
        <p class="history-preview-summary">{{ previewRevision.changeSummary }}</p>
        <pre class="history-preview-content"><code>{{ previewRevision.content }}</code></pre>
      </div>
    </a-modal>
    <a-drawer
      :open="changesOpen"
      :title="lastChange ? `本次修改 · 对比 r${lastChange.before.revision}` : '本次修改'"
      :width="reviewMode === 'split' ? 'min(1240px, 96vw)' : 'min(920px, 96vw)'"
      class="skill-changes-drawer"
      destroy-on-close
      @close="changesOpen = false"
    >
      <ChangeReview v-if="reviewFiles.length" v-model:mode="reviewMode" :files="reviewFiles" />
      <p v-else class="text-diff-empty">这次没有文件内容变化。</p>
      <template #footer>
        <div class="skill-changes-footer">
          <a-button :disabled="!undoAvailable" @click="undoFromChanges">撤销本次</a-button>
          <a-button type="primary" @click="changesOpen = false">完成</a-button>
        </div>
      </template>
    </a-drawer>
    <a-modal
      v-model:open="fileDialog.open"
      :title="fileDialog.upload ? `上传到 ${fileDialog.dir}/` : `在 ${fileDialog.dir}/ 新建文件`"
      :ok-text="fileDialog.upload && fileDialogExists ? '覆盖' : '保存'"
      cancel-text="取消"
      :confirm-loading="fileBusy"
      :mask-closable="false"
      @ok="submitFileDialog"
    >
      <a-form layout="vertical" @submit.prevent="submitFileDialog"
        ><a-form-item
          label="文件名"
          :extra="`英文文件名，支持 ${acceptFor(fileDialog.dir).replaceAll(',', '、')}；记得在 SKILL.md 里写明什么时候读或用它。`"
          ><a-input
            v-model:value="fileDialog.name"
            :addon-before="`${fileDialog.dir}/`"
            :maxlength="120"
            :placeholder="fileDialog.dir === 'references' ? 'rules.md' : 'report-template.md'"
            :disabled="fileBusy"
            @change="fileDialog.error = ''"
        /></a-form-item>
      </a-form>
      <a-alert v-if="fileDialog.error" type="error" :message="fileDialog.error" show-icon />
      <a-alert
        v-else-if="fileDialog.upload && fileDialogExists"
        type="warning"
        message="已有同名文件，保存将覆盖它（旧内容可在版本历史中找回）。"
        show-icon
      />
    </a-modal>
    <FilePreview
      v-if="trialPreview && session"
      :key="trialPreview.path"
      :file="trialPreview"
      :raw-url="trialUrl(trialPreview.path)"
      @close="trialPreview = null"
    />
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
  background: var(--surface-content);
  border-bottom: none;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
  position: relative;
  z-index: 1;
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
  font-size: 13px;
}
.topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-shrink: 0;
}
.topbar-actions :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.topbar-actions :deep(.ant-btn > svg) {
  flex-shrink: 0;
}
.studio-error {
  padding: 8px 20px;
  color: var(--color-error);
  background: var(--color-error-bg);
  font-size: 13px;
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
  background: var(--surface-content);
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
.studio-files {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface-shell);
}
.studio-document {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface-content);
}
.studio-chat {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface-content);
}
.pane-header {
  min-height: 44px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: none;
  font-size: 13px;
  background: transparent;
}
.pane-header > div {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.pane-header strong {
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.02em;
}
.studio-files .pane-header {
  background: var(--surface-shell);
}
.studio-files .pane-header strong {
  color: var(--color-text-secondary);
  font-size: 13px;
}
.studio-chat .pane-header strong {
  color: var(--color-text-primary);
}
.icon-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--color-text-secondary);
  border-radius: 6px;
}
.icon-action:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--sidebar-nav-hover-text);
}
.skill-file-tree {
  display: block;
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
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
  border-radius: 6px;
  font-size: 14px;
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
  background: var(--sidebar-nav-active-bg);
  color: var(--sidebar-nav-active-text);
}
.file-row.selected svg {
  color: currentColor;
}
.file-row:hover:not(.selected) {
  background: var(--surface-hover);
  color: var(--color-text-primary);
}
.file-row small {
  margin-left: auto;
  flex-shrink: 0;
  min-width: 20px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-tertiary);
  font-size: 12px;
}
.folder-caret {
  width: 12px;
  text-align: center;
  color: var(--color-text-tertiary);
  font-size: 12px;
  flex-shrink: 0;
}
.folder-count {
  background: var(--surface-content);
  border: none;
  border-radius: 999px;
  padding: 2px 7px;
  min-width: 20px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.reference-row {
  padding-left: 28px;
}
/* 目录行与文件行：右侧操作按钮悬停或聚焦时出现，触屏设备始终显示 */
.folder-line,
.file-line {
  display: flex;
  align-items: center;
  gap: 2px;
}
.folder-line > .file-row,
.file-line > .file-row {
  flex: 1;
  min-width: 0;
}
.folder-actions {
  display: flex;
  flex-shrink: 0;
}
.folder-actions,
.file-delete {
  opacity: 0;
  transition: opacity 0.15s;
}
.folder-line:hover .folder-actions,
.folder-line:focus-within .folder-actions,
.file-line:hover .file-delete,
.file-line:focus-within .file-delete {
  opacity: 1;
}
@media (hover: none) {
  .folder-actions,
  .file-delete {
    opacity: 1;
  }
}
.file-delete {
  flex-shrink: 0;
}
.file-delete:hover:not(:disabled) {
  color: var(--color-danger-text);
}
.file-row small.file-ai-tag {
  min-width: 0;
  padding: 1px 5px;
  border-radius: 4px;
  font-weight: 600;
  color: var(--color-brand);
  background: var(--surface-shell);
}
.folder-empty {
  margin: 0;
  padding: 2px 10px 6px 28px;
}
/* 试用文件：本次对话的会话工作区，与上方 Skill 文件分隔，内容多时自身滚动 */
.trial-files {
  flex-shrink: 0;
  max-height: 40%;
  overflow: auto;
  margin: 0;
  padding: 8px 6px 10px;
  border-top: 1px solid var(--border-light);
}
.trial-dir {
  margin: 4px 0 0;
  padding: 2px 10px 2px 28px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text-tertiary);
  font-size: 12px;
  font-family: var(--font-mono, monospace);
}
.trial-actions {
  display: flex;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}
.trial-line:hover .trial-actions,
.trial-line:focus-within .trial-actions {
  opacity: 1;
}
@media (hover: none) {
  .trial-actions {
    opacity: 1;
  }
}
.skill-changes-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.tree-empty {
  color: var(--color-text-tertiary);
  font-size: 12px;
  line-height: 1.8;
  padding: 10px;
}
.files-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: var(--surface-shell);
  font-size: 12px;
  color: var(--color-text-tertiary);
  border-top: none;
}
.files-count {
  font-weight: 600;
  color: var(--color-text-secondary);
  white-space: nowrap;
}
.files-note-inline {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.files-note {
  display: none;
}
.panel-resizer {
  background: var(--border-light);
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
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-primary);
}
.readonly-label {
  font-size: 12px;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
  background: var(--surface-shell);
  padding: 2px 6px;
  border-radius: 4px;
}
.document-header {
  flex: 0 0 44px;
  border-bottom: 1px solid var(--border-light);
}
.document-header > div:first-child {
  flex: 1;
  overflow: hidden;
}
.document-actions {
  flex-shrink: 0;
}
.view-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--surface-content);
}
.view-switch button {
  padding: 3px 12px;
  line-height: 20px;
  font-size: 13px;
  color: var(--color-text-secondary);
  border-radius: 4px;
  background: transparent;
}
.view-switch button:hover:not(.active) {
  color: var(--color-text-primary);
  background: var(--surface-hover);
}
.view-switch button.active {
  color: var(--scenario-selection-text);
  background: var(--scenario-selection-bg);
  font-weight: 600;
}
.view-switch button:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
.document-preview {
  flex: 1;
  overflow: auto;
  min-height: 0;
  min-width: 0;
  padding: 28px 32px 48px;
  width: 100%;
}
.document-preview > .markdown-renderer {
  max-width: 820px;
  margin-left: auto;
  margin-right: auto;
  font-size: 15px;
}
.document-source {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
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
  padding: 32px;
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
  font-size: 13px;
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
/* 「回到最新」悬浮在消息区底部，不占位、不推动输入框 */
.chat-jump-anchor {
  position: relative;
  height: 0;
}
.chat-jump-anchor .jump-to-latest {
  top: auto;
  bottom: 10px;
  z-index: 2;
}
.chat-empty {
  text-align: center;
  padding-top: clamp(80px, 30vh, 260px);
}
.chat-empty h2 {
  font-size: 16px;
  margin-bottom: 10px;
}
.chat-empty p {
  font-size: 13px;
  color: var(--color-text-secondary);
  line-height: 1.8;
  margin-bottom: 20px;
}
.chat-empty > button {
  display: block;
  width: 100%;
  padding: 10px 0;
  text-align: left;
  font-size: 13px;
  line-height: 1.8;
  color: var(--color-text-secondary);
  border-top: none;
  background: var(--surface-shell);
  border-radius: 8px;
  margin-bottom: 8px;
  padding: 10px 12px;
}
.chat-empty > button:hover {
  color: var(--sidebar-nav-hover-text);
  background: var(--sidebar-nav-hover-bg);
}
.chat-message {
  margin-bottom: 20px;
  overflow-wrap: anywhere;
  font-size: 14px;
}
.assistant-label {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 9px;
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 600;
}
.assistant-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  color: var(--sidebar-nav-active-text);
  background: var(--sidebar-nav-active-bg);
}
.chat-user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  margin-bottom: 14px;
}
.chat-user > .chat-message.user {
  margin-bottom: 0;
}
.chat-message.assistant .message-action-bar {
  margin-top: 2px;
}
.chat-message.user {
  width: fit-content;
  max-width: calc(100% - 20px);
  margin-left: auto;
  padding: 6px 16px;
  background: var(--accent);
  color: #fff;
  border-radius: 10px;
  border: none;
  /* 与工作台一致：原样显示用户输入，超过 5 行收起（UserMessageText） */
  line-height: 1.75;
}
.chat-message :deep(.markdown-body) {
  color: var(--color-text-primary);
  font-size: 14px;
  line-height: 1.75;
}
.chat-message :deep(.markdown-body h1),
.chat-message :deep(.markdown-body h2),
.chat-message :deep(.markdown-body h3) {
  color: var(--color-text-primary);
}
.chat-message :deep(.markdown-body a) {
  color: var(--scenario-selection-text);
}
.chat-message.assistant .agent-working.compact {
  margin: 6px 0 0;
}
.change-summary {
  border-left: 2px solid var(--color-brand);
  padding: 8px 0 8px 12px;
  font-size: 13px;
  background: var(--surface-shell);
  border-radius: 0 8px 8px 0;
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
  font-size: 13px;
}
.skill-approval {
  flex-shrink: 0;
  margin: 0 12px 8px;
  padding: 12px;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  background: var(--surface-content);
  font-size: 13px;
}
.skill-approval p {
  margin: 6px 0;
  color: var(--color-text-secondary);
}
.skill-approval pre {
  max-height: 120px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 8px 0;
}
.skill-approval > div {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.skill-approval button {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-default);
  color: var(--color-text-primary);
  background: var(--surface-content);
  cursor: pointer;
}
.skill-approval button:last-child {
  border-color: var(--color-brand);
  color: var(--color-brand);
}
.skill-approval button:disabled {
  opacity: 0.5;
  cursor: wait;
}
.chat-composer {
  flex-shrink: 0;
  min-width: 0;
  padding: 10px 12px max(8px, env(safe-area-inset-bottom));
  background: var(--surface-content);
}
.composer-box {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  background: var(--surface-content);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
/* 大输入框聚焦只用一层主题色边框，不加外光晕（光晕在大圆角框上会像第二道边） */
.composer-box:focus-within {
  border-color: var(--border-focus);
}
.composer-box :deep(textarea.ant-input) {
  display: block;
  width: 100%;
  min-height: 0;
  padding: 11px 12px 4px;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  font-size: 14px;
  line-height: 1.6;
  resize: none;
  background: transparent;
}
.composer-box :deep(textarea.ant-input:focus) {
  box-shadow: none;
}
.composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 8px 8px;
}
.composer-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
/* 只显示图标，尺寸与工作台输入框的附件按钮一致；说明放在 title 提示中 */
.composer-attach {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 10px;
  color: var(--color-text-secondary);
}
.composer-attach:hover:not(:disabled) {
  color: var(--sidebar-nav-hover-text);
  background: var(--sidebar-nav-hover-bg);
}
.composer-attach:disabled {
  color: var(--color-text-tertiary);
  cursor: not-allowed;
}
.composer-attach:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
.history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: -8px;
}
.history-row {
  padding: 12px;
  border-radius: 8px;
  background: var(--surface-content);
  font-size: 14px;
  transition: background-color 0.15s;
}
.history-row:hover,
.history-row:focus-within {
  background: var(--surface-hover);
}
.history-heading,
.history-identity,
.history-footer,
.history-actions {
  display: flex;
  align-items: center;
}
.history-heading,
.history-footer {
  justify-content: space-between;
  gap: 12px;
}
.history-identity {
  min-width: 0;
  gap: 7px;
}
.history-identity strong {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.history-tag {
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--color-text-secondary);
  background: var(--surface-shell);
  font-size: 12px;
  white-space: nowrap;
}
.history-tag-published {
  color: var(--scenario-selection-text);
  background: var(--scenario-selection-bg);
}
.history-time,
.history-source {
  color: var(--color-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.history-summary {
  display: -webkit-box;
  margin: 8px 0 4px;
  overflow: hidden;
  color: var(--color-text-primary);
  line-height: 1.5;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.history-actions {
  flex-shrink: 0;
  gap: 2px;
}
.history-actions :deep(.ant-btn) {
  padding-inline: 6px;
  font-size: 12px;
}
.history-restore {
  opacity: 0;
  pointer-events: none;
}
.history-row:hover .history-restore,
.history-row:focus-within .history-restore {
  opacity: 1;
  pointer-events: auto;
}
.history-empty {
  padding: 32px 12px;
  text-align: center;
  color: var(--color-text-tertiary);
  font-size: 13px;
}
.history-preview {
  min-width: 0;
}
.history-preview-header,
.history-preview-info {
  display: flex;
  align-items: center;
}
.history-preview-header {
  justify-content: space-between;
  gap: 12px;
}
.history-preview-info {
  gap: 10px;
  color: var(--color-text-tertiary);
  font-size: 12px;
}
.history-preview-header :deep(.ant-btn) {
  flex-shrink: 0;
  color: var(--scenario-selection-text);
  font-size: 12px;
}
.history-preview-summary {
  margin: 6px 0 16px;
  color: var(--color-text-secondary);
  font-size: 13px;
}
.history-preview-content {
  box-sizing: border-box;
  max-height: min(65vh, 660px);
  margin: 0;
  padding: 20px 24px;
  overflow: auto;
  border-radius: 8px;
  background: var(--surface-shell);
  color: var(--color-text-primary);
  font-family: Consolas, 'SFMono-Regular', Menlo, monospace;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
.history-preview-content code {
  font: inherit;
}
@media (hover: none) {
  .history-restore {
    opacity: 1;
    pointer-events: auto;
  }
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
    background: var(--surface-shell);
    border-bottom: none;
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
  }
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
  .document-preview {
    padding: 20px 16px;
  }
}
</style>
