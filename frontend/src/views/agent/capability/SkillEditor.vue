<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { api, apiFetch, post, put } from '../../../api/client';
import Icon from '../../../components/ForgeIcon.vue';
import CatalogEmpty from '../../../components/catalog/CatalogEmpty.vue';
import CatalogFilter from '../../../components/catalog/CatalogFilter.vue';
import { usePlatform } from '../../../stores/platform';
import { confirm } from '../../../utils/feedback';
import type {
  SkillAuthoringMessage,
  SkillAuthoringSession,
  SkillDetail,
  SkillRevision,
} from '../../../types/skill';

type Panel = 'content' | 'references' | 'history';
const route = useRoute();
const app = usePlatform();
const skill = ref<SkillDetail | null>(null);
const revisions = ref<SkillRevision[]>([]);
const session = ref<SkillAuthoringSession | null>(null);
const messages = ref<SkillAuthoringMessage[]>([]);
const activePanel = ref<Panel>('content');
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
  Boolean(skill.value && skill.value.status === 'draft' && !dirty.value && !saving.value),
);
const saveState = computed(() => {
  if (saving.value) return '正在保存…';
  if (dirty.value) return '有未保存修改';
  return skill.value?.updatedAt ? `已保存 · ${formatDate(skill.value.updatedAt)}` : '草稿已保存';
});
const panelOptions = computed(() => [
  { value: 'content' as const, label: '内容' },
  { value: 'references' as const, label: '参考资料', count: skill.value?.referenceFiles?.length ?? 0 },
  { value: 'history' as const, label: '版本历史', count: revisions.value.length },
]);
const referenceKey = (file: { path: string }) => file.path;
const revisionKey = (revision: SkillRevision) => revision.id;
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
async function loadSkill(options: { focusAssistant?: boolean } = {}) {
  const id = skillId.value;
  if (!Number.isInteger(id) || id < 1) {
    skill.value = null;
    error.value = 'Skill 地址无效。';
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const [detail, revisionResult, latestSession] = await Promise.all([
      api<SkillDetail>(`/skills/${id}`),
      api<{ items: SkillRevision[] }>(`/skills/${id}/revisions`),
      api<SkillAuthoringSession | null>(`/skills/${id}/authoring-session/latest`),
    ]);
    skill.value = detail;
    revisions.value = revisionResult.items;
    session.value = latestSession;
    messages.value = latestSession?.messages ?? [];
    dirty.value = false;
    if (options.focusAssistant || route.query.start === 'generate') {
      await nextTick();
      promptInput.value?.focus();
    }
  } catch (err) {
    // 已打开的 Skill 刷新失败只提示一次，保留当前内容；首次打开失败才进入整页错误态。
    if (skill.value?.id === id) app.toast((err as Error).message, 'error');
    else {
      skill.value = null;
      error.value = (err as Error).message;
    }
  } finally {
    loading.value = false;
  }
}
async function refreshRevisions() {
  if (!skill.value) return;
  revisions.value = (await api<{ items: SkillRevision[] }>(`/skills/${skill.value.id}/revisions`)).items;
}
async function save() {
  if (!skill.value || !dirty.value || saving.value) return;
  saving.value = true;
  try {
    skill.value = await put<SkillDetail>(`/skills/${skill.value.id}/draft`, {
      content: skill.value.content,
      change_summary: '手动编辑草稿',
    });
    dirty.value = false;
    await refreshRevisions();
  } catch (err) {
    app.toast((err as Error).message, 'error');
  } finally {
    saving.value = false;
  }
}
async function requestPublish() {
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
  try {
    skill.value = await post<SkillDetail>(`/skills/${skill.value.id}/revisions/${revision.id}/restore`);
    dirty.value = false;
    activePanel.value = 'content';
    previewRevision.value = null;
    app.toast(`已将 r${revision.revision} 恢复为草稿`);
    await refreshRevisions();
  } catch (err) {
    app.toast((err as Error).message, 'error');
  }
}
const uploadingReference = ref(false);
// a-upload 只负责选择文件；返回 false 阻止组件自行上传，内容读出后走技能接口
function beforeReferenceUpload(file: File) {
  void uploadReference(file);
  return false;
}
async function uploadReference(file: File) {
  if (!skill.value || uploadingReference.value) return;
  uploadingReference.value = true;
  try {
    if (!/\.(md|txt)$/i.test(file.name)) throw new Error('参考资料仅支持 .md 或 .txt 文件');
    if (file.size > 120 * 1024) throw new Error('参考资料不能超过 120 KB');
    const content = await file.text();
    skill.value = await post<SkillDetail>(`/skills/${skill.value.id}/references`, {
      filename: file.name,
      content,
    });
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
}
async function startSession() {
  if (!skill.value) return;
  try {
    session.value = await post<SkillAuthoringSession>(`/skills/${skill.value.id}/authoring-sessions`);
    messages.value = session.value.messages ?? [];
  } catch (err) {
    app.toast((err as Error).message, 'error');
  }
}
function useStarterPrompt(text: string) {
  prompt.value = text;
  void nextTick(() => promptInput.value?.focus());
}
async function send() {
  if (!prompt.value.trim() || busy.value || !skill.value) return;
  if (dirty.value) {
    app.toast('请先保存当前草稿，再让助手基于最新内容继续修改。', 'info');
    return;
  }
  busy.value = true;
  assistantChange.value = '';
  streamingText.value = '';
  const text = prompt.value;
  const previousRevision = skill.value.revision;
  prompt.value = '';
  try {
    if (!session.value) await startSession();
    if (!session.value || !skill.value) return;
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
    await loadSkill();
    if (skill.value?.revision && skill.value.revision !== previousRevision) {
      assistantChange.value = `助手已更新当前草稿，生成修订 r${skill.value.revision}。请在内容区审阅后再发布。`;
    }
  } catch (err) {
    const message = (err as Error).message;
    if (skill.value) await loadSkill();
    app.toast(message, 'error');
  } finally {
    busy.value = false;
  }
}

watch(
  () => route.params.id,
  () => {
    void loadSkill();
  },
);
onMounted(() => {
  void loadSkill({ focusAssistant: route.query.start === 'generate' });
});
onBeforeRouteLeave(() => {
  if (!dirty.value) return true;
  return confirm({ title: '当前草稿有未保存的修改，确定离开吗？', okText: '离开', cancelText: '留下' });
});
</script>

<template>
  <main class="page-content enterprise-page skill-editor-page">
    <div class="enterprise-page-inner skill-editor-inner">
      <div v-if="loading" class="loading-inline" role="status">
        <a-spin size="small" />正在打开 Skill 工作台…
      </div>
      <CatalogEmpty v-else-if="error && !skill" icon="book" title="无法打开这个 Skill" :description="error">
        <RouterLink v-slot="{ href, navigate }" to="/agent/skills" custom>
          <a-button :href="href" @click="navigate">返回技能库</a-button>
        </RouterLink>
      </CatalogEmpty>
      <template v-else-if="skill">
        <a-breadcrumb class="skill-breadcrumb">
          <a-breadcrumb-item
            ><RouterLink to="/agent/capabilities?tab=skills">技能管理</RouterLink></a-breadcrumb-item
          >
          <a-breadcrumb-item><RouterLink to="/agent/skills">技能</RouterLink></a-breadcrumb-item>
          <a-breadcrumb-item>{{ skill.name }}</a-breadcrumb-item>
        </a-breadcrumb>
        <header class="skill-editor-heading">
          <div class="skill-editor-title">
            <span class="scene-icon book skill-editor-symbol"><Icon name="book" :size="20" /></span>
            <div class="skill-editor-copy">
              <div class="skill-editor-name">
                <h1>{{ skill.name }}</h1>
                <a-tag :bordered="false" :color="skill.status === 'published' ? 'success' : undefined">{{
                  skill.status === 'published' ? `已发布 · v${skill.publishedVersion}` : '草稿'
                }}</a-tag>
              </div>
              <p>{{ skill.description || '尚未添加用途说明。' }}</p>
            </div>
          </div>
          <div class="skill-editor-actions">
            <span :class="['skill-save-state', { dirty }]">{{ saveState }}</span>
            <a-button :disabled="!dirty" :loading="saving" @click="save">
              <template #icon><Icon name="save" :size="16" /></template>保存草稿
            </a-button>
            <a-button
              type="primary"
              :disabled="!canPublish"
              :loading="publishing"
              :title="dirty ? '请先保存草稿' : ''"
              @click="requestPublish"
            >
              <template #icon><Icon name="check" :size="16" /></template>发布版本
            </a-button>
          </div>
        </header>
        <a-alert
          v-if="dirty"
          class="skill-unsaved-note"
          type="warning"
          show-icon
          message="草稿有未保存修改；保存后才能让助手继续处理或发布新版本。"
        />

        <div class="skill-editor-layout">
          <section class="skill-workbench" aria-label="Skill 内容工作区">
            <div class="skill-workbench-tabs">
              <CatalogFilter v-model:value="activePanel" :options="panelOptions" aria-label="Skill 编辑区" />
            </div>

            <section v-if="activePanel === 'content'" class="skill-panel skill-content-panel">
              <header class="skill-panel-heading">
                <div>
                  <h2>草稿内容</h2>
                  <p>使用 YAML front matter 定义名称和说明，再补充可执行的工作步骤与输出要求。</p>
                </div>
                <a-tag :bordered="false" class="skill-format-tag">Markdown</a-tag>
              </header>
              <a-textarea
                :value="skill.content"
                class="skill-content-editor"
                spellcheck="false"
                aria-label="Skill 草稿内容"
                @update:value="updateContent"
              />
              <footer class="skill-content-footer">
                <span
                  ><Icon name="shield" :size="14" />发布后的版本保持不可变；后续编辑会形成新的草稿修订。</span
                >
                <a-button v-if="dirty" type="link" size="small" :loading="saving" @click="save"
                  >保存修改</a-button
                >
              </footer>
            </section>

            <section v-else-if="activePanel === 'references'" class="skill-panel skill-references-panel">
              <header class="skill-panel-heading">
                <div>
                  <h2>参考资料</h2>
                  <p>
                    上传的资料会被助手作为当前草稿的上下文。仅支持 Markdown 或纯文本，单个文件不超过 120 KB。
                  </p>
                </div>
              </header>
              <a-upload-dragger
                class="skill-reference-upload"
                name="reference"
                accept=".md,.txt,text/plain,text/markdown"
                :file-list="[]"
                :multiple="false"
                :show-upload-list="false"
                :disabled="uploadingReference"
                :before-upload="beforeReferenceUpload"
                @reject="rejectReferenceFiles"
              >
                <span class="skill-reference-upload-icon"><Icon name="paperclip" :size="20" /></span>
                <p class="skill-reference-upload-title">
                  {{ uploadingReference ? '正在添加…' : '点击或拖放文件添加参考资料' }}
                </p>
                <p class="skill-reference-upload-hint">支持 .md 或 .txt，单个文件不超过 120 KB</p>
              </a-upload-dragger>
              <a-list
                v-if="skill.referenceFiles?.length"
                class="skill-reference-list"
                :data-source="skill.referenceFiles"
                :row-key="referenceKey"
              >
                <template #renderItem="{ item: file }">
                  <a-list-item>
                    <a-list-item-meta
                      :title="file.filename"
                      :description="`${Math.ceil(file.bytes / 1024)} KB · 已附加到当前草稿`"
                    >
                      <template #avatar>
                        <span class="skill-reference-file"><Icon name="file" :size="16" /></span>
                      </template>
                    </a-list-item-meta>
                  </a-list-item>
                </template>
              </a-list>
              <CatalogEmpty
                v-else
                class="skill-panel-empty"
                icon="folder"
                title="还没有参考资料"
                description="需要时添加工作规范、写作要求或已有素材，帮助助手理解上下文。"
              />
            </section>

            <section v-else class="skill-panel skill-history-panel">
              <header class="skill-panel-heading">
                <div>
                  <h2>版本历史</h2>
                  <p>每次保存、助手更新和发布都会保留一份修订。恢复会创建新的草稿，不会覆盖已有记录。</p>
                </div>
              </header>
              <div v-if="previewRevision" class="skill-revision-preview">
                <header>
                  <div>
                    <a-tag :bordered="false">r{{ previewRevision.revision }}</a-tag
                    ><strong>{{ previewRevision.changeSummary }}</strong>
                  </div>
                  <a-button type="text" size="small" @click="previewRevision = null">
                    <template #icon><Icon name="close" :size="14" /></template>关闭预览
                  </a-button>
                </header>
                <pre>{{ previewRevision.content }}</pre>
              </div>
              <a-list class="skill-revision-list" :data-source="revisions" :row-key="revisionKey">
                <template #renderItem="{ item: revision }">
                  <a-list-item :class="{ current: revision.id === skill.currentRevisionId }">
                    <a-list-item-meta>
                      <template #title>
                        <span class="skill-revision-title"
                          ><a-tag :bordered="false" :color="revision.publishedVersion ? 'success' : undefined"
                            >r{{ revision.revision
                            }}{{ revision.publishedVersion ? ` · v${revision.publishedVersion}` : '' }}</a-tag
                          ><strong>{{ revision.changeSummary }}</strong></span
                        >
                      </template>
                      <template #description>
                        {{ revisionSource(revision.source) }} · {{ formatDate(revision.createdAt) }}
                      </template>
                    </a-list-item-meta>
                    <template #actions>
                      <span v-if="revision.id === skill.currentRevisionId" class="skill-current-revision"
                        >当前版本</span
                      >
                      <a-button type="text" size="small" @click="previewRevision = revision">查看</a-button>
                      <a-button size="small" @click="requestRestore(revision)">恢复为草稿</a-button>
                    </template>
                  </a-list-item>
                </template>
              </a-list>
            </section>
          </section>

          <aside class="skill-assistant-panel" aria-label="Skill 助手">
            <header class="skill-assistant-heading">
              <div>
                <span class="scene-icon book skill-assistant-symbol"
                  ><Icon name="sparkles" :size="16"
                /></span>
                <div>
                  <h2>Skill 助手</h2>
                  <p>只修改当前草稿，不会自动发布</p>
                </div>
              </div>
              <a-button v-if="session" type="text" size="small" :disabled="busy" @click="startSession">
                <template #icon><Icon name="plus" :size="14" /></template>新会话
              </a-button>
            </header>
            <div class="skill-assistant-log" aria-live="polite">
              <div v-if="!messages.length && !busy" class="skill-assistant-empty">
                <span class="scene-icon book skill-assistant-empty-icon"
                  ><Icon name="sparkles" :size="20"
                /></span>
                <strong>从需求开始完善草稿</strong>
                <p>描述需要的步骤、边界或输出格式。助手会先处理当前草稿，发布仍由你确认。</p>
                <div class="skill-prompt-suggestions">
                  <button
                    v-for="item in starterPrompts"
                    :key="item"
                    type="button"
                    @click="useStarterPrompt(item)"
                  >
                    {{ item }}
                  </button>
                </div>
              </div>
              <article
                v-for="message in messages"
                :key="message.id"
                :class="['skill-chat-message', message.role]"
              >
                <span>{{ roleLabel(message.role) }}</span>
                <p>{{ message.content }}</p>
              </article>
              <article v-if="busy" class="skill-chat-message assistant">
                <span>助手</span>
                <p>{{ streamingText || '正在处理当前草稿…' }}</p>
              </article>
            </div>
            <a-alert
              v-if="assistantChange"
              class="skill-assistant-change"
              type="success"
              show-icon
              :message="assistantChange"
            />
            <form class="skill-assistant-composer" @submit.prevent="send">
              <a-textarea
                ref="promptInput"
                v-model:value="prompt"
                :disabled="busy"
                :auto-size="{ minRows: 3, maxRows: 6 }"
                placeholder="例如：增加输入检查步骤，并让输出更适合发给客户"
                aria-label="向 Skill 助手描述修改需求"
              />
              <div class="skill-assistant-composer-footer">
                <span v-if="dirty" class="skill-composer-hint"
                  ><Icon name="info" :size="13" />请先保存草稿</span
                >
                <a-button
                  type="primary"
                  html-type="submit"
                  :loading="busy"
                  :disabled="dirty || !prompt.trim()"
                >
                  <template #icon><Icon name="arrow" :size="16" /></template>发送
                </a-button>
              </div>
            </form>
          </aside>
        </div>
      </template>
    </div>
  </main>
</template>

<style scoped>
.skill-editor-inner {
  max-width: 1340px;
}
.skill-breadcrumb {
  margin-bottom: 16px;
}
/* icon 插槽里是 ForgeIcon 裸 <svg>，不是 .anticon，需要手动补图标与文字的间距 */
.skill-editor-page :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

/* 页头：图标 + 名称/状态 + 说明；右侧保存状态与主要操作 */
.skill-editor-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 24px;
}
.skill-editor-title {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}
.skill-editor-symbol {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 8px;
}
.skill-editor-copy {
  min-width: 0;
}
.skill-editor-name {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.skill-editor-name h1 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--page-title-size);
  font-weight: 600;
  letter-spacing: -0.6px;
  overflow-wrap: anywhere;
}
.skill-editor-name :deep(.ant-tag) {
  margin: 0;
}
.skill-editor-copy p {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.75;
}
.skill-editor-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}
.skill-save-state {
  margin-right: 4px;
  color: var(--color-text-tertiary);
  font-size: 12px;
  white-space: nowrap;
}
.skill-save-state.dirty {
  color: var(--color-warning-text);
}
.skill-unsaved-note {
  margin-bottom: 16px;
}

/* 左侧工作区 + 右侧助手，两块都是扁平白卡 */
.skill-editor-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  align-items: stretch;
  gap: 20px;
}
.skill-workbench,
.skill-assistant-panel {
  min-width: 0;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--surface-card);
}
.skill-workbench-tabs {
  display: flex;
  align-items: center;
  min-height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border-default);
  overflow-x: auto;
}
.skill-panel {
  min-height: 625px;
  padding: 20px;
}
.skill-panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.skill-panel-heading h2,
.skill-assistant-heading h2 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 15px;
  font-weight: 600;
}
.skill-panel-heading p,
.skill-assistant-heading p {
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.skill-format-tag {
  margin: 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

/* 内容编辑器：等宽字体的大文本框，占满面板剩余高度 */
.skill-content-panel {
  display: flex;
  flex-direction: column;
}
.skill-content-editor {
  flex: 1;
  min-height: 500px;
  resize: vertical;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 13px;
  line-height: 1.7;
}
.skill-content-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 32px;
  margin-top: 12px;
  color: var(--color-text-tertiary);
  font-size: 12px;
}
.skill-content-footer > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 参考资料 */
.skill-reference-upload {
  display: block;
  margin-bottom: 16px;
}
.skill-reference-upload :deep(.ant-upload-drag) {
  background: var(--surface-subtle-bg);
}
.skill-reference-upload :deep(.ant-upload-btn) {
  padding: 20px 16px;
}
.skill-reference-upload-icon,
.skill-reference-file {
  display: inline-grid;
  place-items: center;
  border-radius: 8px;
  background: var(--color-brand-muted);
  color: var(--color-brand-active);
}
.skill-reference-upload-icon {
  width: 40px;
  height: 40px;
  margin-bottom: 8px;
}
.skill-reference-upload-title {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 500;
}
.skill-reference-upload-hint {
  margin: 4px 0 0;
  color: var(--color-text-tertiary);
  font-size: 12px;
}
.skill-reference-file {
  width: 32px;
  height: 32px;
}
.skill-panel-empty {
  min-height: 200px;
}

/* 版本历史 */
.skill-revision-preview {
  margin-bottom: 16px;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: 8px;
}
.skill-revision-preview > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-default);
  background: var(--surface-subtle-bg);
}
.skill-revision-preview > header > div {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.skill-revision-preview strong {
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-revision-preview pre {
  max-height: 320px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  color: var(--color-text-primary);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.skill-revision-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.skill-revision-title :deep(.ant-tag) {
  margin: 0;
}
.skill-revision-title strong {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.skill-current-revision {
  color: var(--color-brand-active);
  font-size: 12px;
  font-weight: 500;
}

/* 助手面板 */
.skill-assistant-panel {
  display: flex;
  flex-direction: column;
  min-height: 678px;
  overflow: hidden;
}
.skill-assistant-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 56px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-default);
}
.skill-assistant-heading > div {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.skill-assistant-heading p {
  margin-top: 0;
}
.skill-assistant-symbol {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 8px;
}
.skill-assistant-log {
  flex: 1;
  min-height: 0;
  padding: 14px;
  overflow: auto;
  background: var(--surface-subtle-bg);
}
.skill-assistant-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 4px 16px;
  text-align: center;
}
.skill-assistant-empty-icon {
  width: 40px;
  height: 40px;
  margin-bottom: 12px;
  border-radius: 8px;
}
.skill-assistant-empty strong {
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 600;
}
.skill-assistant-empty p {
  margin: 8px auto 16px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.7;
}
/* 示例提问：多行文字的可点卡片，antd Button 不适合换行，保留原生按钮 */
.skill-prompt-suggestions {
  display: grid;
  gap: 8px;
  width: 100%;
  text-align: left;
}
.skill-prompt-suggestions > button {
  padding: 8px 12px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--surface-card);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    color 150ms ease;
}
.skill-prompt-suggestions > button:hover {
  border-color: var(--color-brand);
  color: var(--color-text-primary);
}
.skill-prompt-suggestions > button:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
.skill-chat-message {
  max-width: 94%;
  margin: 0 0 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--surface-card);
}
.skill-chat-message.user {
  margin-left: auto;
  border-color: var(--color-brand-border);
  background: var(--color-brand-muted);
}
.skill-chat-message > span {
  display: block;
  color: var(--color-text-tertiary);
  font-size: 11px;
  font-weight: 500;
}
.skill-chat-message.user > span {
  color: var(--color-brand-active);
}
.skill-chat-message p {
  margin: 4px 0 0;
  color: var(--color-text-primary);
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
}
.skill-assistant-change {
  margin: 12px 14px 0;
}
.skill-assistant-composer {
  padding: 12px;
  border-top: 1px solid var(--border-default);
}
.skill-assistant-composer-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.skill-composer-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: auto;
  color: var(--color-warning-text);
  font-size: 12px;
}

@media (max-width: 1260px) {
  .skill-editor-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .skill-assistant-panel {
    min-height: 510px;
  }
}
@media (max-width: 820px) {
  .skill-editor-heading {
    flex-direction: column;
    align-items: stretch;
  }
  .skill-editor-actions {
    flex-wrap: wrap;
  }
  .skill-panel {
    min-height: 570px;
    padding: 16px;
  }
  .skill-content-editor {
    min-height: 440px;
  }
}
@media (max-width: 660px) {
  .skill-content-footer {
    flex-direction: column;
    align-items: flex-start;
  }
  .skill-revision-list :deep(.ant-list-item) {
    flex-wrap: wrap;
  }
}
</style>
