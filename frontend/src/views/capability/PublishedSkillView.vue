<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api, downloadResponse } from '../../api/client';
import Icon from '../../components/base/ForgeIcon.vue';
import Markdown from '../../components/markdown/MarkdownContent.vue';
import { usePlatform } from '../../stores/platform';
import type { PublishedSkillDetail } from '../../types/skill';
import { formatBytes } from '../../utils/common/format';

const route = useRoute();
const app = usePlatform();
const skill = ref<PublishedSkillDetail | null>(null);
const loading = ref(true);
const error = ref('');
const downloading = ref(false);
const sourceOpen = ref(false);
const selectedReference = ref<string | null>(null);
const referenceContent = ref('');
const referenceLoading = ref(false);
const referenceError = ref('');
let loadRequest = 0;
let referenceRequest = 0;

const documentBody = computed(() =>
  (skill.value?.content ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim(),
);

function formatDate(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

async function load() {
  const request = ++loadRequest;
  const id = Number(route.params.id);
  skill.value = null;
  selectedReference.value = null;
  referenceRequest++;
  loading.value = true;
  error.value = '';
  if (!Number.isInteger(id) || id < 1) {
    error.value = '技能地址无效';
    loading.value = false;
    return;
  }
  try {
    const result = await api<PublishedSkillDetail>(`/skills/${id}/published`);
    if (request === loadRequest) skill.value = result;
  } catch (reason) {
    if (request === loadRequest) error.value = (reason as Error).message;
  } finally {
    if (request === loadRequest) loading.value = false;
  }
}

async function selectReference(path: string) {
  if (!skill.value) return;
  if (selectedReference.value === path) {
    selectedReference.value = null;
    return;
  }
  selectedReference.value = path;
  referenceContent.value = '';
  referenceError.value = '';
  referenceLoading.value = true;
  const request = ++referenceRequest;
  try {
    const result = await api<{ content: string }>(
      `/skills/${skill.value.id}/published/files?path=${encodeURIComponent(path)}`,
    );
    if (request === referenceRequest) referenceContent.value = result.content;
  } catch (reason) {
    if (request === referenceRequest) referenceError.value = (reason as Error).message;
  } finally {
    if (request === referenceRequest) referenceLoading.value = false;
  }
}

async function download() {
  if (!skill.value || downloading.value) return;
  downloading.value = true;
  try {
    await downloadResponse(
      `/skills/${skill.value.id}/download?version=published`,
      `${skill.value.machineName || `skill-${skill.value.id}`}.zip`,
    );
  } catch (reason) {
    app.toast((reason as Error).message, 'error');
  } finally {
    downloading.value = false;
  }
}

watch(
  () => route.params.id,
  () => void load(),
  { immediate: true },
);
</script>

<template>
  <main class="page-content enterprise-page published-skill-page">
    <div class="published-skill-inner">
      <RouterLink class="published-back" to="/agent/capabilities?tab=skills">
        <Icon name="ri-arrow-go-back-fill" :size="16" />技能管理
      </RouterLink>

      <div v-if="loading" class="loading-inline" role="status">
        <a-spin size="small" />正在读取已发布技能…
      </div>
      <div v-else-if="error" class="published-error">
        <a-alert type="error" show-icon message="技能未能读取" :description="error" />
        <a-button @click="load">重试</a-button>
      </div>
      <template v-else-if="skill">
        <header class="published-skill-header">
          <div class="published-skill-heading">
            <span class="published-version">已发布 v{{ skill.version }}</span>
            <h1>{{ skill.name }}</h1>
            <p class="published-machine">{{ skill.machineName }}</p>
            <p v-if="skill.description" class="published-description">{{ skill.description }}</p>
            <small v-if="skill.publishedAt" class="published-date">
              {{ formatDate(skill.publishedAt) }} 发布
            </small>
          </div>
          <div class="published-skill-actions">
            <a-button :loading="downloading" @click="download">
              <template #icon><Icon name="download" :size="15" /></template>下载 ZIP
            </a-button>
            <RouterLink v-slot="{ href, navigate }" :to="`/agent/skills/${skill.id}`" custom>
              <a-button :href="href" @click="navigate">编辑草稿</a-button>
            </RouterLink>
          </div>
        </header>

        <section class="published-document" aria-label="已发布技能内容">
          <div class="published-section-heading">
            <strong>SKILL.md</strong>
            <a-button type="text" size="small" @click="sourceOpen = !sourceOpen">
              {{ sourceOpen ? '阅读' : '查看源码' }}
            </a-button>
          </div>
          <pre v-if="sourceOpen" class="published-source"><code>{{ skill.content }}</code></pre>
          <Markdown v-else :text="documentBody" variant="document" />
        </section>

        <section v-if="skill.files.length" class="published-references">
          <div class="published-section-heading">
            <strong>附加文件</strong>
            <span>{{ skill.files.length }} 个文件</span>
          </div>
          <div class="published-reference-list">
            <div v-for="file in skill.files" :key="file.path">
              <button
                type="button"
                class="published-reference-button"
                :aria-expanded="selectedReference === file.path"
                @click="selectReference(file.path)"
              >
                <span><Icon name="file" :size="15" />{{ file.path }}</span>
                <small>{{ formatBytes(file.bytes) }}</small>
              </button>
              <div v-if="selectedReference === file.path" class="published-reference-body">
                <a-spin v-if="referenceLoading" size="small" />
                <a-alert v-else-if="referenceError" type="error" :message="referenceError" show-icon />
                <Markdown v-else-if="/\.md$/i.test(file.path)" :text="referenceContent" variant="document" />
                <pre v-else>{{ referenceContent }}</pre>
              </div>
            </div>
          </div>
        </section>
      </template>
    </div>
  </main>
</template>

<style scoped>
.published-skill-page {
  overflow: auto;
}
.published-skill-inner {
  width: min(100%, 1040px);
  margin: 0 auto;
  padding-bottom: 72px;
}
.published-back {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 32px;
  color: var(--color-text-secondary);
  font-size: 13px;
}
.published-back:hover {
  color: var(--color-brand-active);
}
.published-error {
  display: grid;
  gap: 16px;
}
.published-error > button {
  justify-self: start;
}
.published-skill-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 32px;
  margin-bottom: 36px;
}
.published-skill-heading {
  min-width: 0;
}
.published-version {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 5px;
  background: var(--color-success-bg);
  color: var(--color-success-text);
  font-size: 12px;
}
.published-skill-heading h1 {
  margin: 14px 0 4px;
  font-size: 28px;
  line-height: 1.35;
}
.published-machine {
  color: var(--color-text-tertiary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 13px;
}
.published-description {
  margin-top: 18px;
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.published-date {
  display: block;
  margin-top: 10px;
  color: var(--color-text-tertiary);
  font-size: 12px;
}
.published-skill-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.published-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.published-section-heading strong {
  font-size: 15px;
  font-weight: 600;
}
.published-section-heading > span {
  color: var(--color-text-tertiary);
  font-size: 12px;
}
.published-document {
  max-width: 900px;
}
.published-source,
.published-reference-body pre {
  margin: 0;
  padding: 20px 24px;
  overflow: auto;
  border-radius: 8px;
  background: var(--surface-shell);
  color: var(--color-text-primary);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.published-references {
  max-width: 900px;
  margin-top: 48px;
}
.published-reference-list {
  display: grid;
  gap: 8px;
}
.published-reference-button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border-radius: 7px;
  background: var(--surface-shell);
  text-align: left;
  font-size: 13px;
}
.published-reference-button:hover,
.published-reference-button[aria-expanded='true'] {
  background: var(--surface-hover);
}
.published-reference-button > span {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.published-reference-button small {
  color: var(--color-text-tertiary);
  white-space: nowrap;
}
.published-reference-body {
  padding: 20px 14px 24px;
}
.published-reference-body pre {
  padding: 14px;
}
@media (max-width: 700px) {
  .published-skill-inner {
    padding-bottom: 48px;
  }
  .published-skill-header {
    flex-direction: column;
    gap: 20px;
  }
  .published-skill-heading h1 {
    font-size: 23px;
  }
  .published-skill-actions {
    flex-wrap: wrap;
  }
}
</style>
