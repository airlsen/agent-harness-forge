<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { MAX_CODE_PROJECTS, useConversation } from '../stores/conversation';
import { usePlatform } from '../stores/platform';
import type { CodeProject } from '../types/platform';
import Icon from './ForgeIcon.vue';

/**
 * 聊天输入框的「关联代码」：从代码根目录下的项目中多选，模型只读搜索与分析。
 * 与场景、能力无关；新会话随第一条消息提交，已有会话确定后立即保存、从下一轮起生效。
 */
const emit = defineEmits<{ opened: []; changed: [] }>();
const app = usePlatform();
const chat = useConversation();
const open = ref(false);
const loading = ref(false);
const loadError = ref('');
const query = ref('');
const picked = ref<string[]>([]);
const root = ref<HTMLElement | null>(null);
const search = ref<HTMLInputElement | null>(null);

const count = computed(() => chat.codeProjects.length);
const label = computed(() => (count.value ? `代码 · ${count.value}` : '关联代码'));
const title = computed(() =>
  count.value
    ? `已关联（只读）：${chat.codeProjects.join('、')}`
    : '关联代码项目：模型可只读搜索与分析，可多选',
);
const list = computed(() => chat.codeProjectList);
/** 已选但代码根目录中已不存在的项目：单独列出，便于取消 */
const missing = computed(() =>
  list.value ? picked.value.filter((name) => !list.value?.projects.some((p) => p.name === name)) : [],
);
const visible = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  const projects = list.value?.projects ?? [];
  return keyword ? projects.filter((project) => project.name.toLowerCase().includes(keyword)) : projects;
});
const dirty = computed(
  () =>
    picked.value.length !== chat.codeProjects.length ||
    picked.value.some((name, index) => name !== chat.codeProjects[index]),
);

function version(project: CodeProject) {
  if (project.branch && project.commit) return `${project.branch} @ ${project.commit.slice(0, 7)}`;
  if (project.branch) return project.branch;
  if (project.commit) return `@ ${project.commit.slice(0, 7)}`;
  return '非 Git 目录';
}
async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    await chat.loadCodeProjects();
  } catch (error) {
    loadError.value = (error as Error).message || '未能读取代码项目';
  } finally {
    loading.value = false;
  }
}
function toggle() {
  // 提交中的第一条消息已带上草稿里的选择，等受理后再修改
  if (chat.loading || chat.sending) return;
  if (open.value) {
    open.value = false;
    return;
  }
  picked.value = [...chat.codeProjects];
  query.value = '';
  open.value = true;
  emit('opened');
  void load().then(() => nextTick(() => search.value?.focus()));
}
function flip(name: string) {
  const index = picked.value.indexOf(name);
  if (index >= 0) picked.value.splice(index, 1);
  else if (picked.value.length >= MAX_CODE_PROJECTS)
    app.toast(`一个会话最多关联 ${MAX_CODE_PROJECTS} 个代码项目`, 'info');
  else picked.value.push(name);
}
async function apply(names = picked.value) {
  const inSession = Boolean(chat.current);
  const running = chat.running;
  try {
    await chat.setCodeProjects(names);
    open.value = false;
    emit('changed');
    if (inSession)
      app.toast(running ? '关联代码已保存，将从下一轮起生效' : '关联代码已保存，下一条消息起生效', 'info');
  } catch (error) {
    app.toast((error as Error).message || '关联代码保存失败', 'error');
  }
}
/** 输入框上方标签的移除按钮 */
async function remove(name: string) {
  await apply(chat.codeProjects.filter((item) => item !== name));
}
function outside(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
defineExpose({ close: () => (open.value = false), remove });
</script>

<template>
  <div ref="root" class="code-picker-wrap">
    <button
      type="button"
      :class="['model-trigger', 'code-trigger', { 'is-active': count }]"
      :disabled="chat.loading || chat.codeSaving || chat.sending"
      :aria-expanded="open"
      aria-label="关联代码"
      aria-controls="code-options"
      :title="title"
      @click="toggle"
      @keydown.esc.stop="open = false"
    >
      <span v-if="chat.codeSaving" class="loader small"></span><Icon v-else name="code" :size="15" />
      <span>{{ label }}</span>
    </button>
    <div
      v-if="open"
      id="code-options"
      class="scenario-popover code-popover"
      role="dialog"
      aria-label="选择关联的代码项目"
      @keydown.esc.stop="open = false"
    >
      <div class="code-popover-head">
        <div class="popover-label">
          关联代码 · 只读<span v-if="list?.root" :title="list.root">{{ list.root }}</span>
        </div>
        <label v-if="(list?.projects.length ?? 0) > 6" class="code-search">
          <Icon name="search" :size="13" />
          <input
            ref="search"
            v-model="query"
            type="search"
            placeholder="搜索项目"
            aria-label="搜索代码项目"
          />
        </label>
      </div>
      <div class="code-options" role="group" aria-label="代码项目">
        <div v-if="loading && !list" class="code-empty"><span class="loader small"></span>正在读取项目…</div>
        <div v-else-if="loadError" class="code-empty is-error">
          {{ loadError }}<button type="button" @click="load">重试</button>
        </div>
        <div v-else-if="list && !list.available" class="code-empty">
          代码根目录 {{ list.root }} 不存在或不可读，请检查环境变量 FORGE_CODE_ROOT。
        </div>
        <div v-else-if="list && !list.projects.length && !missing.length" class="code-empty">
          {{ list.root }} 下还没有项目目录。
        </div>
        <template v-else>
          <label v-for="name in missing" :key="`missing-${name}`" class="code-option is-missing">
            <input type="checkbox" checked @change="flip(name)" />
            <span
              ><strong>{{ name }}</strong
              ><small>已不在代码根目录中，取消勾选后保存</small></span
            >
          </label>
          <label
            v-for="project in visible"
            :key="project.name"
            :class="['code-option', { selected: picked.includes(project.name) }]"
            :title="project.path"
          >
            <input type="checkbox" :checked="picked.includes(project.name)" @change="flip(project.name)" />
            <span
              ><strong>{{ project.name }}</strong
              ><small>{{ version(project) }}</small></span
            >
          </label>
          <div v-if="!visible.length && query" class="code-empty">没有匹配「{{ query }}」的项目</div>
        </template>
      </div>
      <div class="code-popover-foot">
        <span>已选 {{ picked.length }} / {{ MAX_CODE_PROJECTS }}</span>
        <button type="button" class="button secondary" @click="open = false">取消</button>
        <button type="button" class="button primary" :disabled="!dirty || chat.codeSaving" @click="apply()">
          确定
        </button>
      </div>
    </div>
  </div>
</template>
