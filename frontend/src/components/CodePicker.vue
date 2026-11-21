<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { MAX_CODE_PROJECTS, useConversation } from '../stores/conversation';
import { usePlatform } from '../stores/platform';
import type { CodeProject } from '../types/platform';
import Icon from './ForgeIcon.vue';

/**
 * 聊天输入框的「关联代码」：从代码根目录下的项目中多选，模型只读搜索与分析。
 * 点选即改输入框中的选择，不单独保存：随下一条消息一起提交，从该轮起生效。
 */
const emit = defineEmits<{ opened: [] }>();
const app = usePlatform();
const chat = useConversation();
const open = ref(false);
const loading = ref(false);
const loadError = ref('');
const query = ref('');
const search = ref<{ focus: () => void } | null>(null);

const selected = computed(() => chat.codeProjects);
const label = computed(() => {
  const [first, ...rest] = selected.value;
  if (!first) return '关联代码';
  return rest.length ? `${first} +${rest.length}` : first;
});
const title = computed(() =>
  selected.value.length
    ? `关联代码（只读）：${selected.value.join('、')}${chat.codePending ? ' · 随下一条消息生效' : ''}`
    : chat.codePending
      ? '已取消关联代码 · 随下一条消息生效'
      : '关联代码项目：模型可只读搜索与分析，可多选',
);
const list = computed(() => chat.codeProjectList);
const projects = computed(() => list.value?.projects ?? []);
/** 已选但代码目录中已不存在的项目：单独列出，点击即可移除 */
const missing = computed(() =>
  list.value ? selected.value.filter((name) => !projects.value.some((p) => p.name === name)) : [],
);
const visible = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return keyword
    ? projects.value.filter((project) => project.name.toLowerCase().includes(keyword))
    : projects.value;
});
const hint = computed(() =>
  chat.codePending ? '随下一条消息生效' : selected.value.length ? `已选 ${selected.value.length}` : '可多选',
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
function toggle(visible: boolean) {
  // 提交中的消息已带上当前选择，等受理后再修改
  if (chat.loading || chat.sending) return;
  if (!visible) {
    open.value = false;
    return;
  }
  query.value = '';
  open.value = true;
  emit('opened');
  void load().then(() => nextTick(() => search.value?.focus()));
}
function flip(name: string) {
  const current = selected.value;
  if (current.includes(name)) chat.setCodeProjects(current.filter((item) => item !== name));
  else if (current.length >= MAX_CODE_PROJECTS)
    app.toast(`一个会话最多关联 ${MAX_CODE_PROJECTS} 个代码项目`, 'info');
  else chat.setCodeProjects([...current, name]);
}
defineExpose({ close: () => (open.value = false) });
</script>

<template>
  <div class="code-picker-wrap">
    <a-popover
      :open="open"
      trigger="click"
      :placement="'bottomLeft'"
      overlay-class-name="task-picker-overlay"
      @open-change="toggle"
    >
      <button
        type="button"
        :class="['model-trigger', 'picker-trigger', { 'is-active': selected.length }]"
        :disabled="chat.loading || chat.sending"
        :aria-expanded="open"
        aria-label="关联代码"
        aria-controls="code-options"
        :title="title"
        @keydown.esc.stop="open = false"
      >
        <Icon name="code" :size="15" />
        <span class="picker-trigger-label">{{ label }}</span>
        <i v-if="chat.codePending" class="picker-dot" aria-label="有未发送的修改"></i>
      </button>
      <template #content>
        <div
          id="code-options"
          class="scenario-popover picker-popover"
          role="dialog"
          aria-label="选择关联的代码项目"
          @keydown.esc.stop="open = false"
        >
          <div class="picker-head">
            <span>关联代码 · 只读</span><small :class="{ 'is-pending': chat.codePending }">{{ hint }}</small>
          </div>
          <div v-if="projects.length > 6" class="picker-search">
            <Icon name="search" :size="13" />
            <a-input ref="search" v-model:value="query" placeholder="搜索项目" aria-label="搜索代码项目" />
          </div>
          <div class="picker-list" role="group" aria-label="代码项目">
            <div v-if="loading && !list" class="picker-empty">
              <span class="loader small"></span>正在读取项目…
            </div>
            <div v-else-if="loadError && !list" class="picker-empty is-error">
              {{ loadError }}<button type="button" @click="load">重试</button>
            </div>
            <template v-else-if="list">
              <button
                v-for="name in missing"
                :key="`missing-${name}`"
                type="button"
                :aria-label="`移除失效的代码项目 ${name}`"
                class="picker-row is-missing selected"
                @click="flip(name)"
              >
                <span class="picker-row-main"
                  ><b>{{ name }}</b
                  ><small>已不存在，点击移除</small></span
                ><Icon name="close" :size="14" />
              </button>
              <a-checkbox
                v-for="project in visible"
                :key="project.name"
                :checked="selected.includes(project.name)"
                :class="['picker-row', { selected: selected.includes(project.name) }]"
                @change="flip(project.name)"
              >
                <span class="picker-row-main"
                  ><b>{{ project.name }}</b
                  ><small>{{ version(project) }}</small></span
                >
              </a-checkbox>
              <div v-if="!list.available || (!projects.length && !missing.length)" class="picker-empty">
                暂无可关联的代码项目，请联系管理员配置代码目录。
              </div>
              <div v-else-if="!visible.length && query" class="picker-empty">
                没有匹配「{{ query }}」的项目
              </div>
            </template>
          </div>
        </div>
      </template>
    </a-popover>
  </div>
</template>
