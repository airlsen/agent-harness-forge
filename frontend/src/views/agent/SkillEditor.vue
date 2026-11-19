<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { api, apiFetch, post, put } from '../../api/client';
import DialogShell from '../../components/DialogShell.vue';
import Icon from '../../components/ForgeIcon.vue';
import { usePlatform } from '../../stores/platform';
import type {
  SkillAuthoringMessage,
  SkillAuthoringSession,
  SkillDetail,
  SkillRevision,
} from '../../types/skill';

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
const pendingPublish = ref(false);
const pendingRestore = ref<SkillRevision | null>(null);
const previewRevision = ref<SkillRevision | null>(null);
const promptInput = ref<HTMLTextAreaElement | null>(null);

const skillId = computed(() => Number(route.params.id));
const canPublish = computed(() =>
  Boolean(skill.value && skill.value.status === 'draft' && !dirty.value && !saving.value),
);
const saveState = computed(() => {
  if (saving.value) return '正在保存…';
  if (dirty.value) return '有未保存修改';
  return skill.value?.updatedAt ? `已保存 · ${formatDate(skill.value.updatedAt)}` : '草稿已保存';
});
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
function requestPublish() {
  if (!canPublish.value) return;
  pendingPublish.value = true;
}
async function publish() {
  if (!skill.value || publishing.value) return;
  publishing.value = true;
  try {
    skill.value = await post<SkillDetail>(`/skills/${skill.value.id}/publish`);
    pendingPublish.value = false;
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
function requestRestore(revision: SkillRevision) {
  pendingRestore.value = revision;
}
async function restore() {
  if (!skill.value || !pendingRestore.value) return;
  const restored = pendingRestore.value.revision;
  try {
    skill.value = await post<SkillDetail>(
      `/skills/${skill.value.id}/revisions/${pendingRestore.value.id}/restore`,
    );
    dirty.value = false;
    activePanel.value = 'content';
    previewRevision.value = null;
    pendingRestore.value = null;
    app.toast(`已将 r${restored} 恢复为草稿`);
    await refreshRevisions();
  } catch (err) {
    app.toast((err as Error).message, 'error');
  }
}
async function uploadReference(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !skill.value) return;
  try {
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
    input.value = '';
  }
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
onBeforeRouteLeave(() => !dirty.value || window.confirm('当前草稿有未保存的修改，确定离开吗？'));
</script>

<template>
  <main class="page-content enterprise-page skill-editor-page">
    <div class="enterprise-page-inner skill-editor-inner">
      <section v-if="loading" class="skill-loading" aria-live="polite">
        <span class="loader"></span>正在打开 Skill 工作台…
      </section>
      <section v-else-if="error && !skill" class="skill-editor-missing enterprise-empty">
        <span class="enterprise-empty-symbol"><Icon name="book" :size="28" /></span>
        <h2>无法打开这个 Skill</h2>
        <p>{{ error }}</p>
        <RouterLink to="/agent/skills" class="button secondary">返回 Skill 库</RouterLink>
      </section>
      <template v-else-if="skill">
        <nav class="skill-breadcrumb" aria-label="面包屑">
          <RouterLink to="/agent/capabilities?tab=skills">能力管理</RouterLink
          ><Icon name="chevron" :size="14" /><RouterLink to="/agent/skills">Skill 库</RouterLink
          ><Icon name="chevron" :size="14" /><span aria-current="page">{{ skill.name }}</span>
        </nav>
        <header class="skill-editor-heading">
          <div class="skill-editor-title">
            <div class="skill-editor-title-top">
              <span class="skill-editor-symbol"><Icon name="book" :size="21" /></span
              ><span :class="['tag', skill.status === 'published' ? 'success' : 'neutral']">{{
                skill.status === 'published' ? `已发布 · v${skill.publishedVersion}` : '草稿'
              }}</span>
            </div>
            <h1>{{ skill.name }}</h1>
            <p>{{ skill.description || '尚未添加用途说明。' }}</p>
          </div>
          <div class="skill-editor-actions">
            <span :class="['skill-save-state', { dirty }]">{{ saveState }}</span><button
              class="button secondary"
              :disabled="!dirty || saving"
              @click="save"
            >
              <Icon name="save" :size="15" />{{ saving ? '正在保存…' : '保存草稿' }}</button
            ><button
              class="button primary"
              :disabled="!canPublish"
              :title="dirty ? '请先保存草稿' : ''"
              @click="requestPublish"
            >
              <Icon name="check" :size="15" />发布版本
            </button>
          </div>
        </header>
        <p v-if="dirty" class="skill-unsaved-note">
          <Icon name="info" :size="16" />草稿有未保存修改；保存后才能让助手继续处理或发布新版本。
        </p>

        <div class="skill-editor-layout">
          <section class="skill-workbench" aria-label="Skill 内容工作区">
            <nav class="skill-workbench-tabs" aria-label="Skill 编辑区">
              <button :class="{ selected: activePanel === 'content' }" @click="activePanel = 'content'">
                <Icon name="edit" :size="15" />内容
              </button>
              <button :class="{ selected: activePanel === 'references' }" @click="activePanel = 'references'">
                <Icon name="paperclip" :size="15" />参考资料
                <span v-if="skill.referenceFiles?.length">{{ skill.referenceFiles.length }}</span>
              </button>
              <button :class="{ selected: activePanel === 'history' }" @click="activePanel = 'history'">
                <Icon name="clock" :size="15" />版本历史 <span>{{ revisions.length }}</span>
              </button>
            </nav>

            <section v-if="activePanel === 'content'" class="skill-panel skill-content-panel">
              <header class="skill-panel-heading">
                <div>
                  <h2>草稿内容</h2>
                  <p>使用 YAML front matter 定义名称和说明，再补充可执行的工作步骤与输出要求。</p>
                </div>
                <span>Markdown</span>
              </header>
              <textarea
                v-model="skill.content"
                class="skill-content-editor"
                spellcheck="false"
                aria-label="Skill 草稿内容"
                @input="dirty = true"
              ></textarea>
              <footer class="skill-content-footer">
                <span
                  ><Icon name="shield" :size="14" />发布后的版本保持不可变；后续编辑会形成新的草稿修订。</span
                ><button v-if="dirty" class="button text small" :disabled="saving" @click="save">
                  保存修改 <Icon name="arrow" :size="14" />
                </button>
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
              <label class="skill-reference-upload"
                ><span class="skill-reference-upload-icon"><Icon name="paperclip" :size="22" /></span
                ><span><strong>添加参考资料</strong><small>选择 .md 或 .txt 文件</small></span
                ><input type="file" accept=".md,.txt,text/plain,text/markdown" @change="uploadReference"
              /></label>
              <div v-if="skill.referenceFiles?.length" class="skill-reference-list">
                <article v-for="ref in skill.referenceFiles" :key="ref.path">
                  <span class="skill-reference-file"><Icon name="file" :size="18" /></span>
                  <div>
                    <strong>{{ ref.filename }}</strong><small
                      >{{ Math.ceil(ref.bytes / 1024) }} KB · 已附加到当前草稿</small
                    >
                  </div>
                </article>
              </div>
              <div v-else class="skill-panel-empty">
                <Icon name="folder" :size="24" /><strong>还没有参考资料</strong>
                <p>需要时添加工作规范、写作要求或已有素材，帮助助手理解上下文。</p>
              </div>
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
                    <span class="tag neutral">r{{ previewRevision.revision }}</span
                    ><strong>{{ previewRevision.changeSummary }}</strong>
                  </div>
                  <button class="button text small" @click="previewRevision = null">
                    <Icon name="close" :size="14" />关闭预览
                  </button>
                </header>
                <pre>{{ previewRevision.content }}</pre>
              </div>
              <div class="skill-revision-list">
                <article
                  v-for="revision in revisions"
                  :key="revision.id"
                  :class="['skill-revision-row', { current: revision.id === skill.currentRevisionId }]"
                >
                  <div class="skill-revision-meta">
                    <span :class="['tag', revision.publishedVersion ? 'success' : 'neutral']"
                      >r{{ revision.revision
                      }}{{ revision.publishedVersion ? ` · v${revision.publishedVersion}` : '' }}</span
                    >
                    <div>
                      <strong>{{ revision.changeSummary }}</strong><small
                        >{{
                          revision.source === 'assistant'
                            ? '助手更新'
                            : revision.source === 'publish'
                              ? '正式发布'
                              : revision.source === 'restore'
                                ? '恢复修订'
                                : '手动编辑'
                        }}
                        · {{ formatDate(revision.createdAt) }}</small
                      >
                    </div>
                  </div>
                  <div class="skill-revision-actions">
                    <span v-if="revision.id === skill.currentRevisionId" class="skill-current-revision"
                      >当前版本</span
                    ><button class="button text small" @click="previewRevision = revision">查看</button
                    ><button class="button secondary small" @click="requestRestore(revision)">
                      恢复为草稿
                    </button>
                  </div>
                </article>
              </div>
            </section>
          </section>

          <aside class="skill-assistant-panel" aria-label="Skill 助手">
            <header class="skill-assistant-heading">
              <div>
                <span class="skill-assistant-symbol"><Icon name="sparkles" :size="17" /></span>
                <div>
                  <h2>Skill 助手</h2>
                  <p>只修改当前草稿，不会自动发布</p>
                </div>
              </div>
              <button v-if="session" class="button text small" :disabled="busy" @click="startSession">
                <Icon name="plus" :size="14" />新会话
              </button>
            </header>
            <div class="skill-assistant-log" aria-live="polite">
              <div v-if="!messages.length && !busy" class="skill-assistant-empty">
                <span class="skill-assistant-empty-icon"><Icon name="sparkles" :size="22" /></span
                ><strong>从需求开始完善草稿</strong>
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
            <p v-if="assistantChange" class="skill-assistant-change">
              <Icon name="check" :size="16" />{{ assistantChange }}
            </p>
            <form class="skill-assistant-composer" @submit.prevent="send">
              <textarea
                ref="promptInput"
                v-model="prompt"
                :disabled="busy"
                placeholder="例如：增加输入检查步骤，并让输出更适合发给客户"
                aria-label="向 Skill 助手描述修改需求"
              ></textarea>
              <div>
                <small v-if="dirty"><Icon name="info" :size="13" />请先保存草稿</small
                ><button type="submit" class="button primary" :disabled="busy || dirty || !prompt.trim()">
                  <Icon name="arrow" :size="15" />{{ busy ? '处理中…' : '发送' }}
                </button>
              </div>
            </form>
          </aside>
        </div>
      </template>
    </div>

    <DialogShell
      v-if="pendingPublish"
      variant="modal"
      label="发布 Skill 版本"
      panel-class="skill-confirm-dialog"
      @close="pendingPublish = false"
      ><span class="skill-confirm-icon"><Icon name="check" :size="21" /></span>
      <h2>发布新的正式版本？</h2>
      <p>将以当前草稿创建不可变版本。之后继续编辑会产生新的草稿，不会修改已发布版本。</p>
      <footer>
        <button class="button secondary" :disabled="publishing" @click="pendingPublish = false">取消</button
        ><button class="button primary" :disabled="publishing" @click="publish">
          {{ publishing ? '正在发布…' : '确认发布' }}
        </button>
      </footer></DialogShell
    >
    <DialogShell
      v-if="pendingRestore"
      variant="modal"
      label="恢复 Skill 修订"
      panel-class="skill-confirm-dialog"
      @close="pendingRestore = null"
      ><span class="skill-confirm-icon"><Icon name="refresh" :size="21" /></span>
      <h2>恢复 r{{ pendingRestore.revision }} 为草稿？</h2>
      <p>系统会基于这份修订创建新的草稿记录，不会覆盖当前版本或已经发布的版本。</p>
      <footer>
        <button class="button secondary" @click="pendingRestore = null">取消</button
        ><button class="button primary" @click="restore">恢复为草稿</button>
      </footer></DialogShell
    >
  </main>
</template>
