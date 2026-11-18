<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, apiFetch, post, put } from '../../api/client';

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
const canPublish = computed(() => selected.value && selected.value.status === 'draft' && !dirty);
async function load() {
  const data = await api<{ items: any[] }>('/skills');
  skills.value = data.items;
  if (selected.value) await choose(selected.value.id);
  else if (skills.value.length) await choose(skills.value[0].id);
}
async function choose(id: number) {
  selected.value = await api(`/skills/${id}`);
  revisions.value = (await api<{ items: any[] }>(`/skills/${id}/revisions`)).items;
  session.value = await api(`/skills/${id}/authoring-session/latest`);
  messages.value = session.value?.messages ?? [];
  dirty.value = false;
}
async function create() {
  const name = window.prompt('给这个 Skill 起个名字');
  if (!name?.trim()) return;
  try { const item = await post('/skills', { name, description: '' }); await load(); await choose(item.id); }
  catch (e: any) { error.value = e.message; }
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
    <header class="skill-header"><div><p class="eyebrow">企业能力中心</p><h1>Skills</h1><p>沉淀可复用的工作方法。助手只修改草稿，发布由你确认。</p></div><button class="primary" @click="create">新建 Skill</button></header>
    <p v-if="error" class="error-banner">{{ error }}</p>
    <section v-if="!skills.length" class="empty-card"><div class="empty-icon">✦</div><h2>还没有 Skill</h2><p>创建一个工作方法，之后可手动编辑或与助手一起完善。</p><button class="primary" @click="create">创建第一个 Skill</button></section>
    <div v-else class="skill-layout">
      <aside class="skill-list"><button v-for="item in skills" :key="item.id" :class="['skill-item', { active: selected?.id === item.id }]" @click="choose(item.id)"><strong>{{ item.name }}</strong><small>{{ item.status === 'published' ? `已发布 · v${item.publishedVersion}` : '草稿' }}</small></button></aside>
      <section v-if="selected" class="skill-workspace">
        <div class="skill-title"><div><h2>{{ selected.name }}</h2><p>{{ selected.description || '尚未添加说明' }} · 修订 r{{ selected.revision }}</p></div><div class="skill-actions"><button @click="save">保存草稿</button><button class="primary" :disabled="!canPublish" @click="publish">发布版本</button></div></div>
        <div class="skill-columns"><article class="editor-panel"><div class="panel-heading"><h3>草稿内容</h3><label class="upload-button">添加参考资料<input type="file" accept=".md,.txt,text/plain,text/markdown" @change="uploadReference" /></label></div><textarea v-model="selected.content" spellcheck="false" @input="dirty = true"/><div class="hint">编辑内容会形成新的草稿修订；已发布版本不会被覆盖。</div><div v-if="selected.referenceFiles?.length" class="reference-files"><b>参考资料</b><span v-for="ref in selected.referenceFiles" :key="ref.path">{{ ref.filename }} · {{ Math.ceil(ref.bytes / 1024) }} KB</span></div>
          <div class="revision-panel"><h3>修订历史</h3><button v-for="rev in revisions" :key="rev.id" class="revision-row" @click="restore(rev)"><span><b>r{{ rev.revision }}{{ rev.publishedVersion ? ` · 已发布 v${rev.publishedVersion}` : '' }}</b><small>{{ rev.changeSummary }}</small></span><small>恢复为草稿</small></button></div>
        </article><aside class="assistant-panel"><div class="panel-heading"><div><h3>Skill 助手</h3><small>只处理当前草稿，不会自动发布</small></div><button v-if="session" class="quiet" @click="startSession">新会话</button></div><div class="chat-log"><div v-if="!messages.length" class="chat-empty">描述希望这个 Skill 如何工作，助手会协助修改当前草稿。</div><div v-for="m in messages" :key="m.id" :class="['chat-message', m.role]"><b>{{ m.role === 'user' ? '你' : m.role === 'assistant' ? '助手' : '记录' }}</b><p>{{ m.content }}</p></div><div v-if="busy" class="chat-message assistant"><b>助手</b><p>{{ streamingText || '正在处理…' }}</p></div></div><form class="chat-input" @submit.prevent="send"><textarea v-model="prompt" placeholder="例如：增加输入检查步骤，并让输出更适合发给客户" :disabled="busy"/><button class="primary" :disabled="busy || !prompt.trim()">发送</button></form></aside></div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.skill-center{max-width:1500px;margin:auto;padding:32px;color:var(--text-primary,#17243a)}.skill-header,.skill-title,.skill-actions,.panel-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.skill-header{margin-bottom:24px}.skill-header h1{margin:4px 0;font-size:30px}.skill-header p,.skill-title p{color:#68758a;margin:4px 0}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#63738b}.primary{background:#2459d3!important;color:white!important;border-color:#2459d3!important}.skill-layout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:20px}.skill-list,.editor-panel,.assistant-panel,.empty-card{border:1px solid #e2e8f0;border-radius:14px;background:white}.skill-list{padding:8px;height:max-content}.skill-item{width:100%;text-align:left;border:0;background:transparent;padding:13px;border-radius:9px;display:grid;gap:5px}.skill-item.active{background:#f0f5ff;color:#214da9}.skill-item small,.revision-row small{color:#758197}.skill-workspace{min-width:0}.skill-title{padding:8px 2px 18px}.skill-title h2{margin:0}.skill-actions button,.skill-header button,.chat-input button{padding:9px 14px;border-radius:8px;border:1px solid #d5ddea;background:white}.skill-columns{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(340px,.8fr);gap:16px}.editor-panel,.assistant-panel{padding:18px;min-width:0}.panel-heading{margin-bottom:12px}.panel-heading h3,.revision-panel h3{margin:0}.panel-heading span{font-size:12px;color:#78859a}.upload-button{font-size:12px;color:#315db5;cursor:pointer}.upload-button input{position:absolute;width:1px;height:1px;opacity:0}.reference-files{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;font-size:12px;color:#66748b}.reference-files span{padding:4px 8px;background:#f2f5fa;border-radius:12px}.editor-panel>textarea{width:100%;height:440px;resize:vertical;border:1px solid #dce3ee;border-radius:9px;padding:14px;font:13px/1.65 ui-monospace,monospace;color:#243149}.hint{font-size:12px;color:#78859a;margin-top:8px}.revision-panel{border-top:1px solid #edf0f5;margin-top:22px;padding-top:16px}.revision-row{width:100%;padding:10px 0;border:0;border-bottom:1px solid #f0f2f6;background:white;text-align:left;display:flex;justify-content:space-between;gap:10px}.revision-row span{display:grid;gap:4px}.revision-row small{font-size:12px}.chat-log{height:444px;overflow:auto;background:#f8faff;border-radius:10px;padding:12px}.chat-empty{padding:28px 12px;color:#79859a;font-size:14px;text-align:center}.chat-message{margin:8px 0;padding:10px 12px;border-radius:10px;background:white;font-size:14px}.chat-message.user{background:#eaf1ff}.chat-message p{margin:6px 0 0;white-space:pre-wrap;line-height:1.5}.chat-message b{font-size:12px;color:#68758a}.chat-input{display:flex;gap:8px;margin-top:12px;align-items:flex-end}.chat-input textarea{flex:1;min-height:70px;resize:vertical;border:1px solid #dce3ee;border-radius:9px;padding:10px}.quiet{border:0;background:transparent;color:#315db5}.empty-card{text-align:center;padding:65px 24px}.empty-icon{font-size:28px;color:#315db5}.error-banner{padding:12px;border-radius:8px;background:#fff1f0;color:#ad3027}@media(max-width:900px){.skill-center{padding:16px}.skill-layout,.skill-columns{grid-template-columns:1fr}.skill-list{display:flex;overflow:auto}.skill-item{min-width:160px}.chat-log{height:300px}}
</style>
