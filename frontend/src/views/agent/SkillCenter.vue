<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api, apiFetch, post, put } from '../../api/client';
import Icon from '../../components/ForgeIcon.vue';
import DialogShell from '../../components/DialogShell.vue';

const skills = ref<any[]>([]);
const selected = ref<any>(null);
const revisions = ref<any[]>([]);
const session = ref<any>(null);
const messages = ref<any[]>([]);
const prompt = ref('');
const busy = ref(false);
const streamingText = ref('');
const error = ref('');
const dirty = ref(false);
const createOpen = ref(false);
const creating = ref(false);
const newSkill = reactive({ name: '', description: '' });
const canPublish = computed(() => selected.value && selected.value.status === 'draft' && !dirty);
async function load() {
  const data = await api<{ items: any[] }>('/skills');
  skills.value = data.items;
  if (selected.value) await choose(selected.value.id);
}
async function choose(id: number) {
  selected.value = await api(`/skills/${id}`);
  revisions.value = (await api<{ items: any[] }>(`/skills/${id}/revisions`)).items;
  session.value = await api(`/skills/${id}/authoring-session/latest`);
  messages.value = session.value?.messages ?? [];
  dirty.value = false;
}
function openCreate() {
  newSkill.name = '';
  newSkill.description = '';
  createOpen.value = true;
}
function backToList() {
  if (dirty.value && !window.confirm('当前草稿有未保存的修改，确定离开吗？')) return;
  selected.value = null;
  session.value = null;
}
async function create() {
  if (!newSkill.name.trim() || creating.value) return;
  creating.value = true;
  error.value = '';
  try {
    const item = await post('/skills', { name: newSkill.name.trim(), description: newSkill.description.trim() });
    createOpen.value = false;
    await load();
    await choose(item.id);
  } catch (e: any) { error.value = e.message; }
  finally { creating.value = false; }
}
async function save() {
  if (!selected.value) return;
  try { selected.value = await put(`/skills/${selected.value.id}/draft`, { content: selected.value.content, change_summary: '手动编辑草稿' }); await load(); }
  catch (e: any) { error.value = e.message; }
}
async function publish() {
  if (!selected.value || !window.confirm('发布后会生成不可变版本，确认继续？')) return;
  try { selected.value = await post(`/skills/${selected.value.id}/publish`); await load(); }
  catch (e: any) { error.value = e.message; }
}
async function restore(rev: any) {
  if (!window.confirm(`将修订 r${rev.revision} 恢复为新的草稿修订？`)) return;
  try { selected.value = await post(`/skills/${selected.value.id}/revisions/${rev.id}/restore`); await load(); }
  catch (e: any) { error.value = e.message; }
}
async function uploadReference(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !selected.value) return;
  try {
    if (file.size > 120 * 1024) throw new Error('参考资料不能超过 120 KB');
    const content = await file.text();
    selected.value = await post(`/skills/${selected.value.id}/references`, { filename: file.name, content });
    await load();
  } catch (e: any) { error.value = e.message; }
  finally { input.value = ''; }
}
async function startSession() {
  try { session.value = await post(`/skills/${selected.value.id}/authoring-sessions`); messages.value = session.value.messages; error.value = ''; }
  catch (e: any) { error.value = e.message; }
}
async function send() {
  if (!prompt.value.trim() || busy.value || !selected.value) return;
  busy.value = true; error.value = ''; streamingText.value = '';
  const text = prompt.value; prompt.value = '';
  try {
    if (!session.value) await startSession();
    if (!session.value) return;
    const response = await apiFetch(`/api/skills/${selected.value.id}/authoring-sessions/${session.value.id}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
    if (!response.ok) throw new Error((await response.json()).message ?? '助手请求失败');
    const reader = response.body?.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (reader) {
      const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n'); buffer = blocks.pop() ?? '';
      for (const block of blocks) { const line = block.split('\n').find(v => v.startsWith('data: ')); if (!line) continue; const event = JSON.parse(line.slice(6)); if (event.kind === 'message_delta') streamingText.value += String(event.payload?.text ?? ''); else if (event.kind === 'error') throw new Error(event.payload?.message ?? 'Skill 助手执行失败'); }
    }
    await choose(selected.value.id);
  } catch (e: any) { error.value = e.message; await choose(selected.value.id); }
  finally { busy.value = false; }
}
onMounted(() => load().catch(e => error.value = e.message));
</script>

<template>
  <main class="skill-center">
    <header class="skill-header"><div><p class="eyebrow">企业能力中心</p><h1>Skill 管理</h1><p>沉淀可复用的工作方法。助手只修改草稿，发布由你确认。</p></div><button class="primary" @click="selected ? backToList() : openCreate()">{{ selected ? '返回 Skill 列表' : '新建 Skill' }}</button></header>
    <p v-if="error" class="error-banner">{{ error }}</p>
    <section v-if="!skills.length" class="enterprise-empty"><span class="enterprise-empty-symbol"><Icon name="book" :size="28" /></span><h2>还没有 Skill</h2><p>沉淀可复用的工作方法，之后可以手动编辑或与助手一起完善。</p><button class="button primary" @click="openCreate">创建第一个 Skill</button></section>
    <section v-else-if="!selected" class="skill-card-grid" aria-label="Skill 列表">
      <article v-for="item in skills" :key="item.id" class="skill-directory-card" role="button" tabindex="0" :aria-label="`编辑 Skill：${item.name}`" @click="choose(item.id)" @keydown.enter="choose(item.id)" @keydown.space.prevent="choose(item.id)">
        <div class="skill-card-top"><span class="skill-card-icon"><Icon name="book" :size="18" /></span><span :class="['skill-status', item.status === 'published' ? 'published' : 'draft']">{{ item.status === 'published' ? `已发布 · v${item.publishedVersion}` : '草稿' }}</span></div>
        <h2>{{ item.name }}</h2><p>{{ item.description || '尚未添加说明，打开 Skill 补充用途和工作方法。' }}</p>
        <footer><span>修订 r{{ item.revision || 1 }}</span><button @click.stop="choose(item.id)">编辑 Skill <span aria-hidden="true">→</span></button></footer>
      </article>
    </section>
    <div v-else class="skill-layout">
      <section v-if="selected" class="skill-workspace">
        <div class="skill-title"><div><h2>{{ selected.name }}</h2><p>{{ selected.description || '尚未添加说明' }} · 修订 r{{ selected.revision }}</p></div><div class="skill-actions"><button @click="save">保存草稿</button><button class="primary" :disabled="!canPublish" @click="publish">发布版本</button></div></div>
        <div class="skill-columns"><article class="editor-panel"><div class="panel-heading"><h3>草稿内容</h3><label class="upload-button">添加参考资料<input type="file" accept=".md,.txt,text/plain,text/markdown" @change="uploadReference" /></label></div><textarea v-model="selected.content" spellcheck="false" @input="dirty = true"/><div class="hint">编辑内容会形成新的草稿修订；已发布版本不会被覆盖。</div><div v-if="selected.referenceFiles?.length" class="reference-files"><b>参考资料</b><span v-for="ref in selected.referenceFiles" :key="ref.path">{{ ref.filename }} · {{ Math.ceil(ref.bytes / 1024) }} KB</span></div>
          <div class="revision-panel"><h3>修订历史</h3><button v-for="rev in revisions" :key="rev.id" class="revision-row" @click="restore(rev)"><span><b>r{{ rev.revision }}{{ rev.publishedVersion ? ` · 已发布 v${rev.publishedVersion}` : '' }}</b><small>{{ rev.changeSummary }}</small></span><small>恢复为草稿</small></button></div>
        </article><aside class="assistant-panel"><div class="panel-heading"><div><h3>Skill 助手</h3><small>只处理当前草稿，不会自动发布</small></div><button v-if="session" class="quiet" @click="startSession">新会话</button></div><div class="chat-log"><div v-if="!messages.length" class="chat-empty">描述希望这个 Skill 如何工作，助手会协助修改当前草稿。</div><div v-for="m in messages" :key="m.id" :class="['chat-message', m.role]"><b>{{ m.role === 'user' ? '你' : m.role === 'assistant' ? '助手' : '记录' }}</b><p>{{ m.content }}</p></div><div v-if="busy" class="chat-message assistant"><b>助手</b><p>{{ streamingText || '正在处理…' }}</p></div></div><form class="chat-input" @submit.prevent="send"><textarea v-model="prompt" placeholder="例如：增加输入检查步骤，并让输出更适合发给客户" :disabled="busy"/><button class="primary" :disabled="busy || !prompt.trim()">发送</button></form></aside></div>
      </section>
    </div>
    <DialogShell v-if="createOpen" variant="modal" label="新建 Skill" panel-class="skill-create-dialog" @close="createOpen = false">
      <header class="skill-create-heading"><div><p class="eyebrow">新增能力</p><h2>创建 Skill</h2><p>先定义名称和用途，详细工作方法之后可以继续编辑或交给助手完善。</p></div><button class="close-button" aria-label="关闭" @click="createOpen = false"><Icon name="close" :size="20" /></button></header>
      <form class="skill-create-form" @submit.prevent="create">
        <label>Skill 名称 <span>必填</span><input v-model="newSkill.name" maxlength="120" required autofocus placeholder="例如：客户工单总结" /></label>
        <label>用途说明 <span>选填</span><textarea v-model="newSkill.description" maxlength="512" rows="3" placeholder="说明这个 Skill 适合处理什么任务，以及希望得到什么结果。" /></label>
        <p class="skill-create-note"><Icon name="shield" :size="16" />创建后会生成一个未发布草稿。发布为正式版本前，你可以反复编辑和预览。</p>
        <footer><button type="button" class="secondary-button" :disabled="creating" @click="createOpen = false">取消</button><button type="submit" class="submit-button" :disabled="creating || !newSkill.name.trim()">{{ creating ? '正在创建…' : '创建草稿' }}</button></footer>
      </form>
    </DialogShell>
  </main>
</template>

<style scoped>
.skill-center{max-width:1500px;margin:auto;padding:32px;color:var(--ink)}.skill-header,.skill-title,.skill-actions,.panel-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.skill-header{margin-bottom:24px}.skill-header h1{margin:4px 0;font-size:30px}.skill-header p,.skill-title p{color:var(--text-secondary);margin:4px 0}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-subtle)}.primary{background:var(--accent-solid)!important;color:white!important;border-color:var(--accent-solid)!important}.skill-layout{display:block}.editor-panel,.assistant-panel,.empty-card{border:1px solid var(--line);border-radius:10px;background:var(--surface)}.revision-row small{color:var(--text-subtle)}.skill-workspace{min-width:0}.skill-title{padding:8px 2px 18px}.skill-title h2{margin:0}.skill-actions button,.skill-header button,.chat-input button{padding:9px 14px;border-radius:8px;border:1px solid var(--border-strong);background:var(--surface);color:var(--ink)}.skill-columns{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(340px,.8fr);gap:16px}.editor-panel,.assistant-panel{padding:20px;min-width:0}.panel-heading{margin-bottom:12px}.panel-heading h3,.revision-panel h3{margin:0}.panel-heading span{font-size:12px;color:var(--text-subtle)}.upload-button{font-size:12px;color:var(--accent-ink);cursor:pointer}.upload-button input{position:absolute;width:1px;height:1px;opacity:0}.reference-files{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;font-size:12px;color:var(--text-secondary)}.reference-files span{padding:4px 8px;background:var(--surface-subtle);border-radius:6px}.editor-panel>textarea{width:100%;height:440px;resize:vertical;border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--canvas);font:13px/1.65 ui-monospace,monospace;color:var(--ink)}.hint{font-size:12px;color:var(--text-subtle);margin-top:8px}.revision-panel{border-top:1px solid var(--line);margin-top:22px;padding-top:16px}.revision-row{width:100%;padding:10px 0;border:0;border-bottom:1px solid var(--border-soft);background:var(--surface);text-align:left;display:flex;justify-content:space-between;gap:10px}.revision-row span{display:grid;gap:4px}.revision-row small{font-size:12px}.chat-log{height:444px;overflow:auto;background:var(--canvas);border-radius:10px;padding:12px}.chat-empty{padding:28px 12px;color:#79859a;font-size:14px;text-align:center}.chat-message{margin:8px 0;padding:10px 12px;border-radius:10px;background:white;font-size:14px}.chat-message.user{background:var(--accent-soft)}.chat-message p{margin:6px 0 0;white-space:pre-wrap;line-height:1.5}.chat-message b{font-size:12px;color:#68758a}.chat-input{display:flex;gap:8px;margin-top:12px;align-items:flex-end}.chat-input textarea{flex:1;min-height:70px;resize:vertical;border:1px solid #dce3ee;border-radius:9px;padding:10px}.quiet{border:0;background:transparent;color:var(--accent-ink)}.empty-card{text-align:center;padding:65px 24px}.empty-icon{font-size:28px;color:var(--accent-ink)}.error-banner{padding:12px;border-radius:8px;background:#fff1f0;color:#ad3027}@media(max-width:900px){.skill-center{padding:16px}.skill-layout,.skill-columns{grid-template-columns:1fr}.chat-log{height:300px}}
.skill-card-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
.skill-directory-card{display:flex;min-width:0;min-height:220px;flex-direction:column;padding:20px;border:1px solid var(--line);border-radius:10px;background:var(--surface);cursor:pointer;transition:border-color .15s,box-shadow .15s}
.skill-directory-card:hover,.skill-directory-card:focus-visible{border-color:var(--accent-line);box-shadow:0 6px 20px rgb(41 46 56 / 8%);outline:none}
.skill-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.skill-card-icon{display:grid;width:38px;height:38px;place-items:center;border-radius:11px;background:var(--accent-soft);color:var(--accent-ink);font-size:20px}
.skill-status{padding:4px 8px;border-radius:20px;font-size:11px}.skill-status.published{background:#eaf7ef;color:#227446}.skill-status.draft{background:#f2f4f7;color:#667085}
.skill-directory-card h2{margin:18px 0 7px;font-size:17px}.skill-directory-card>p{display:-webkit-box;overflow:hidden;min-height:42px;margin:0;color:var(--text-secondary);font-size:13px;line-height:1.6;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.skill-directory-card>footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:18px;color:var(--text-subtle);font-size:11px}.skill-directory-card>footer button{border:0;background:none;color:var(--accent-ink);font-size:12px;font-weight:600;cursor:pointer}
@media(max-width:1050px){.skill-card-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:620px){.skill-card-grid{grid-template-columns:1fr}}
.skill-create-dialog{position:relative;width:min(560px,calc(100vw - 32px));padding:26px;background:var(--surface)}
.skill-create-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:28px;padding-right:32px}
.skill-create-heading h2{margin:5px 0 7px;font-size:21px;color:var(--ink)}
.skill-create-heading p:last-child{max-width:440px;margin:0;color:var(--text-secondary);font-size:13px;line-height:1.6}
.skill-create-heading .close-button{position:absolute;top:15px;right:15px;display:grid;width:34px;height:34px;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--text-subtle);cursor:pointer}
.skill-create-heading .close-button:hover{background:var(--surface-subtle);color:var(--ink)}
.skill-create-form{display:grid;gap:18px;margin-top:24px}
.skill-create-form>label{display:grid;gap:8px;color:var(--ink);font-size:13px;font-weight:600}
.skill-create-form>label>span{display:inline;margin-left:6px;color:var(--text-subtle);font-size:11px;font-weight:400}
.skill-create-form input,.skill-create-form textarea{width:100%;padding:11px 12px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit;font-size:13px;line-height:1.55}
.skill-create-form input:focus,.skill-create-form textarea:focus{border-color:var(--accent-focus);outline:3px solid var(--accent-focus-ring)}
.skill-create-form textarea{resize:vertical}
.skill-create-note{display:flex;align-items:flex-start;gap:9px;margin:0;padding:12px;border-radius:8px;background:var(--accent-wash);color:var(--text-secondary);font-size:12px;line-height:1.6}
.skill-create-note svg{flex:0 0 auto;color:var(--accent-ink)}
.skill-create-form footer{display:flex;justify-content:flex-end;gap:9px;padding-top:2px}
.skill-create-form footer button{min-height:38px;padding:8px 14px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--ink);font-size:13px;cursor:pointer}
.skill-create-form footer .submit-button{border-color:var(--accent-solid);background:var(--accent-solid);color:white}
.skill-create-form footer button:disabled{opacity:.55;cursor:not-allowed}
@media(max-width:620px){.skill-create-dialog{padding:20px}.skill-card-grid{gap:12px}}
</style>
